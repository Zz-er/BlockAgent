/**
 * Wake re-latch (dirty-latch) — §8 seam 2 (the D6 multi-agent platform prerequisite).
 *
 * A wake that arrives WHILE the runtime is already `running` must be PARKED and fired on
 * return-to-idle, NOT dropped. This is IM-critical: an async push (a teammate's message
 * landing mid-turn) folds into the tree via a command and then wakes the agent; if that
 * wake is dropped while a turn is in flight, the agent never re-renders and silently
 * misses the message. Coalescing is fine (one pending latch is enough — the next loop sees
 * every already-applied tree change), so a burst of N overlapping wakes ⇒ exactly ONE
 * extra loop, never an unbounded queue.
 *
 * These tests drive a re-entrant wake from INSIDE the provider's `send` (which runs in the
 * middle of a turn, while state.kind === 'running'), which is exactly the overlap a real
 * async push creates. INV #1 is untouched — re-latch is pure control flow, no tree writes.
 */

import { describe, expect, it } from 'vitest';

import { PolicyEngine } from '../src/core/policy.js';
import type { RenderedPrompt, WakeEvent } from '../src/core/types.js';
import type { ProviderChunk, SendOpts } from '../src/provider/types.js';
import { MockProvider, type MockTurn } from '../src/provider/mock.js';
import { AgentRuntime } from '../src/runtime/agent_runtime.js';
import {
  TestBuilderRegistry,
  TestCommandRegistry,
  TestOperations,
  TestRenderer,
  makeEmptyTree,
  makeReplyApp,
} from './fixtures.js';

const WAKE: WakeEvent = { kind: 'app_event', source: 'messages', reason: 'm', ref: 'a' };
const PUSH: WakeEvent = { kind: 'app_event', source: 'im_proxy', reason: 'push', ref: 'b' };

function wire(provider: MockProvider) {
  const tree = makeEmptyTree();
  const registry = new TestCommandRegistry();
  makeReplyApp(registry);
  const policy = new PolicyEngine({ capability_resolver: registry.capabilityResolver() });
  const ops = new TestOperations(tree, policy, registry);
  const builders = new TestBuilderRegistry();
  const renderer = new TestRenderer(builders);
  const runtime = new AgentRuntime({ operations: ops, renderer, provider, registry: builders });
  return { runtime, provider };
}

/**
 * ReentrantProvider — a MockProvider that, on a chosen `send`, fires `onSend()` (a
 * re-entrant wake) BEFORE streaming its scripted turn. That `onSend` runs while the runtime
 * is `running`, so the wake it raises must be parked, not dropped.
 */
class ReentrantProvider extends MockProvider {
  constructor(
    script: MockTurn[],
    private readonly onSend: (sendCount: number) => void,
  ) {
    super(script);
  }
  private sendCount = 0;
  override send(prompt: RenderedPrompt, opts: SendOpts): AsyncIterable<ProviderChunk> {
    this.sendCount += 1;
    this.onSend(this.sendCount);
    return super.send(prompt, opts);
  }
}

describe('wake re-latch — a wake during a running turn is parked, not dropped', () => {
  it('fires the parked wake after the turn settles (one extra loop)', async () => {
    // Turn 1 (the original WAKE) replies, then the loop would idle. During turn 1's send we
    // raise a re-entrant PUSH wake — it must park and re-run after settle. The re-run is a
    // fresh loop: turn 2 replies, turn 3 idles. So the script must have enough turns.
    const records: { turn_id: string; wake: WakeEvent }[] = [];
    let runtimeRef: AgentRuntime | null = null;
    const provider = new ReentrantProvider(
      [{ tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] }, {}, {}],
      (n) => {
        // On the FIRST send only, fire a re-entrant wake (the async push overlapping turn 1).
        if (n === 1) void runtimeRef!.on_wake(PUSH);
      },
    );
    const { runtime } = wire(provider);
    runtimeRef = runtime;
    runtime.onTurn((r) => records.push({ turn_id: r.turn_id, wake: r.wake_event }));

    await runtime.on_wake(WAKE);

    // The first wake ran (wake 1). The parked PUSH then ran as wake 2 — NOT dropped.
    const wakeSeqs = records.map((r) => r.turn_id.split('.')[0]);
    expect(wakeSeqs).toContain('1');
    expect(wakeSeqs).toContain('2');
    // The second wake's loop carried the PUSH event (the re-latched trigger).
    const secondWakeRecord = records.find((r) => r.turn_id.startsWith('2.'));
    expect(secondWakeRecord?.wake).toEqual(PUSH);
    // Runtime ended idle (drained the latch fully).
    expect(runtime.state.kind).toBe('idle');
    expect(runtime.wake_seq).toBe(2);
  });

  it('coalesces a burst of N overlapping wakes into a single extra loop', async () => {
    // Fire 5 re-entrant wakes during turn 1's send. They coalesce to one pending latch, so
    // exactly ONE additional wake loop runs (wake_seq goes 1 → 2, never 1 → 6).
    let runtimeRef: AgentRuntime | null = null;
    const provider = new ReentrantProvider(
      [{ tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] }, {}, {}],
      (n) => {
        if (n === 1) {
          for (let i = 0; i < 5; i += 1) {
            void runtimeRef!.on_wake({ kind: 'app_event', source: 'im_proxy', ref: `p${i}` });
          }
        }
      },
    );
    const { runtime } = wire(provider);
    runtimeRef = runtime;

    await runtime.on_wake(WAKE);

    // 1 original + exactly 1 coalesced re-run = wake_seq 2 (not 6).
    expect(runtime.wake_seq).toBe(2);
    expect(runtime.state.kind).toBe('idle');
  });

  it('the coalesced latch holds the MOST RECENT wake', async () => {
    // Fire two distinct wakes mid-turn; the last one wins the single latch and drives the
    // re-run's TurnRecord.wake_event.
    const records: WakeEvent[] = [];
    let runtimeRef: AgentRuntime | null = null;
    const first: WakeEvent = { kind: 'app_event', source: 'im_proxy', ref: 'first' };
    const last: WakeEvent = { kind: 'app_event', source: 'im_proxy', ref: 'last' };
    const provider = new ReentrantProvider(
      [{ tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] }, {}, {}],
      (n) => {
        if (n === 1) {
          void runtimeRef!.on_wake(first);
          void runtimeRef!.on_wake(last);
        }
      },
    );
    const { runtime } = wire(provider);
    runtimeRef = runtime;
    runtime.onTurn((r) => {
      if (r.turn_id.startsWith('2.')) records.push(r.wake_event);
    });

    await runtime.on_wake(WAKE);

    expect(records[0]).toEqual(last);
  });

  it('does not re-run when no wake overlapped the turn (no spurious loop)', async () => {
    // A plain wake with no re-entrant push: exactly one wake loop, no re-latch.
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] },
      {},
    ]);
    const { runtime } = wire(provider);

    await runtime.on_wake(WAKE);

    expect(runtime.wake_seq).toBe(1);
    expect(runtime.state.kind).toBe('idle');
  });
});
