/**
 * commands-only invariant (INV #9 / §4.2) — owned by impl-runtime.
 *
 * When the model emits plain assistant text that is neither a tool_use nor
 * thinking, the runtime must REJECT it and write a feedback block for the next
 * turn (so the agent self-corrects). And per INV #13 (§4.3), text inside thinking
 * is NEVER parsed as a command — a `<thinking>chat.reply(...)</thinking>` style
 * payload must not execute anything.
 */

import { describe, expect, it } from 'vitest';

import { PolicyEngine } from '../src/core/policy.js';
import { MockProvider } from '../src/provider/mock.js';
import {
  AgentRuntime,
  COMMANDS_ONLY_FEEDBACK_BLOCK,
  COMMANDS_ONLY_FEEDBACK_TEXT,
} from '../src/runtime/agent_runtime.js';
import {
  TestBuilderRegistry,
  TestCommandRegistry,
  TestOperations,
  TestRenderer,
  makeEmptyTree,
  makeReplyApp,
  makeEndTurnApp,
} from './fixtures.js';

const WAKE = { kind: 'sync_message_arrived', msg_id: 'm1' } as const;

function wire(provider: MockProvider) {
  const tree = makeEmptyTree();
  const registry = new TestCommandRegistry();
  makeReplyApp(registry);
  const policy = new PolicyEngine({ capability_resolver: registry.capabilityResolver() });
  const ops = new TestOperations(tree, policy, registry);
  const renderer = new TestRenderer(new TestBuilderRegistry());
  const runtime = new AgentRuntime({
    operations: ops,
    renderer,
    provider,
  });
  return { tree, ops, runtime };
}

describe('commands-only', () => {
  it('rejects plain text and writes the feedback block', async () => {
    // Turn 1: the model returns ONLY plain text (a commands-only violation).
    // Turn 2: it returns nothing, so the loop ends after writing feedback.
    const provider = new MockProvider([
      { text: '你好，我直接聊天而不是用命令。' },
      {},
    ]);
    const { tree, runtime } = wire(provider);

    await runtime.on_wake(WAKE);

    // The feedback block must exist in the tree, carrying the exact §4.2 text.
    const fb = tree.get(COMMANDS_ONLY_FEEDBACK_BLOCK);
    expect(fb).not.toBeNull();
    expect(fb?.content_text).toBe(COMMANDS_ONLY_FEEDBACK_TEXT);

    // And the runtime is back to idle (it parked nowhere).
    expect(runtime.state.kind).toBe('idle');
  });

  it('emits thinking on the UI channel and NEVER treats it as a command (INV #13)', async () => {
    // The thinking payload literally spells a command. It must be EMITTED on the
    // UI thinking channel as OPAQUE text and never routed through invoke_command —
    // and never written to the tree (thinking-channel decision).
    const provider = new MockProvider([
      { thinking: ['reply.say({"text":"PWNED"})'] },
      {},
    ]);
    const { tree, ops, runtime } = wire(provider);

    const seen: Array<{ text: string; spawn_depth: number }> = [];
    runtime.onThinking((e) => seen.push({ text: e.text, spawn_depth: e.spawn_depth }));

    await runtime.on_wake(WAKE);

    // The thinking text reached the UI channel verbatim, tagged with the agent depth...
    expect(seen).toEqual([{ text: 'reply.say({"text":"PWNED"})', spawn_depth: 0 }]);
    // ...but reply.say NEVER executed, so reply:last was never created...
    expect(tree.get('reply:last')).toBeNull();
    // ...no command was routed at all...
    expect(ops.decisions.filter((d) => d.full_name === 'reply.say')).toHaveLength(0);
    // ...and thinking is NOT written to the tree (no runtime:thoughts_sink block).
    expect(tree.get('runtime:thoughts_sink')).toBeNull();
  });

  it('drops thinking harmlessly when no UI subscriber is registered', async () => {
    // No onThinking subscriber. The thinking text must not be parsed, not written
    // to the tree, and must not throw — the loop just ends after the empty turn.
    const provider = new MockProvider([{ thinking: ['some private reasoning'] }, {}]);
    const { tree, runtime } = wire(provider);

    await runtime.on_wake(WAKE);

    expect(tree.get('reply:last')).toBeNull();
    expect(tree.get('runtime:thoughts_sink')).toBeNull();
    expect(runtime.state.kind).toBe('idle');
  });

  it('accepts a tool_use command (the happy path)', async () => {
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] },
      {},
    ]);
    const { tree, ops, runtime } = wire(provider);

    await runtime.on_wake(WAKE);

    const reply = tree.get('reply:last');
    expect(reply?.content_text).toBe('hi');
    expect(ops.decisions).toContainEqual({ full_name: 'reply.say', kind: 'allow' });
    // No feedback block, because the output WAS a command.
    expect(tree.get(COMMANDS_ONLY_FEEDBACK_BLOCK)).toBeNull();
  });

  it('idle burns no tokens — no LLM call without processing an event', async () => {
    // We never call on_wake, so send() is never invoked.
    const provider = new MockProvider([{ text: 'unused' }]);
    wire(provider);
    expect(provider.turns_consumed).toBe(0);
  });
});

describe('tool catalog advertisement (§4.2 / §11.1 native tool dispatch)', () => {
  it('forwards the tool_catalog to provider.send as SendOpts.tools each turn', async () => {
    // Without this seam a native-tool-dispatch model is never told which commands
    // exist, so it can only emit plain text → commands-only rejection → it can never
    // act. The mock ignores tools (it is scripted), so we assert on what was SENT.
    const catalog = [
      { name: 'reply.say', description: 'Reply to the user', args_schema: { type: 'object' } },
    ];
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] },
      {},
    ]);
    const tree = makeEmptyTree();
    const registry = new TestCommandRegistry();
    makeReplyApp(registry);
    const policy = new PolicyEngine({ capability_resolver: registry.capabilityResolver() });
    const ops = new TestOperations(tree, policy, registry);
    const renderer = new TestRenderer(new TestBuilderRegistry());
    const runtime = new AgentRuntime({
      operations: ops,
      renderer,
      provider,
      tool_catalog: () => catalog,
    });

    await runtime.on_wake(WAKE);

    expect(provider.last_opts?.tools).toEqual(catalog);
  });

  it('omits tools entirely when no catalog is wired (unchanged scripted behavior)', async () => {
    const provider = new MockProvider([{}]);
    const { runtime } = wire(provider);

    await runtime.on_wake(WAKE);

    // The key is absent (not an empty array), so the request is byte-identical to the
    // pre-catalog behavior for providers that don't need advertised tools.
    expect(provider.last_opts).not.toBeNull();
    expect(provider.last_opts?.tools).toBeUndefined();
  });
});

describe('error channel (a failed turn surfaces instead of silent no-op)', () => {
  // An empty script makes MockProvider.send() throw — standing in for a real
  // provider/transport failure (endpoint 4xx/5xx, network drop). The runtime must
  // surface it on onError and return to idle, never crash or wedge in 'running'.
  it('emits onError(phase=send) when the provider call fails and returns to idle', async () => {
    const provider = new MockProvider([]);
    const { runtime } = wire(provider);
    const errs: Array<{ message: string; phase: string }> = [];
    runtime.onError((e) => errs.push({ message: e.message, phase: e.phase }));

    await runtime.on_wake(WAKE); // must not throw

    expect(errs).toHaveLength(1);
    expect(errs[0]?.phase).toBe('send');
    expect(errs[0]?.message).toContain('script exhausted');
    expect(runtime.state.kind).toBe('idle');
  });

  it('does not throw out of on_wake even with no error subscriber', async () => {
    const provider = new MockProvider([]);
    const { runtime } = wire(provider);

    await expect(runtime.on_wake(WAKE)).resolves.toBeUndefined();
    expect(runtime.state.kind).toBe('idle');
  });
});

describe('end_turn (a reply-style command ends the turn, §8.1)', () => {
  it('stops the turn loop after a command returns end_turn — does NOT run another turn', async () => {
    // Two turns are scripted; if end_turn did NOT stop the loop, the second would run
    // (the agent re-replying — the over-reply bug). With end_turn the loop ends after one.
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'done.reply', args: {} }] },
      { tool_calls: [{ id: 't2', name: 'done.reply', args: {} }] },
    ]);
    const tree = makeEmptyTree();
    const registry = new TestCommandRegistry();
    makeEndTurnApp(registry);
    const policy = new PolicyEngine({ capability_resolver: registry.capabilityResolver() });
    const ops = new TestOperations(tree, policy, registry);
    const runtime = new AgentRuntime({
      operations: ops,
      renderer: new TestRenderer(new TestBuilderRegistry()),
      provider,
    });

    await runtime.on_wake(WAKE);

    expect(provider.turns_consumed).toBe(1); // the scripted 2nd turn never ran
    expect(runtime.state.kind).toBe('idle');
  });

  it('keeps looping for a non-end_turn command (multi-step tool use unaffected)', async () => {
    // reply.say does NOT set end_turn → the loop runs a second turn (then ends on empty).
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] },
      {},
    ]);
    const { runtime } = wire(provider);

    await runtime.on_wake(WAKE);

    expect(provider.turns_consumed).toBe(2); // looped to the 2nd (empty) turn, unlike end_turn
    expect(runtime.state.kind).toBe('idle');
  });
});
