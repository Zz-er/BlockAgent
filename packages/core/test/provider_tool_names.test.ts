/**
 * test/provider_tool_names.test.ts — wire-safe tool-name encoding + provider round-trip.
 *
 * Command full names use a DOT (`messages.reply`), but Anthropic and OpenAI/DeepSeek
 * require tool/function names to match `^[a-zA-Z0-9_-]+$` (a `.` is a 400). The provider
 * must send a sanitized wire name AND decode the model's tool_call name back to the
 * original command full name, or the runtime routes a wrong/garbled command. These were
 * found by real-LLM validation (DeepSeek returned 400 on the dotted name); the providers
 * had no direct tests before, so this also closes that gap.
 */

import { describe, expect, it } from 'vitest';

import { encodeToolNames } from '../src/provider/tool_names.js';
import { OpenAiCompatibleProvider } from '../src/provider/openai_compat.js';
import { AnthropicProvider } from '../src/provider/anthropic.js';
import type { ProviderChunk } from '../src/provider/types.js';
import type { RenderedPrompt } from '../src/core/types.js';

const PROMPT: RenderedPrompt = {
  segments: [{ tier: 'stable', rendered: 'system prompt', cache_boundary: false }],
  snapshot_hash: 'h',
  segment_hashes: new Map(),
};

/** A ReadableStream of UTF-8 SSE frames, like a real fetch() response body. */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

function toolCallOf(chunks: ProviderChunk[]): Extract<ProviderChunk, { kind: 'tool_call' }> | undefined {
  return chunks.find(
    (c): c is Extract<ProviderChunk, { kind: 'tool_call' }> => c.kind === 'tool_call',
  );
}
function doneOf(chunks: ProviderChunk[]): Extract<ProviderChunk, { kind: 'done' }> | undefined {
  return chunks.find((c): c is Extract<ProviderChunk, { kind: 'done' }> => c.kind === 'done');
}

async function drain(it: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('encodeToolNames', () => {
  it('produces wire-safe names (no dot) and round-trips via decode', () => {
    const enc = encodeToolNames(['messages.reply', 'tools.read_file', 'agent_identity.set']);
    for (const w of enc.wire) {
      expect(w).not.toContain('.');
      expect(w).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    // decode reverses each wire name to its original command full name.
    expect(enc.decode(enc.wire[0]!)).toBe('messages.reply');
    expect(enc.decode(enc.wire[1]!)).toBe('tools.read_file');
    expect(enc.decode(enc.wire[2]!)).toBe('agent_identity.set');
  });

  it('disambiguates names that sanitize to the same wire form', () => {
    // Both would naively sanitize to `a_b`; the second must get a distinct wire name.
    const enc = encodeToolNames(['a.b', 'a_b']);
    expect(enc.wire[0]).not.toBe(enc.wire[1]);
    expect(enc.decode(enc.wire[0]!)).toBe('a.b');
    expect(enc.decode(enc.wire[1]!)).toBe('a_b');
  });

  it('decode falls back to the input for an unknown (hallucinated) name', () => {
    const enc = encodeToolNames(['messages.reply']);
    expect(enc.decode('not_a_real_tool')).toBe('not_a_real_tool');
  });
});

describe('OpenAiCompatibleProvider tool-name round-trip', () => {
  it('sends a wire-safe tool name and decodes the tool_call name back to the dotted command', async () => {
    let sentName = '';
    const fetch_impl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        tools: Array<{ function: { name: string } }>;
      };
      sentName = body.tools[0]!.function.name;
      const frames = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"messages_reply","arguments":"{\\"content\\":\\"hi\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      return { ok: true, status: 200, statusText: 'OK', body: sseStream(frames) } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider({
      base_url: 'http://x',
      model: 'm',
      api_key: 'k',
      thinking_format: 'none',
      fetch_impl,
    });

    const chunks = await drain(
      provider.send(PROMPT, { tools: [{ name: 'messages.reply', description: 'Reply to the user' }] }),
    );

    // The wire name actually sent is dot-free and matches the API's allowed pattern.
    expect(sentName).not.toContain('.');
    expect(sentName).toMatch(/^[a-zA-Z0-9_-]+$/);

    // The emitted tool_call carries the ORIGINAL command full name (decoded)…
    expect(toolCallOf(chunks)?.call.name).toBe('messages.reply');
    // …and so does the assembled done response the thinking-adapter parses.
    const raw = doneOf(chunks)?.response.raw as {
      choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
    };
    expect(raw.choices[0]!.message.tool_calls[0]!.function.name).toBe('messages.reply');
  });
});

describe('AnthropicProvider tool-name round-trip', () => {
  it('sends a wire-safe tool name and decodes the tool_use name back to the dotted command', async () => {
    let sentName = '';
    const fetch_impl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { tools: Array<{ name: string }> };
      sentName = body.tools[0]!.name;
      const frames = [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"messages_reply"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"content\\":\\"hi\\"}"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
      ];
      return { ok: true, status: 200, statusText: 'OK', body: sseStream(frames) } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider({ model: 'claude', api_key: 'k', fetch_impl });

    const chunks = await drain(
      provider.send(PROMPT, { tools: [{ name: 'messages.reply', description: 'Reply to the user' }] }),
    );

    expect(sentName).not.toContain('.');
    expect(sentName).toMatch(/^[a-zA-Z0-9_-]+$/);

    expect(toolCallOf(chunks)?.call.name).toBe('messages.reply');
    const raw = doneOf(chunks)?.response.raw as { content: Array<{ type: string; name?: string }> };
    const toolUse = raw.content.find((b) => b.type === 'tool_use');
    expect(toolUse?.name).toBe('messages.reply');
  });
});
