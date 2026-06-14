/**
 * Per-turn telemetry channel (onTurn / TurnRecord) — the P1 keystone, owned by
 * impl-runtime.
 *
 * The runtime emits exactly one TurnRecord per turn on a side-channel symmetric to
 * onThinking / onError: it carries the wake event, the render hashes/sizes copied
 * verbatim off the RenderedPrompt (no re-render — INV #1 untouched), the recaptured
 * provider usage (previously computed then dropped), and the end reason. The record is
 * CLOCK-FREE (deterministic turn_id, no wall-clock) and never enters the tree or the
 * next prompt — it is telemetry, not context.
 */

import { describe, expect, it } from 'vitest';

import { PolicyEngine } from '../src/core/policy.js';
import type { TurnRecord } from '../src/core/types.js';
import { MockProvider } from '../src/provider/mock.js';
import { AgentRuntime } from '../src/runtime/agent_runtime.js';
import {
  TestBuilderRegistry,
  TestCommandRegistry,
  TestOperations,
  TestRenderer,
  makeEmptyTree,
  makeReplyApp,
  makeEndTurnApp,
} from './fixtures.js';

// A message wake is an app_event with source/reason/ref (the base-ified WakeEvent).
const WAKE = {
  kind: 'app_event',
  source: 'messages',
  reason: 'message_arrived',
  ref: 'm1',
} as const;

function wire(
  provider: MockProvider,
  install: (r: TestCommandRegistry) => void = makeReplyApp,
) {
  const tree = makeEmptyTree();
  const registry = new TestCommandRegistry();
  install(registry);
  const policy = new PolicyEngine({ capability_resolver: registry.capabilityResolver() });
  const ops = new TestOperations(tree, policy, registry);
  const builders = new TestBuilderRegistry();
  const renderer = new TestRenderer(builders);
  const runtime = new AgentRuntime({ operations: ops, renderer, provider, registry: builders });
  return { tree, ops, runtime, builders, renderer };
}

function collectTurns(runtime: AgentRuntime): TurnRecord[] {
  const records: TurnRecord[] = [];
  runtime.onTurn((r) => records.push(r));
  return records;
}

describe('onTurn — per-turn telemetry channel', () => {
  it('emits one record per turn, ended_by=reply when a command sets end_turn', async () => {
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'done.reply', args: {} }] },
    ]);
    const { runtime } = wire(provider, makeEndTurnApp);
    const records = collectTurns(runtime);

    await runtime.on_wake(WAKE);

    expect(records).toHaveLength(1);
    expect(records[0]?.ended_by).toBe('reply');
    expect(records[0]?.turn_id).toBe('1.1');
    expect(records[0]?.spawn_depth).toBe(0);
    expect(records[0]?.wake_event).toEqual(WAKE);
  });

  it('emits tool_calls then idle across a multi-step (non-end_turn) wake', async () => {
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] },
      {},
    ]);
    const { runtime } = wire(provider);
    const records = collectTurns(runtime);

    await runtime.on_wake(WAKE);

    expect(records.map((r) => r.ended_by)).toEqual(['tool_calls', 'idle']);
    expect(records.map((r) => r.turn_id)).toEqual(['1.1', '1.2']);
  });

  it('emits ended_by=disallowed_text on a commands-only violation', async () => {
    const provider = new MockProvider([{ text: 'just chatting, not a command' }, {}]);
    const { runtime } = wire(provider);
    const records = collectTurns(runtime);

    await runtime.on_wake(WAKE);

    expect(records.map((r) => r.ended_by)).toEqual(['disallowed_text', 'idle']);
  });

  it('emits ended_by=send_error (with pre-send render hashes, no usage) on a provider failure', async () => {
    const provider = new MockProvider([]); // exhausted script → send() throws
    const { runtime } = wire(provider);
    const records = collectTurns(runtime);

    await runtime.on_wake(WAKE); // must not throw

    expect(records).toHaveLength(1);
    expect(records[0]?.ended_by).toBe('send_error');
    // Render had already succeeded before the failed send → the snapshot hash is present.
    expect(typeof records[0]?.snapshot_hash).toBe('string');
    // No response, so no usage.
    expect(records[0]?.usage).toBeUndefined();
    expect(runtime.state.kind).toBe('idle');
  });

  it('recaptures provider usage into the record (and omits it when absent)', async () => {
    const withUsage = new MockProvider([
      {
        tool_calls: [{ id: 't1', name: 'done.reply', args: {} }],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    ]);
    const r1 = wire(withUsage, makeEndTurnApp);
    const recs1 = collectTurns(r1.runtime);
    await r1.runtime.on_wake(WAKE);
    expect(recs1[0]?.usage).toEqual({ input_tokens: 100, output_tokens: 20 });

    const noUsage = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'done.reply', args: {} }] },
    ]);
    const r2 = wire(noUsage, makeEndTurnApp);
    const recs2 = collectTurns(r2.runtime);
    await r2.runtime.on_wake(WAKE);
    expect(recs2[0]?.usage).toBeUndefined();
  });

  it('copies snapshot_hash off the rendered prompt verbatim (no re-render / re-hash)', async () => {
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'done.reply', args: {} }] },
    ]);
    const { runtime } = wire(provider, makeEndTurnApp);
    const records = collectTurns(runtime);

    await runtime.on_wake(WAKE);

    // The provider stored the exact prompt it was sent; the record's hash must equal it
    // verbatim — proving the runtime copied render OUTPUT, never re-derived.
    expect(records[0]?.snapshot_hash).toBe(provider.last_prompt?.snapshot_hash);
    expect(records[0]?.segment_hashes).toBeDefined();
    expect(records[0]?.per_tier_bytes).toBeDefined();
  });

  it('turn_id advances deterministically per wake (no clock, no random)', async () => {
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'a' } }] },
      {},
      { tool_calls: [{ id: 't2', name: 'reply.say', args: { text: 'b' } }] },
      {},
    ]);
    const { runtime } = wire(provider);
    const records = collectTurns(runtime);

    await runtime.on_wake(WAKE); // wake 1 → 1.1, 1.2
    await runtime.on_wake(WAKE); // wake 2 → 2.1, 2.2

    expect(records.map((r) => r.turn_id)).toEqual(['1.1', '1.2', '2.1', '2.2']);
  });

  it('is fire-and-forget — a throwing subscriber never breaks the turn loop', async () => {
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] },
      {},
    ]);
    const { runtime } = wire(provider);
    const good: TurnRecord[] = [];
    runtime.onTurn(() => {
      throw new Error('faulty subscriber');
    });
    runtime.onTurn((r) => good.push(r));

    await expect(runtime.on_wake(WAKE)).resolves.toBeUndefined();

    expect(good.map((r) => r.ended_by)).toEqual(['tool_calls', 'idle']);
    expect(runtime.state.kind).toBe('idle');
  });

  it('the unsubscribe thunk stops delivery', async () => {
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] },
      {},
    ]);
    const { runtime } = wire(provider);
    const records: TurnRecord[] = [];
    const off = runtime.onTurn((r) => records.push(r));
    off();

    await runtime.on_wake(WAKE);

    expect(records).toHaveLength(0);
  });
});

describe('onToolCall — tool-call channel', () => {
  it('emits one event per NON-reply command, with name + ok (never args)', async () => {
    // reply.say is a normal (non-end_turn) command; a second idle response ends the wake.
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] },
      {},
    ]);
    const { runtime } = wire(provider, makeReplyApp);
    const calls: Array<{ name: string; ok: boolean; spawn_depth: number }> = [];
    runtime.onToolCall((e) => calls.push(e));

    await runtime.on_wake(WAKE);

    // The channel surfaced the command's name + success — and the event carries no `args`
    // (telemetry, not content).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: 'reply.say', ok: true, spawn_depth: 0 });
    expect(Object.keys(calls[0]!)).not.toContain('args');
  });

  it('does NOT emit for the end_turn (reply) command — it is the reply, not a tool', async () => {
    // done.reply sets end_turn → surfaced as the reply, never double-shown as a tool_call.
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'done.reply', args: {} }] },
    ]);
    const { runtime } = wire(provider, makeEndTurnApp);
    const calls: unknown[] = [];
    runtime.onToolCall((e) => calls.push(e));

    await runtime.on_wake(WAKE);

    expect(calls).toHaveLength(0);
  });

  it('does not emit for a wake that produces no tool_calls (idle text turn)', async () => {
    const provider = new MockProvider([{ thinking: ['just thinking'], tool_calls: [] }]);
    const { runtime } = wire(provider, makeReplyApp);
    const calls: unknown[] = [];
    runtime.onToolCall((e) => calls.push(e));

    await runtime.on_wake(WAKE);

    expect(calls).toHaveLength(0);
  });
});
