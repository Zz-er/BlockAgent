/**
 * provider/mock.ts — MockProvider (impl-provider).
 *
 * A scripted, fully-deterministic ModelProvider used to drive the runtime loop in
 * tests. It does no IO. Construct it with a queue of canned turns; each `send`
 * dequeues the next turn and streams its chunks (thinking / tool_call / text), in
 * order, terminating with a `usage` chunk (if any) and a `done` chunk carrying an
 * assembled ProviderResponse.
 *
 * The ProviderResponse it emits is shaped for AnthropicThinkingAdapter
 * (`raw.content[]` with type=thinking/tool_use/text), so a test can run the full
 * pipeline mock → adapter → runtime without a real backend. Override
 * `thinking_adapter` / `capabilities` via the constructor opts to exercise other
 * adapters.
 *
 * Contract: import-only from provider/types.js + core/types.js.
 */

import type { RenderedPrompt } from '../core/types.js';
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

/**
 * MockTurn — the script for one `send` call. Fields are emitted in the order
 * thinking → tool_calls → text, then usage, then done. All optional so a turn can
 * be e.g. "just two tool calls" or "plain text only" (to exercise the
 * commands-only rejection path).
 */
export interface MockTurn {
  thinking?: string[];
  tool_calls?: ToolCall[];
  text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Construction options for MockProvider; all have deterministic defaults. */
export interface MockProviderOpts {
  /** Override the default id (`mock`). */
  id?: string;
  /** Override capabilities (defaults to a permissive anthropic-blocks profile). */
  capabilities?: Partial<ModelCapabilities>;
  /** Override the adapter (defaults to AnthropicThinkingAdapter). */
  thinking_adapter?: ThinkingAdapter;
  /**
   * Tokens-per-char divisor for `estimateTokens` (default 4 → ~4 chars/token).
   * A fixed ratio keeps estimates deterministic.
   */
  chars_per_token?: number;
  /** Provider's max cache breakpoints, surfaced via `cache_hint` (default 4). */
  max_breakpoints?: number;
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

export class MockProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  readonly thinking_adapter: ThinkingAdapter;

  private readonly script: MockTurn[];
  private cursor = 0;
  private readonly chars_per_token: number;
  private readonly max_breakpoints: number;

  /** Last prompt passed to `send`, exposed so tests can assert what was sent. */
  last_prompt: RenderedPrompt | null = null;
  /** Last opts passed to `send`. */
  last_opts: SendOpts | null = null;

  constructor(script: MockTurn[], opts: MockProviderOpts = {}) {
    this.script = script;
    this.id = opts.id ?? 'mock';
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
    this.thinking_adapter = opts.thinking_adapter ?? new AnthropicThinkingAdapter();
    this.chars_per_token = opts.chars_per_token ?? 4;
    this.max_breakpoints = opts.max_breakpoints ?? 4;
  }

  /** Turns already consumed — lets a test assert the loop ran N turns. */
  get turns_consumed(): number {
    return this.cursor;
  }

  send(prompt: RenderedPrompt, opts: SendOpts): AsyncIterable<ProviderChunk> {
    this.last_prompt = prompt;
    this.last_opts = opts;

    if (this.cursor >= this.script.length) {
      throw new Error(
        `MockProvider script exhausted: send() called ${this.cursor + 1} times but only ` +
          `${this.script.length} turn(s) were scripted.`,
      );
    }
    const turn = this.script[this.cursor]!;
    this.cursor += 1;

    return stream_turn(turn);
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / this.chars_per_token);
  }

  cache_hint(segments: RenderedPrompt['segments']): CacheHint {
    const breakpoints: number[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i]!.cache_boundary) breakpoints.push(i);
    }
    return { breakpoints, max_breakpoints: this.max_breakpoints };
  }
}

/**
 * Stream a single turn as the canonical chunk order, then assemble an
 * Anthropic-shaped ProviderResponse for the terminating `done` chunk. Kept as a
 * free async generator so `send` itself can stay synchronous up to validation.
 */
async function* stream_turn(turn: MockTurn): AsyncIterable<ProviderChunk> {
  for (const thought of turn.thinking ?? []) {
    yield { kind: 'thinking', text: thought };
  }
  for (const call of turn.tool_calls ?? []) {
    yield { kind: 'tool_call', call };
  }
  if (turn.text !== undefined) {
    yield { kind: 'text', text: turn.text };
  }
  if (turn.usage) {
    // turn.usage is already typed `{ input_tokens?: number; output_tokens?: number }`,
    // so spreading it forwards present fields and keeps absent ones absent
    // (satisfies exactOptionalPropertyTypes without writing `undefined`).
    yield { kind: 'usage', ...turn.usage };
  }

  yield { kind: 'done', response: assemble_response(turn) };
}

/** Build an Anthropic-`content[]`-shaped ProviderResponse mirroring the turn. */
function assemble_response(turn: MockTurn): ProviderResponse {
  const content: unknown[] = [];
  for (const thought of turn.thinking ?? []) {
    content.push({ type: 'thinking', thinking: thought });
  }
  for (const call of turn.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
  }
  if (turn.text !== undefined) {
    content.push({ type: 'text', text: turn.text });
  }

  const response: ProviderResponse = { raw: { content } };
  if (turn.usage) response.usage = turn.usage;
  return response;
}
