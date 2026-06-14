/**
 * provider-send idle timeout — the live-but-stuck-agent fix (impl-runtime).
 *
 * A hung / half-open provider stream (no bytes, never completes, never rejects) must NOT
 * wedge the runtime forever in `running` (which would then silently DROP every later
 * wake — agent permanently deaf). The runtime arms an idle deadline that ABORTS the send
 * via SendOpts.signal after send_timeout_ms of no chunk; the abort surfaces as a normal
 * send failure → emitError('send') + a send_error TurnRecord → return to idle. So the
 * agent SELF-HEALS and stays wake-responsive. The timer re-arms per chunk, so a
 * long-but-streaming generation is never cut off.
 */

import { describe, expect, it } from 'vitest';

import { PolicyEngine } from '../src/core/policy.js';
import type { RenderedPrompt, TurnRecord } from '../src/core/types.js';
import type { ProviderChunk, SendOpts } from '../src/provider/types.js';
import { MockProvider } from '../src/provider/mock.js';
import { AgentRuntime } from '../src/runtime/agent_runtime.js';
import {
  TestBuilderRegistry,
  TestCommandRegistry,
  TestOperations,
  TestRenderer,
  makeEmptyTree,
  makeReplyApp,
} from './fixtures.js';

const WAKE = {
  kind: 'app_event',
  source: 'messages',
  reason: 'message_arrived',
  ref: 'm1',
} as const;

/** A provider whose send() NEVER yields and only settles (rejects) when its signal aborts. */
class HangingProvider extends MockProvider {
  override send(_prompt: RenderedPrompt, opts: SendOpts): AsyncIterable<ProviderChunk> {
    const signal = opts.signal;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderChunk> {
        // Block until aborted: the runtime's idle deadline aborts the signal, which
        // rejects this promise with the abort reason (the ProviderSendTimeoutError).
        await new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => reject(signal?.reason ?? new Error('aborted'));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
    };
  }
}

function wire(provider: MockProvider, send_timeout_ms: number) {
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
    send_timeout_ms,
  });
  return { runtime };
}

describe('provider send idle timeout', () => {
  it('aborts a hung send after the idle deadline and self-heals to idle', async () => {
    const provider = new HangingProvider([{}]);
    const { runtime } = wire(provider, 50);
    const errs: Array<{ message: string; phase: string }> = [];
    const turns: TurnRecord[] = [];
    runtime.onError((e) => errs.push({ message: e.message, phase: e.phase }));
    runtime.onTurn((r) => turns.push(r));

    const start = Date.now();
    await runtime.on_wake(WAKE); // MUST resolve (not hang)
    const elapsed = Date.now() - start;

    // Returned shortly after the 50ms deadline — it did NOT hang.
    expect(elapsed).toBeLessThan(5_000);
    // Surfaced as a send failure carrying the timeout message...
    expect(errs).toHaveLength(1);
    expect(errs[0]?.phase).toBe('send');
    expect(errs[0]?.message).toContain('timed out');
    // ...with exactly one send_error TurnRecord...
    expect(turns.map((t) => t.ended_by)).toEqual(['send_error']);
    // ...and the runtime SELF-HEALED to idle (not wedged in 'running').
    expect(runtime.state.kind).toBe('idle');
  });

  it('does not trip on a provider that streams within the deadline (no false abort)', async () => {
    // A normal mock turn completes synchronously, well within a tiny deadline.
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] },
      {},
    ]);
    const { runtime } = wire(provider, 50);
    const errs: string[] = [];
    runtime.onError((e) => errs.push(e.phase));

    await runtime.on_wake(WAKE);

    expect(errs).toHaveLength(0); // no timeout fired
    expect(runtime.state.kind).toBe('idle');
    expect(provider.turns_consumed).toBe(2);
  });

  it('a non-positive timeout disables the abort (scripted-provider behavior unchanged)', async () => {
    const provider = new MockProvider([{ tool_calls: [{ id: 't1', name: 'reply.say', args: { text: 'hi' } }] }, {}]);
    const { runtime } = wire(provider, 0); // disabled
    const errs: string[] = [];
    runtime.onError((e) => errs.push(e.phase));

    await runtime.on_wake(WAKE);

    expect(errs).toHaveLength(0);
    expect(runtime.state.kind).toBe('idle');
  });
});
