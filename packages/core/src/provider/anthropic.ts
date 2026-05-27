/**
 * provider/anthropic.ts — AnthropicProvider (impl-provider).
 *
 * Talks to the Anthropic Messages API over `fetch` (no SDK dependency). The
 * RenderedPrompt's tier segments become a single user message whose content
 * parts carry `cache_control: { type: 'ephemeral' }` at each cache boundary,
 * capped at the provider's 4 breakpoints (§11.3). thinking/tool_use/text in the
 * streamed response are normalized by AnthropicThinkingAdapter (§4.4).
 *
 * Streaming: consumes the SSE `messages` stream and re-emits ProviderChunks,
 * accumulating an Anthropic-shaped `content[]` for the terminating `done` chunk so
 * `thinking_adapter.extract` sees the same shape whether streamed or buffered.
 *
 * No api_key → `send` throws a clear error before any network call (so unit tests
 * never hit the wire). Contract: import-only from provider/types.js + core/types.js.
 */

import type { ContentPart, RenderedPrompt } from '../core/types.js';
import type {
  CacheHint,
  ModelCapabilities,
  ModelProvider,
  ProviderChunk,
  ProviderResponse,
  SendOpts,
  ThinkingAdapter,
  ToolCall,
} from './types.js';
import { AnthropicThinkingAdapter } from './thinking.js';
import { encodeToolNames, type EncodedToolNames } from './tool_names.js';

/** Anthropic allows at most 4 cache breakpoints per request (§11.3). */
const ANTHROPIC_MAX_BREAKPOINTS = 4;
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface AnthropicProviderOpts {
  model: string;
  /** Read from `process.env.ANTHROPIC_API_KEY` by the caller; never inferred here. */
  api_key?: string;
  base_url?: string;
  /** `anthropic-version` header (default `2023-06-01`). */
  api_version?: string;
  /** Capability overrides merged onto the model defaults. */
  capabilities?: Partial<ModelCapabilities>;
  /** Default cap when SendOpts omits `max_output_tokens`. */
  default_max_output_tokens?: number;
  /** Injectable fetch for tests; defaults to global `fetch`. */
  fetch_impl?: typeof fetch;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  vision: true,
  audio: false,
  system_prompt_cache: true,
  cache_control: 'anthropic',
  max_input_tokens: 200_000,
  tool_dispatch: 'native',
  thinking_format: 'anthropic_blocks',
};

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly capabilities: ModelCapabilities;
  readonly thinking_adapter: ThinkingAdapter = new AnthropicThinkingAdapter();

  private readonly model: string;
  private readonly api_key: string | undefined;
  private readonly base_url: string;
  private readonly api_version: string;
  private readonly default_max_output_tokens: number;
  private readonly fetch_impl: typeof fetch;

  constructor(opts: AnthropicProviderOpts) {
    this.model = opts.model;
    this.api_key = opts.api_key;
    this.base_url = (opts.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.api_version = opts.api_version ?? DEFAULT_API_VERSION;
    this.default_max_output_tokens = opts.default_max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
    this.fetch_impl = opts.fetch_impl ?? globalThis.fetch;
  }

  send(prompt: RenderedPrompt, opts: SendOpts): AsyncIterable<ProviderChunk> {
    if (!this.api_key) {
      throw new Error(
        'AnthropicProvider: missing api_key — set ANTHROPIC_API_KEY and pass it to the ' +
          'constructor before calling send().',
      );
    }
    if (typeof this.fetch_impl !== 'function') {
      throw new Error('AnthropicProvider: no fetch implementation available (pass fetch_impl).');
    }
    return this.stream(prompt, opts, this.api_key);
  }

  estimateTokens(text: string): number {
    // Coarse heuristic (~3.5 chars/token for English). Real accounting comes back
    // on the `usage` chunk; this is only for pre-flight budgeting.
    return Math.ceil(text.length / 3.5);
  }

  cache_hint(segments: RenderedPrompt['segments']): CacheHint {
    const flagged: number[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i]!.cache_boundary) flagged.push(i);
    }
    // Keep the LAST N boundaries: Anthropic caches the prefix up to each
    // breakpoint, so the deepest boundaries give the longest cached prefixes.
    const breakpoints =
      flagged.length > ANTHROPIC_MAX_BREAKPOINTS
        ? flagged.slice(flagged.length - ANTHROPIC_MAX_BREAKPOINTS)
        : flagged;
    return { breakpoints, max_breakpoints: ANTHROPIC_MAX_BREAKPOINTS };
  }

  private async *stream(
    prompt: RenderedPrompt,
    opts: SendOpts,
    api_key: string,
  ): AsyncIterable<ProviderChunk> {
    // Encode command full names (`<app>.<cmd>`) into wire-safe tool names: Anthropic
    // requires tool names to match `^[a-zA-Z0-9_-]+$`, so a `.` is rejected. We send
    // the wire names and decode tool_use names back to the original on the way out.
    const enc =
      opts.tools && opts.tools.length > 0
        ? encodeToolNames(opts.tools.map((t) => t.name))
        : null;
    const body = this.build_request_body(prompt, opts, enc);
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': api_key,
        'anthropic-version': this.api_version,
      },
      body: JSON.stringify(body),
    };
    if (opts.signal) init.signal = opts.signal;

    const res = await this.fetch_impl(`${this.base_url}/v1/messages`, init);
    if (!res.ok || !res.body) {
      const detail = await safe_read_text(res);
      throw new Error(`AnthropicProvider: request failed (${res.status} ${res.statusText}) ${detail}`);
    }

    yield* this.consume_sse(res.body, enc);
  }

  /** Build the Messages API request body from the rendered prompt + opts. */
  private build_request_body(
    prompt: RenderedPrompt,
    opts: SendOpts,
    enc: EncodedToolNames | null,
  ): Record<string, unknown> {
    const hint = this.cache_hint(prompt.segments);
    const breakpoint_set = new Set(hint.breakpoints);

    const content: unknown[] = [];
    for (let i = 0; i < prompt.segments.length; i += 1) {
      const segment = prompt.segments[i]!;
      const at_boundary = breakpoint_set.has(i);
      for (const part of to_content_parts(segment.rendered)) {
        // Attach the ephemeral marker to the final part of a boundary segment so
        // the cached prefix ends exactly at the tier boundary.
        content.push(part);
      }
      if (at_boundary && content.length > 0) {
        const last = content[content.length - 1] as Record<string, unknown>;
        last['cache_control'] = { type: 'ephemeral' };
      }
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.max_output_tokens ?? this.default_max_output_tokens,
      stream: true,
      messages: [{ role: 'user', content }],
    };
    if (opts.temperature !== undefined) body['temperature'] = opts.temperature;
    if (opts.tools && opts.tools.length > 0) {
      body['tools'] = opts.tools.map((t, i) => ({
        name: enc ? enc.wire[i]! : t.name,
        description: t.description,
        input_schema: t.args_schema ?? { type: 'object', properties: {} },
      }));
    }
    return body;
  }

  /**
   * Parse the Anthropic SSE event stream into ProviderChunks while reassembling a
   * `content[]` for the terminating `done` chunk. Handles `content_block_start`
   * (thinking / text / tool_use), `content_block_delta` (text/thinking/input
   * deltas), `content_block_stop`, and `message_delta` (usage).
   */
  private async *consume_sse(
    body: ReadableStream<Uint8Array>,
    enc: EncodedToolNames | null,
  ): AsyncIterable<ProviderChunk> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = '';

    // Per-index accumulators for the blocks being streamed.
    const blocks = new Map<number, AccumBlock>();
    let input_tokens: number | undefined;
    let output_tokens: number | undefined;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; data lines start with "data:".
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = parse_sse_data(frame);
          if (!event) continue;

          for (const chunk of this.handle_event(event, blocks, enc)) {
            if (chunk.kind === 'usage') {
              if (chunk.input_tokens !== undefined) input_tokens = chunk.input_tokens;
              if (chunk.output_tokens !== undefined) output_tokens = chunk.output_tokens;
            }
            yield chunk;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { kind: 'done', response: finalize_response(blocks, input_tokens, output_tokens) };
  }

  /** Translate one parsed SSE event object into zero or more ProviderChunks. */
  private *handle_event(
    event: SseEvent,
    blocks: Map<number, AccumBlock>,
    enc: EncodedToolNames | null,
  ): Iterable<ProviderChunk> {
    switch (event.type) {
      case 'content_block_start': {
        const index = event.index ?? 0;
        const cb = event.content_block ?? {};
        if (cb.type === 'tool_use') {
          // Decode the wire tool name back to the original command full name now, so
          // both the streamed tool_call and the assembled response carry `<app>.<cmd>`.
          const rawName = cb.name ?? '';
          const name = enc ? enc.decode(rawName) : rawName;
          blocks.set(index, { type: 'tool_use', id: cb.id ?? '', name, json: '' });
        } else if (cb.type === 'thinking') {
          blocks.set(index, { type: 'thinking', text: '' });
        } else {
          blocks.set(index, { type: 'text', text: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const index = event.index ?? 0;
        const block = blocks.get(index);
        const delta = event.delta ?? {};
        if (!block) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && block.type === 'text') {
          block.text += delta.text;
          yield { kind: 'text', text: delta.text };
        } else if (
          delta.type === 'thinking_delta' &&
          typeof delta.thinking === 'string' &&
          block.type === 'thinking'
        ) {
          block.text += delta.thinking;
          yield { kind: 'thinking', text: delta.thinking };
        } else if (
          delta.type === 'input_json_delta' &&
          typeof delta.partial_json === 'string' &&
          block.type === 'tool_use'
        ) {
          block.json += delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const index = event.index ?? 0;
        const block = blocks.get(index);
        if (block?.type === 'tool_use') {
          yield { kind: 'tool_call', call: tool_call_from(block) };
        }
        break;
      }
      case 'message_start': {
        const usage = event.message?.usage;
        if (usage && typeof usage.input_tokens === 'number') {
          yield { kind: 'usage', input_tokens: usage.input_tokens };
        }
        break;
      }
      case 'message_delta': {
        const usage = event.usage;
        if (usage && typeof usage.output_tokens === 'number') {
          yield { kind: 'usage', output_tokens: usage.output_tokens };
        }
        break;
      }
      default:
        break;
    }
  }
}

// ============================================================================
// Streaming accumulators + helpers
// ============================================================================

type AccumBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; json: string };

interface SseEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  message?: { usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number };
}

/** Reassemble the final Anthropic-shaped content[] for `thinking_adapter`. */
function finalize_response(
  blocks: Map<number, AccumBlock>,
  input_tokens: number | undefined,
  output_tokens: number | undefined,
): ProviderResponse {
  const indices = [...blocks.keys()].sort((a, b) => a - b);
  const content: unknown[] = [];
  for (const i of indices) {
    const block = blocks.get(i)!;
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      content.push({ type: 'thinking', thinking: block.text });
    } else {
      content.push({ type: 'tool_use', id: block.id, name: block.name, input: parse_tool_input(block.json) });
    }
  }
  const response: ProviderResponse = { raw: { content } };
  if (input_tokens !== undefined || output_tokens !== undefined) {
    response.usage = {};
    if (input_tokens !== undefined) response.usage.input_tokens = input_tokens;
    if (output_tokens !== undefined) response.usage.output_tokens = output_tokens;
  }
  return response;
}

function tool_call_from(block: Extract<AccumBlock, { type: 'tool_use' }>): ToolCall {
  return { id: block.id, name: block.name, args: parse_tool_input(block.json) };
}

function parse_tool_input(json: string): unknown {
  if (json.length === 0) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** Normalize a segment's rendered payload into Anthropic content parts. */
function to_content_parts(rendered: string | ContentPart[]): Record<string, unknown>[] {
  if (typeof rendered === 'string') {
    return [{ type: 'text', text: rendered }];
  }
  return rendered.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.value };
    if (part.type === 'image') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.mime_type ?? 'image/png', data: part.value },
      };
    }
    // audio has no first-class Anthropic content type yet → describe it as text.
    return { type: 'text', text: `[audio:${part.mime_type ?? 'unknown'}]` };
  });
}

/** Parse an SSE frame's `data:` payload into an event object; null if not JSON. */
function parse_sse_data(frame: string): SseEvent | null {
  for (const line of frame.split('\n')) {
    const trimmed = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!trimmed) continue;
    if (trimmed === '[DONE]') return null;
    try {
      return JSON.parse(trimmed) as SseEvent;
    } catch {
      return null;
    }
  }
  return null;
}

async function safe_read_text(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
