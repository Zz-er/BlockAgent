/**
 * test/task_create_mock.test.ts — the context-reactive task-create mock provider (offline dry-run).
 *
 * TaskCreateMockProvider stands in for a real LLM in the platform Task WRITE vertical (D2b): each
 * `send` it reads the rendered prompt, finds the `im_proxy:chat` block, and emits a
 * `task_proxy.add` for an inbound IM directive `create task: <title>` it has not yet actioned —
 * otherwise an empty turn so the runtime loop settles. These tests pin that reactive behavior
 * (which the cross-process e2e harness relies on) without spawning anything: build a prompt, drain
 * the stream, assert the tool_call.
 */

import { describe, expect, it } from 'vitest';

import { TaskCreateMockProvider } from '../src/provider/task_create_mock.js';
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

describe('TaskCreateMockProvider', () => {
  it('emits task_proxy.add with the directive title for `create task: <title>`', async () => {
    const provider = new TaskCreateMockProvider();
    const chunks = await drain(provider.send(chatPrompt(['[im:alice] create task: ship the release']), {}));
    const call = toolCall(chunks);
    expect(call?.call.name).toBe('task_proxy.add');
    expect(call?.call.args).toEqual({ title: 'ship the release' });
  });

  it('is case-insensitive on the prefix and tolerant of whitespace around the colon', async () => {
    const provider = new TaskCreateMockProvider();
    const chunks = await drain(provider.send(chatPrompt(['[im:alice] Create Task :  fix the bug']), {}));
    expect(toolCall(chunks)?.call.args).toEqual({ title: 'fix the bug' });
  });

  it('emits an empty turn (no command) for a non-directive inbound message', async () => {
    const provider = new TaskCreateMockProvider();
    const chunks = await drain(provider.send(chatPrompt(['[im:alice] hello, how are you?']), {}));
    expect(toolCall(chunks)).toBeUndefined();
    expect(chunks.some((c) => c.kind === 'done')).toBe(true);
  });

  it('ignores the agent\'s own (`[me]`) lines — only inbound directives create tasks', async () => {
    const provider = new TaskCreateMockProvider();
    const chunks = await drain(provider.send(chatPrompt(['[me] create task: not from me']), {}));
    expect(toolCall(chunks)).toBeUndefined();
  });

  it('actions each directive exactly once (the loop terminates, no re-create)', async () => {
    const provider = new TaskCreateMockProvider();
    const t1 = await drain(provider.send(chatPrompt(['[im:alice] create task: only once']), {}));
    expect(toolCall(t1)?.call.args).toEqual({ title: 'only once' });
    // Same directive still in the window next turn → no second create.
    const t2 = await drain(provider.send(chatPrompt(['[im:alice] create task: only once']), {}));
    expect(toolCall(t2)).toBeUndefined();
  });

  it('ignores a missing im_proxy:chat block entirely (empty turn)', async () => {
    const provider = new TaskCreateMockProvider();
    const prompt: RenderedPrompt = {
      segments: [{ tier: 'stable', rendered: '# Identity only, no chat', cache_boundary: true }],
      snapshot_hash: 'h',
      segment_hashes: new Map(),
    };
    expect(toolCall(await drain(provider.send(prompt, {})))).toBeUndefined();
  });

  it('actions the NEWEST unactioned directive when several are present', async () => {
    const provider = new TaskCreateMockProvider();
    const chunks = await drain(
      provider.send(
        chatPrompt(['[im:alice] create task: first one', '[im:bob] create task: second one']),
        {},
      ),
    );
    expect(toolCall(chunks)?.call.args).toEqual({ title: 'second one' });
  });

  it('treats an empty title (`create task:`) as no-match (no spurious task)', async () => {
    const provider = new TaskCreateMockProvider();
    expect(toolCall(await drain(provider.send(chatPrompt(['[im:alice] create task:']), {})))).toBeUndefined();
  });
});
