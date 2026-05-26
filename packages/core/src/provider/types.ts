/**
 * provider/types.ts — CONTRACT FILE (owned by architect; import-only for everyone else)
 *
 * The multi-LLM abstraction: one ModelProvider interface that lets day-1 support
 * both Anthropic and any OpenAI-compatible endpoint (DeepSeek / Ollama / vLLM …),
 * plus the ThinkingAdapter that normalizes each provider's reasoning + tool-call
 * format into the commands-only pipeline.
 *
 * Authoritative design: ai_com/block-agent-architecture-v3.1.md
 *   §4.2–§4.4 LLM output handling + thinking adapter · §11 Provider abstraction
 *
 * House style (§0.5): Provider / ThinkingAdapter are actors → role names, no
 * `Block` prefix.
 *
 * KEY SECURITY INVARIANT (#13, §4.3): commands come ONLY from a response's
 * structured tool-call blocks. `thoughts` (promoted from thinking content) is
 * OPAQUE text and is NEVER parsed for commands. ThinkingAdapter.extract reflects
 * this by separating `tool_calls` (→ commands) from `thoughts` / `raw_text`
 * (→ never commands).
 */

import type { RenderedPrompt } from '../core/types.js';

// ============================================================================
// §11.1 Capabilities + provider response shapes
// ============================================================================

/**
 * ModelCapabilities — what a model can do and how it wants to be driven (§11.1).
 * Drives content fallback (vision/audio), cache translation (cache_control),
 * tool dispatch, and which ThinkingAdapter the runtime attaches.
 */
export interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
  system_prompt_cache: boolean;
  cache_control: 'anthropic' | 'openai' | 'none';
  max_input_tokens: number;
  tool_dispatch: 'native' | 'xml' | 'prompted';
  thinking_format:
    | 'anthropic_blocks'
    | 'openai_reasoning'
    | 'xml_think_tag'
    | 'xml_thinking_tag'
    | 'none';
}

/**
 * ToolCall — a structured tool/command invocation extracted from a model
 * response. This is the ONLY source of commands (INVARIANT #13). `name` is the
 * command's full name `<app_id>.<command>`; `args` is the parsed argument object.
 */
export interface ToolCall {
  /** Provider's id for this call (for matching results back to the call). */
  id: string;
  /** Full command name `<app_id>.<command>`. */
  name: string;
  args: unknown;
}

/**
 * ProviderResponse — the assembled (non-streamed) response a ThinkingAdapter
 * parses. Kept provider-shaped-but-normalized: adapters know how to read the
 * native fields of their provider; the runtime only consumes `extract`'s output.
 */
export interface ProviderResponse {
  /** Provider-native content (Anthropic content[] / OpenAI message), opaque here. */
  raw: unknown;
  /** Token accounting if the provider reported it. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * ProviderChunk — one streamed delta from `send`. The runtime accumulates chunks
 * into a ProviderResponse before handing it to the ThinkingAdapter.
 */
export type ProviderChunk =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'usage'; input_tokens?: number; output_tokens?: number }
  | { kind: 'done'; response: ProviderResponse };

/** Per-call options for send (model knobs that vary per turn). */
export interface SendOpts {
  temperature?: number;
  max_output_tokens?: number;
  /** Tool/command schemas to expose to the model this turn. */
  tools?: Array<{ name: string; description: string; args_schema?: Record<string, unknown> }>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/** A hint about where the provider should place prompt-cache breakpoints (§11.3). */
export interface CacheHint {
  /** Indices into segments that should carry a cache breakpoint. */
  breakpoints: number[];
  /** Provider's max number of cache breakpoints (e.g. Anthropic = 4). */
  max_breakpoints: number;
}

// ============================================================================
// §4.4 ThinkingAdapter — normalize reasoning + tool calls per provider
// ============================================================================

/**
 * ThinkingAdapter — splits a provider response into three streams (§4.4):
 *   - thoughts:    reasoning content → emitted on the UI thinking channel (OPAQUE; #13)
 *   - tool_calls:  structured calls → the ONLY source of commands
 *   - raw_text:    plain assistant text → held for commands-only REJECTION (§4.2)
 *
 * Implementations: AnthropicThinkingAdapter (content[] type=thinking/tool_use/text),
 * OpenAIReasoningAdapter (reasoning_content / tool_calls / content),
 * XmlTagThinkingAdapter (<think>/<thinking> regex). All live in provider/thinking.ts.
 */
export interface ThinkingAdapter {
  extract(response: ProviderResponse): {
    thoughts: string[];
    tool_calls: ToolCall[];
    raw_text: string;
  };
}

// ============================================================================
// §11.1 ModelProvider
// ============================================================================

/**
 * ModelProvider — the transfer-head for one LLM backend (§11.1). `send` streams
 * chunks; the runtime assembles them and uses `thinking_adapter` to extract
 * commands. `cache_hint` translates the renderer's tier boundaries into the
 * provider's cache-control dialect (§11.3).
 */
export interface ModelProvider {
  /** e.g. `anthropic` | `openai-compat:openai` | `mock`. */
  readonly id: string;
  readonly capabilities: ModelCapabilities;

  send(prompt: RenderedPrompt, opts: SendOpts): AsyncIterable<ProviderChunk>;
  estimateTokens(text: string): number;
  cache_hint(segments: RenderedPrompt['segments']): CacheHint;

  /** The adapter matching this provider's thinking_format (§4.3). */
  readonly thinking_adapter: ThinkingAdapter;
}
