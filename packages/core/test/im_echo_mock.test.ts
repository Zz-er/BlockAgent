/**
 * test/im_echo_mock.test.ts — the context-reactive im-echo mock provider (offline dry-run).
 *
 * ImEchoMockProvider stands in for a real LLM in the platform IM vertical: each `send` it reads
 * the rendered prompt, finds the `im_proxy:chat` block, and replies (`im_proxy.reply`) to an
 * inbound peer message it has not yet answered — otherwise it emits an empty turn so the runtime
 * loop settles. These tests pin that reactive behavior (which the end-to-end harness relies on)
 * without spawning anything: build a prompt, drain the stream, assert the tool_call.
 */

import { describe, expect, it } from 'vitest';

import { ImEchoMockProvider } from '../src/provider/im_echo_mock.js';
import type { ProviderChunk } from '../src/provider/types.js';
import type { RenderedPrompt } from '../src/core/types.js';

/** A RenderedPrompt whose volatile segment carries an `im_proxy:chat` block with `lines`. */
function chatPrompt(lines: string[]): RenderedPrompt {
  const chat = ['# Chat — dm im:alice', ...lines].join('\n');
  return {
    segments: [
      { tier: 'stable', rendered: '# Identity\nyou are an agent', cache_boundary: true },
      { tier: 'volatile', rendered: chat, cache_boundary: false },
    ],
    snapshot_hash: 'h',
    segment_hashes: new Map(),
  };
}

async function drain(it: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}
function toolCall(chunks: ProviderChunk[]): Extract<ProviderChunk, { kind: 'tool_call' }> | undefined {
  return chunks.find((c): c is Extract<ProviderChunk, { kind: 'tool_call' }> => c.kind === 'tool_call');
}

describe('ImEchoMockProvider', () => {
  it('replies to an inbound IM message with im_proxy.reply echoing the body', async () => {
    const provider = new ImEchoMockProvider();
    const chunks = await drain(provider.send(chatPrompt(['[im:alice] please ack']), {}));
    const call = toolCall(chunks);
    expect(call?.call.name).toBe('im_proxy.reply');
    expect(call?.call.args).toEqual({ body: 'echo: please ack' });
  });

  it('emits an empty turn (no command) when there is no inbound message to answer', async () => {
    const provider = new ImEchoMockProvider();
    // Only the agent's own message in the window → nothing inbound to reply to.
    const chunks = await drain(provider.send(chatPrompt(['[me] echo: earlier']), {}));
    expect(toolCall(chunks)).toBeUndefined();
    expect(chunks.some((c) => c.kind === 'done')).toBe(true);
  });

  it('answers each inbound message exactly once (the loop terminates, no re-reply)', async () => {
    const provider = new ImEchoMockProvider();
    // Turn 1: inbound present → one reply.
    const t1 = await drain(provider.send(chatPrompt(['[im:alice] hi there']), {}));
    expect(toolCall(t1)?.call.args).toEqual({ body: 'echo: hi there' });
    // Turn 2: SAME inbound still in the window (and now its echo too) → no second reply.
    const t2 = await drain(
      provider.send(chatPrompt(['[im:alice] hi there', '[im:a1] echo: hi there']), {}),
    );
    expect(toolCall(t2)).toBeUndefined();
  });

  it('never re-answers a re-fed echo line (no echo-of-echo loop)', async () => {
    const provider = new ImEchoMockProvider();
    // A window that contains only an `echo:`-prefixed inbound line must not trigger a reply.
    const chunks = await drain(provider.send(chatPrompt(['[im:alice] echo: something']), {}));
    expect(toolCall(chunks)).toBeUndefined();
  });

  it('ignores a missing im_proxy:chat block entirely (empty turn)', async () => {
    const provider = new ImEchoMockProvider();
    const prompt: RenderedPrompt = {
      segments: [{ tier: 'stable', rendered: '# Identity only, no chat', cache_boundary: true }],
      snapshot_hash: 'h',
      segment_hashes: new Map(),
    };
    const chunks = await drain(provider.send(prompt, {}));
    expect(toolCall(chunks)).toBeUndefined();
  });

  it('replies to the NEWEST unanswered inbound when several are present', async () => {
    const provider = new ImEchoMockProvider();
    const chunks = await drain(
      provider.send(chatPrompt(['[im:alice] first', '[im:bob] second']), {}),
    );
    expect(toolCall(chunks)?.call.args).toEqual({ body: 'echo: second' });
  });
});
