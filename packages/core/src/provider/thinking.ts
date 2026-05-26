/**
 * provider/thinking.ts — the three ThinkingAdapters (impl-provider).
 *
 * Each adapter reads ONE provider's native response shape and splits it into the
 * three streams the runtime consumes (§4.4):
 *   - thoughts:    reasoning content → emitted on the UI thinking channel (OPAQUE; #13)
 *   - tool_calls:  structured calls → the ONLY source of commands
 *   - raw_text:    plain assistant text → held for commands-only REJECTION (§4.2)
 *
 * SECURITY INVARIANT #13 (§4.3): thoughts and raw_text are NEVER scanned for
 * commands. These adapters enforce the seam structurally — command-bearing data
 * only ever flows into `tool_calls`, which each adapter populates ONLY from a
 * provider's structured tool-call fields, never from any text field.
 *
 * Contract: import-only from provider/types.js.
 */

import type { ProviderResponse, ThinkingAdapter, ToolCall } from './types.js';

/** Shape returned by every adapter — re-derived from the contract for brevity. */
type Extracted = ReturnType<ThinkingAdapter['extract']>;

// ============================================================================
// Anthropic — content[] with type=thinking / tool_use / text
// ============================================================================

/** One element of an Anthropic `content[]` array (the fields we read). */
interface AnthropicContentBlock {
  type: string;
  /** type='thinking' (extended thinking). */
  thinking?: string;
  /** type='redacted_thinking' carries an opaque `data` blob. */
  data?: string;
  /** type='text'. */
  text?: string;
  /** type='tool_use'. */
  id?: string;
  name?: string;
  input?: unknown;
}

/**
 * AnthropicThinkingAdapter — reads `response.raw.content[]` (Anthropic Messages
 * API). thinking → thoughts, tool_use → tool_calls, text → raw_text.
 */
export class AnthropicThinkingAdapter implements ThinkingAdapter {
  extract(response: ProviderResponse): Extracted {
    const thoughts: string[] = [];
    const tool_calls: ToolCall[] = [];
    const text_parts: string[] = [];

    for (const block of read_content_array(response.raw)) {
      const b = block as AnthropicContentBlock;
      switch (b.type) {
        case 'thinking':
          if (typeof b.thinking === 'string') thoughts.push(b.thinking);
          break;
        case 'redacted_thinking':
          // Opaque encrypted reasoning — preserve as a thought so the next turn
          // can pass it back, but it is never inspected for commands.
          if (typeof b.data === 'string') thoughts.push(b.data);
          break;
        case 'tool_use':
          if (typeof b.name === 'string') {
            tool_calls.push({
              id: typeof b.id === 'string' ? b.id : '',
              name: b.name,
              args: b.input ?? {},
            });
          }
          break;
        case 'text':
          if (typeof b.text === 'string') text_parts.push(b.text);
          break;
        default:
          // Unknown block types are ignored — they never become commands.
          break;
      }
    }

    return { thoughts, tool_calls, raw_text: text_parts.join('') };
  }
}

// ============================================================================
// OpenAI — choices[0].message.{reasoning_content, tool_calls, content}
// ============================================================================

/** The OpenAI assistant message fields we read. */
interface OpenAiMessage {
  reasoning_content?: string | null;
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/**
 * OpenAIReasoningAdapter — reads `response.raw.choices[0].message`. reasoning_content
 * → thoughts, tool_calls → tool_calls (arguments is a JSON string, parsed here),
 * content → raw_text.
 */
export class OpenAIReasoningAdapter implements ThinkingAdapter {
  extract(response: ProviderResponse): Extracted {
    const thoughts: string[] = [];
    const tool_calls: ToolCall[] = [];
    let raw_text = '';

    const message = read_first_choice_message(response.raw);
    if (message) {
      const m = message as OpenAiMessage;
      if (typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) {
        thoughts.push(m.reasoning_content);
      }
      if (typeof m.content === 'string') raw_text = m.content;
      if (Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          const name = call.function?.name;
          if (typeof name === 'string') {
            tool_calls.push({
              id: typeof call.id === 'string' ? call.id : '',
              name,
              args: parse_json_args(call.function?.arguments),
            });
          }
        }
      }
    }

    return { thoughts, tool_calls, raw_text };
  }
}

// ============================================================================
// XML tag — <think> / <thinking> regex over the message text
// ============================================================================

// Matches both <think>…</think> and <thinking>…</thinking> (case-insensitive,
// dot-matches-newline). The tag name is back-referenced so open/close must agree.
const THINK_TAG_RE = /<(think|thinking)>([\s\S]*?)<\/\1>/gi;

/**
 * XmlTagThinkingAdapter — for endpoints (DeepSeek-R1, some Ollama models) that
 * emit reasoning inline as `<think>…</think>` or `<thinking>…</thinking>` in the
 * text. Tag bodies → thoughts; everything else → raw_text. tool_calls comes ONLY
 * from a structured `tool_calls` field if the endpoint provides one — NEVER from
 * the parsed tag bodies (#13).
 */
export class XmlTagThinkingAdapter implements ThinkingAdapter {
  extract(response: ProviderResponse): Extracted {
    const thoughts: string[] = [];
    const tool_calls: ToolCall[] = [];

    const message = read_first_choice_message(response.raw);
    const m = (message ?? {}) as OpenAiMessage;

    // Structured tool calls (if the OpenAI-compatible endpoint reports them).
    if (Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const name = call.function?.name;
        if (typeof name === 'string') {
          tool_calls.push({
            id: typeof call.id === 'string' ? call.id : '',
            name,
            args: parse_json_args(call.function?.arguments),
          });
        }
      }
    }

    const source = typeof m.content === 'string' ? m.content : '';
    let raw_text = '';
    let cursor = 0;
    for (const match of source.matchAll(THINK_TAG_RE)) {
      const body = match[2] ?? '';
      thoughts.push(body);
      raw_text += source.slice(cursor, match.index);
      cursor = match.index + match[0].length;
    }
    raw_text += source.slice(cursor);

    return { thoughts, tool_calls, raw_text };
  }
}

// ============================================================================
// Shared readers — defensive navigation of opaque `raw`
// ============================================================================

/** Read an Anthropic-style `content[]` array off an opaque response body. */
function read_content_array(raw: unknown): readonly unknown[] {
  if (raw && typeof raw === 'object' && 'content' in raw) {
    const content = (raw as { content: unknown }).content;
    if (Array.isArray(content)) return content;
  }
  return [];
}

/** Read `choices[0].message` off an opaque OpenAI-style response body. */
function read_first_choice_message(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'choices' in raw) {
    const choices = (raw as { choices: unknown }).choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0];
      if (first && typeof first === 'object' && 'message' in first) {
        return (first as { message: unknown }).message;
      }
    }
  }
  return null;
}

/** OpenAI tool-call arguments arrive as a JSON string; parse defensively. */
function parse_json_args(raw: string | undefined): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Malformed arguments stay as the raw string rather than throwing — the
    // command layer validates args against the schema and will reject it.
    return raw;
  }
}
