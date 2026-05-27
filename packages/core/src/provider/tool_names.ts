/**
 * provider/tool_names.ts — wire-safe tool-name encoding (shared by native-dispatch providers).
 *
 * block-agent command full names use a DOT separator: `<app_id>.<command>` (e.g.
 * `messages.reply`). But native tool-dispatch APIs constrain the tool/function NAME to
 * `^[a-zA-Z0-9_-]+$` — Anthropic and OpenAI/DeepSeek both reject a `.`. So a provider
 * must send a sanitized name on the wire and map the model's tool_call name back to the
 * original command full name before the runtime routes it through invoke_command (the
 * runtime + registry keep using dotted names throughout; only the wire form is encoded).
 *
 * `encodeToolNames` sanitizes each name (every char outside the allowed class → `_`) and
 * guarantees uniqueness (disambiguating collisions with a numeric suffix), returning the
 * parallel wire names plus a `decode` that reverses the mapping. Decode falls back to the
 * input for an unknown name (e.g. a model hallucinating a tool), so a bogus call still
 * reaches invoke_command and is refused there rather than silently dropped.
 */

/** The tool-name character class both Anthropic and OpenAI accept. */
const ALLOWED = /[^a-zA-Z0-9_-]/g;

/** Sanitize one name to the allowed class; empty input degrades to `tool`. */
function sanitize(name: string): string {
  const cleaned = name.replace(ALLOWED, '_');
  return cleaned.length > 0 ? cleaned : 'tool';
}

export interface EncodedToolNames {
  /** Wire-safe name for originals[i], in the same order as the input. */
  wire: string[];
  /** Map a tool_call's wire name back to the original command full name. */
  decode(wireName: string): string;
}

/**
 * encodeToolNames — produce wire-safe, unique tool names for a list of command full
 * names, plus the reverse map. Stable + deterministic: same input order → same output.
 */
export function encodeToolNames(originals: readonly string[]): EncodedToolNames {
  const wire: string[] = [];
  const reverse = new Map<string, string>();
  const used = new Set<string>();

  for (const original of originals) {
    const base = sanitize(original);
    let candidate = base;
    let n = 2;
    // Disambiguate a collision (two originals sanitizing to the same wire name).
    while (used.has(candidate)) {
      candidate = `${base}_${n}`;
      n += 1;
    }
    used.add(candidate);
    reverse.set(candidate, original);
    wire.push(candidate);
  }

  return {
    wire,
    decode: (wireName: string): string => reverse.get(wireName) ?? wireName,
  };
}
