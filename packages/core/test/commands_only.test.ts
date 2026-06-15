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
import type { CommandEvent } from '../src/core/types.js';
import {
  TestBuilderRegistry,
  TestCommandRegistry,
  TestOperations,
  TestRenderer,
  makeEmptyTree,
  makeReplyApp,
  makeEndTurnApp,
} from './fixtures.js';

// WakeEvent is base-ified (A5): a message wake is an app_event with source/reason/ref.
const WAKE = {
  kind: 'app_event',
  source: 'messages',
  reason: 'message_arrived',
  ref: 'm1',
} as const;

function wire(provider: MockProvider) {
  const tree = makeEmptyTree();
  const registry = new TestCommandRegistry();
  makeReplyApp(registry);
  const policy = new PolicyEngine({ capability_resolver: registry.capabilityResolver() });
  const ops = new TestOperations(tree, policy, registry);
  // The builder registry the renderer reads is ALSO the runtime's `registry` handle,
  // so the runtime's bookkeeping system builders (B1) register into the same instance
  // the renderer resolves against. The runtime registers them in its constructor.
  const builders = new TestBuilderRegistry();
  const renderer = new TestRenderer(builders);
  const runtime = new AgentRuntime({
    operations: ops,
    renderer,
    provider,
    registry: builders,
  });
  return { tree, ops, runtime, builders, renderer };
}

/**
 * Seed the runtime's bookkeeping projection-block placeholders into the tree, then
 * render — exactly the boot order (registerSystemBuilder happened in the runtime
 * ctor; seed reads the registry; the builder projects state). Seeds under the actual
 * tree root via `runtime.root` (CM-4) so the placeholders are not orphaned. Returns
 * the flattened rendered text so a test can assert what the agent would see.
 */
async function seedAndRenderText(
  ops: TestOperations,
  runtime: AgentRuntime,
  builders: TestBuilderRegistry,
  renderer: TestRenderer,
): Promise<string> {
  for (const builder of builders.list_builders()) {
    for (const name of builder.outputs) {
      if (ops.has(name)) continue;
      await ops.apply(
        [
          {
            kind: 'create',
            parent: runtime.root,
            block: { id: `seed-${name}`, name, children: [], content_text: null, content_blob: null },
          },
        ],
        { invoker: 'app', trust: 'trusted' },
      );
    }
  }
  const prompt = await renderer.render(ops.snapshot());
  return prompt.segments.map((s) => (typeof s.rendered === 'string' ? s.rendered : '')).join('\n');
}

describe('commands-only', () => {
  it('rejects plain text and writes the feedback block', async () => {
    // Turn 1: the model returns ONLY plain text (a commands-only violation).
    // Turn 2: it returns nothing, so the loop ends after writing feedback.
    const provider = new MockProvider([
      { text: '你好，我直接聊天而不是用命令。' },
      {},
    ]);
    const { ops, runtime, builders, renderer } = wire(provider);

    await runtime.on_wake(WAKE);

    // B1: the runtime no longer writes the feedback block to the tree — it sets state
    // that its system builder PROJECTS. Seed the placeholders + render: the feedback
    // text must appear in the rendered prompt (what the agent sees next turn), under
    // the runtime:commands_only_feedback block.
    const text = await seedAndRenderText(ops, runtime, builders, renderer);
    expect(text).toContain(COMMANDS_ONLY_FEEDBACK_BLOCK);
    expect(text).toContain(COMMANDS_ONLY_FEEDBACK_TEXT);

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
    const { tree, ops, runtime, builders, renderer } = wire(provider);

    await runtime.on_wake(WAKE);

    const reply = tree.get('reply:last');
    expect(reply?.content_text).toBe('hi');
    expect(ops.decisions).toContainEqual({ full_name: 'reply.say', kind: 'allow' });
    // No feedback, because the output WAS a command: the clean turn left
    // pending_feedback null, so the feedback builder projects nothing (B1) — the
    // feedback text never appears in the rendered prompt even after seeding.
    const text = await seedAndRenderText(ops, runtime, builders, renderer);
    expect(text).not.toContain(COMMANDS_ONLY_FEEDBACK_TEXT);
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
    const builders = new TestBuilderRegistry();
    const renderer = new TestRenderer(builders);
    const runtime = new AgentRuntime({
      operations: ops,
      renderer,
      provider,
      registry: builders,
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
    const builders = new TestBuilderRegistry();
    const runtime = new AgentRuntime({
      operations: ops,
      renderer: new TestRenderer(builders),
      provider,
      registry: builders,
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

// ---------------------------------------------------------------------------
// B1 — bookkeeping blocks are STATE → builder projections (no tree writes)
// ---------------------------------------------------------------------------

/**
 * Wire a runtime whose only command `boom.go` always THROWS, so each call drives the
 * runtime's failure path. The throw propagates out of TestOperations.route into the
 * runtime's invokeCommand catch (a non-policy error) — which emits onCommand(ok:false,
 * error) (actions §2.1), exactly as a real command failure would. Shares the renderer's
 * builder registry as the runtime's `registry` handle (so the B1 builder registers into it).
 */
function wireFailing(provider: MockProvider) {
  const tree = makeEmptyTree();
  const registry = new TestCommandRegistry();
  registry.register(
    'boom.go',
    { name: 'go', description: 'always throws (fixture)', capabilities: [], invoke: async () => ({ ok: true }) },
    async () => {
      throw new Error('kaboom');
    },
  );
  const policy = new PolicyEngine({ capability_resolver: registry.capabilityResolver() });
  const ops = new TestOperations(tree, policy, registry);
  const builders = new TestBuilderRegistry();
  const renderer = new TestRenderer(builders);
  const runtime = new AgentRuntime({ operations: ops, renderer, provider, registry: builders });
  return { tree, ops, runtime, builders, renderer };
}

describe('B1 bookkeeping projection (state → builder, no tree writes)', () => {
  it('the feedback builder owns runtime:commands_only_feedback and is registered at construction', () => {
    const { builders } = wire(new MockProvider([{}]));
    // The runtime registered its feedback system builder in its constructor (CM-5), so the
    // registry resolves its owner — proving registerSystemBuilder was wired. (The
    // command-error builder was removed: failures now flow out the onCommand channel to the
    // `actions` ledger — actions §2.4.)
    expect(builders.resolve_builder(COMMANDS_ONLY_FEEDBACK_BLOCK)?.name).toBe(
      'runtime.commands_only_feedback',
    );
    // Volatile (never poison the stable cache prefix).
    expect(builders.tier_of(COMMANDS_ONLY_FEEDBACK_BLOCK)).toBe('volatile');
  });

  it('a violation is NOT written to the tree — only projected by the builder (INV#1 by construction)', async () => {
    const provider = new MockProvider([{ text: 'plain chat, not a command' }, {}]);
    const { tree, ops, runtime, builders, renderer } = wire(provider);

    await runtime.on_wake(WAKE);

    // The runtime wrote NO bookkeeping node to the tree (the old upsert path is gone):
    // the feedback block exists in the tree ONLY after the boot seeds its placeholder.
    expect(tree.get(COMMANDS_ONLY_FEEDBACK_BLOCK)).toBeNull();

    // After seeding + render the builder projects the pending feedback text.
    const text = await seedAndRenderText(ops, runtime, builders, renderer);
    expect(text).toContain(COMMANDS_ONLY_FEEDBACK_TEXT);
  });

  it('a clean turn projects nothing — the feedback builder returns null', async () => {
    // No violation, no command: pending_feedback stays null → builder build()→null.
    const provider = new MockProvider([{}]);
    const { ops, runtime, builders, renderer } = wire(provider);

    await runtime.on_wake(WAKE);

    const text = await seedAndRenderText(ops, runtime, builders, renderer);
    expect(text).not.toContain(COMMANDS_ONLY_FEEDBACK_TEXT);
    // The seeded placeholder rendered nothing → no commands_only_feedback line at all.
    expect(text).not.toContain(COMMANDS_ONLY_FEEDBACK_BLOCK);
  });

  it('a command failure emits onCommand(ok:false, error) — the actions ledger replaces command_error (§2.4)', async () => {
    // The removed runtime:command_error block is replaced by the onCommand channel: a
    // non-policy throw surfaces as a CommandEvent with ok:false + the normalized error and
    // NO result, carrying the args, for the actions ledger to record.
    const provider = new MockProvider([{ tool_calls: [{ id: 't0', name: 'boom.go', args: { x: 1 } }] }, {}]);
    const { runtime } = wireFailing(provider);

    const seen: CommandEvent[] = [];
    runtime.onCommand((e) => seen.push(e));

    await runtime.on_wake(WAKE);

    expect(seen).toHaveLength(1);
    const e = seen[0]!;
    expect(e).toMatchObject({
      name: 'boom.go',
      args: { x: 1 },
      ok: false,
      error: 'kaboom',
      invoker: 'agent',
      spawn_depth: 0,
    });
    expect(e.result).toBeUndefined(); // failure site carries no result
    expect('ref' in e).toBe(false);
  });

  it('a successful command emits onCommand(ok:true, result) with the args+data (the success signal)', async () => {
    // The asymmetry actions closes: a SUCCESS now surfaces on the command channel with the
    // full args + CommandResult.data (reply.say returns {echoed}). No error; ref absent
    // because the result has no id/ref/block key (the row degrades to verb → ok).
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] },
      {},
    ]);
    const { runtime } = wire(provider);

    const seen: CommandEvent[] = [];
    runtime.onCommand((e) => seen.push(e));

    await runtime.on_wake(WAKE);

    expect(seen).toHaveLength(1);
    const e = seen[0]!;
    expect(e).toMatchObject({
      name: 'reply.say',
      args: { text: 'hi' },
      ok: true,
      result: { echoed: 'hi' },
      invoker: 'agent',
    });
    expect(e.error).toBeUndefined();
    expect('ref' in e).toBe(false); // no id/ref/block key in data → degrades cleanly
  });

  it('the seeded bookkeeping placeholders attach under the actual tree root (CM-4 guard)', async () => {
    // The whole projection silently disappears if the seed parent ≠ the live root.
    // After seeding under runtime.root, the placeholder must be REACHABLE in the tree
    // (tree.get finds it), proving the parent was correct.
    const provider = new MockProvider([{ text: 'violate' }, {}]);
    const { tree, ops, runtime, builders, renderer } = wire(provider);

    await runtime.on_wake(WAKE);
    await seedAndRenderText(ops, runtime, builders, renderer);

    // runtime.root must be the empty-tree root the fixture built.
    expect(runtime.root).toBe('root:root');
    // The seeded placeholder node now lives in the tree (reachable from root).
    expect(tree.get(COMMANDS_ONLY_FEEDBACK_BLOCK)).not.toBeNull();
  });
});
