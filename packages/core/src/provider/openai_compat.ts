/**
 * provider/openai_compat.ts — OpenAiCompatibleProvider (impl-provider).
 *
 * One provider that unifies every OpenAI-compatible chat-completions endpoint:
 * OpenAI official, DeepSeek, Ollama, LM Studio, vLLM (§11.2). Construct with
 * `{ base_url, model, api_key?, thinking_format }`; the thinking_format selects the
 * matching ThinkingAdapter (§4.4):
 *   - openai_reasoning              → OpenAIReasoningAdapter (o1/o3 reasoning_content)
 *   - xml_think_tag / xml_thinking_tag → XmlTagThinkingAdapter (DeepSeek-R1 <think>)
 *   - none                          → OpenAIReasoningAdapter (no reasoning, tool_calls only)
 *
 * cache_control dialect (§11.3): these endpoints have no explicit cache_control.
 * OpenAI official relies on automatic prefix caching; DeepSeek-style endpoints get
 * inline `<!-- segment:<tier> -->` marker hints at each cache boundary. Either way
 * a stable prefix is what matters, so the renderer's tier ordering does the work.
 *
 * Streams the SSE chat-completions delta format. No api_key where the endpoint
 * requires one → `send` throws before any network call. Contract: import-only from
 * provider/types.js + core/types.js.
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
import { OpenAIReasoningAdapter, XmlTagThinkingAdapter } from './thinking.js';

type ThinkingFormat = ModelCapabilities['thinking_format'];

export interface OpenAiCompatibleProviderOpts {
  base_url: string;
  model: string;
  api_key?: string;
  /** Drives adapter selection + capability defaults. */
  thinking_format: ThinkingFormat;
  /** Override the derived id (`openai-compat:<host>`). */
  id?: string;
  /** Capability overrides merged onto the derived defaults. */
  capabilities?: Partial<ModelCapabilities>;
  /** Emit `<!-- segment:<tier> -->` cache marker hints (DeepSeek-style). Default off. */
  emit_cache_markers?: boolean;
  default_max_output_tokens?: number;
  /** Injectable fetch for tests; defaults to global `fetch`. */
  fetch_impl?: typeof fetch;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  readonly thinking_adapter: ThinkingAdapter;

  private readonly base_url: string;
  private readonly model: string;
  private readonly api_key: string | undefined;
  private readonly emit_cache_markers: boolean;
  private readonly default_max_output_tokens: number;
  private readonly fetch_impl: typeof fetch;

  constructor(opts: OpenAiCompatibleProviderOpts) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.model = opts.model;
    this.api_key = opts.api_key;
    this.emit_cache_markers = opts.emit_cache_markers ?? false;
    this.default_max_output_tokens = opts.default_max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.fetch_impl = opts.fetch_impl ?? globalThis.fetch;

    this.id = opts.id ?? `openai-compat:${derive_host(this.base_url)}`;
    this.thinking_adapter = select_adapter(opts.thinking_format);
    this.capabilities = {
      ...default_capabilities(opts.thinking_format),
      ...opts.capabilities,
    };
  }

  send(prompt: RenderedPrompt, opts: SendOpts): AsyncIterable<ProviderChunk> {
    if (typeof this.fetch_impl !== 'function') {
      throw new Error('OpenAiCompatibleProvider: no fetch implementation available (pass fetch_impl).');
    }
    return this.stream(prompt, opts);
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  cache_hint(segments: RenderedPrompt['segments']): CacheHint {
    // No explicit breakpoints for OpenAI-compatible endpoints; report the
    // boundaries the renderer marked so callers can still inspect them, but
    // max_breakpoints=0 signals "control is implicit / prefix-based" (§11.3).
    const breakpoints: number[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i]!.cache_boundary) breakpoints.push(i);
    }
    return { breakpoints, max_breakpoints: 0 };
  }

  private async *stream(prompt: RenderedPrompt, opts: SendOpts): AsyncIterable<ProviderChunk> {
    const body = this.build_request_body(prompt, opts);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.api_key) headers['authorization'] = `Bearer ${this.api_key}`;

    const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body) };
    if (opts.signal) init.signal = opts.signal;

    const res = await this.fetch_impl(`${this.base_url}/chat/completions`, init);
    if (!res.ok || !res.body) {
      const detail = await safe_read_text(res);
      throw new Error(
        `OpenAiCompatibleProvider: request failed (${res.status} ${res.statusText}) ${detail}`,
      );
    }

    yield* this.consume_sse(res.body);
  }

  private build_request_body(prompt: RenderedPrompt, opts: SendOpts): Record<string, unknown> {
    const content = this.render_user_content(prompt);
    const body: Record<string, unknown> = {
      model: this.model,
      stream: true,
      // stream_options.include_usage asks OpenAI to emit a final usage chunk.
      stream_options: { include_usage: true },
      max_tokens: opts.max_output_tokens ?? this.default_max_output_tokens,
      messages: [{ role: 'user', content }],
    };
    if (opts.temperature !== undefined) body['temperature'] = opts.temperature;
    if (opts.tools && opts.tools.length > 0) {
      body['tools'] = opts.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.args_schema ?? { type: 'object', properties: {} },
        },
      }));
    }
    return body;
  }

  /**
   * Render segments into the chat message `content`. When all parts are text we
   * collapse to a single string (the broadest-compatible form across endpoints);
   * if any non-text part exists we emit the structured parts array. Cache markers
   * are interleaved as text when enabled.
   */
  private render_user_content(prompt: RenderedPrompt): string | unknown[] {
    const parts: ContentPart[] = [];
    for (const segment of prompt.segments) {
      if (this.emit_cache_markers && segment.cache_boundary) {
        parts.push({ type: 'text', value: `<!-- segment:${segment.tier} -->` });
      }
      if (typeof segment.rendered === 'string') {
        parts.push({ type: 'text', value: segment.rendered });
      } else {
        parts.push(...segment.rendered);
      }
    }

    const all_text = parts.every((p) => p.type === 'text');
    if (all_text) {
      return parts.map((p) => p.value).join('');
    }
    return parts.map(to_openai_content_part);
  }

  /**
   * Parse the OpenAI SSE chat-completions delta stream into ProviderChunks while
   * reassembling a `choices[0].message`-shaped response for `thinking_adapter`.
   * Tool-call fragments arrive incrementally keyed by index; we stitch them.
   */
  private async *consume_sse(body: ReadableStream<Uint8Array>): AsyncIterable<ProviderChunk> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = '';

    let content = '';
    let reasoning = '';
    const tool_fragments = new Map<number, { id: string; name: string; args: string }>();
    let input_tokens: number | undefined;
    let output_tokens: number | undefined;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = parse_sse_data(frame);
          if (!event) continue;

          const usage = event.usage;
          if (usage) {
            if (typeof usage.prompt_tokens === 'number') input_tokens = usage.prompt_tokens;
            if (typeof usage.completion_tokens === 'number') output_tokens = usage.completion_tokens;
            yield {
              kind: 'usage',
              ...(input_tokens !== undefined ? { input_tokens } : {}),
              ...(output_tokens !== undefined ? { output_tokens } : {}),
            };
          }

          const delta = event.choices?.[0]?.delta;
          if (!delta) continue;

          if (typeof delta.reasoning_content === 'string') {
            reasoning += delta.reasoning_content;
            yield { kind: 'thinking', text: delta.reasoning_content };
          }
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            content += delta.content;
            yield { kind: 'text', text: delta.content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const frag = tool_fragments.get(idx) ?? { id: '', name: '', args: '' };
              if (typeof tc.id === 'string') frag.id = tc.id;
              if (typeof tc.function?.name === 'string') frag.name = tc.function.name;
              if (typeof tc.function?.arguments === 'string') frag.args += tc.function.arguments;
              tool_fragments.set(idx, frag);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit assembled tool_call chunks once their fragments are complete.
    const ordered = [...tool_fragments.keys()].sort((a, b) => a - b);
    const tool_calls: ToolCall[] = [];
    for (const idx of ordered) {
      const frag = tool_fragments.get(idx)!;
      if (frag.name.length === 0) continue;
      const call: ToolCall = { id: frag.id, name: frag.name, args: parse_args(frag.args) };
      tool_calls.push(call);
      yield { kind: 'tool_call', call };
    }

    yield {
      kind: 'done',
      response: finalize_response(content, reasoning, tool_calls, input_tokens, output_tokens),
    };
  }
}

// ============================================================================
// Adapter / capability selection
// ============================================================================

function select_adapter(format: ThinkingFormat): ThinkingAdapter {
  switch (format) {
    case 'xml_think_tag':
    case 'xml_thinking_tag':
      return new XmlTagThinkingAdapter();
    case 'openai_reasoning':
    case 'none':
    case 'anthropic_blocks':
    default:
      // anthropic_blocks is not expected on an OpenAI-compatible endpoint; fall
      // back to the reasoning adapter (reads tool_calls + content regardless).
      return new OpenAIReasoningAdapter();
  }
}

function default_capabilities(format: ThinkingFormat): ModelCapabilities {
  return {
    vision: false,
    audio: false,
    system_prompt_cache: true,
    cache_control: 'openai',
    max_input_tokens: 128_000,
    tool_dispatch: 'native',
    thinking_format: format,
  };
}

// ============================================================================
// SSE parsing + response assembly
// ============================================================================

interface OpenAiSseEvent {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function finalize_response(
  content: string,
  reasoning: string,
  tool_calls: ToolCall[],
  input_tokens: number | undefined,
  output_tokens: number | undefined,
): ProviderResponse {
  const message: Record<string, unknown> = { role: 'assistant', content: content.length > 0 ? content : null };
  if (reasoning.length > 0) message['reasoning_content'] = reasoning;
  if (tool_calls.length > 0) {
    message['tool_calls'] = tool_calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
    }));
  }

  const response: ProviderResponse = { raw: { choices: [{ message }] } };
  if (input_tokens !== undefined || output_tokens !== undefined) {
    response.usage = {};
    if (input_tokens !== undefined) response.usage.input_tokens = input_tokens;
    if (output_tokens !== undefined) response.usage.output_tokens = output_tokens;
  }
  return response;
}

function parse_args(raw: string): unknown {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function to_openai_content_part(part: ContentPart): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', text: part.value };
  if (part.type === 'image') {
    // OpenAI vision wants a data/URL string; pass the value through as a URL.
    return { type: 'image_url', image_url: { url: part.value } };
  }
  // audio: not universally supported → degrade to a textual marker.
  return { type: 'text', text: `[audio:${part.mime_type ?? 'unknown'}]` };
}

function parse_sse_data(frame: string): OpenAiSseEvent | null {
  for (const line of frame.split('\n')) {
    const trimmed = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!trimmed) continue;
    if (trimmed === '[DONE]') return null;
    try {
      return JSON.parse(trimmed) as OpenAiSseEvent;
    } catch {
      return null;
    }
  }
  return null;
}

function derive_host(base_url: string): string {
  try {
    return new URL(base_url).host;
  } catch {
    return base_url;
  }
}

async function safe_read_text(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
