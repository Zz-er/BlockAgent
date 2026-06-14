/**
 * provider/im_echo_mock.ts — ImEchoMockProvider (impl-provider, offline/dry-run only).
 *
 * A CONTEXT-REACTIVE mock provider for the IM end-to-end vertical (platform Phase D1). Unlike
 * the fixed-script `MockProvider` (a canned queue of turns), this provider READS the rendered
 * prompt each `send` and reacts to what it finds: if the `im_proxy:chat` block carries an
 * inbound peer message it has not yet answered, it emits an `im_proxy.reply` tool_call echoing
 * that message; otherwise it emits an empty turn (no commands → the runtime loop settles).
 *
 * Why reactive, not a fixed script: the agent wakes on boot/seed and burns turns BEFORE the
 * human's IM message arrives, so a fixed N-turn queue would exhaust (and throw) before the
 * message is ever in context. Reacting to the rendered prompt makes the mock robust to the
 * turn count and proves the real loop: inbound message lands in context → agent emits a reply
 * command → im_proxy forwards it to the IM service. This is the no-key, no-LLM stand-in that
 * exercises the context→command closed loop end-to-end.
 *
 * It is a thin wrapper over MockProvider: it owns the same capabilities / thinking_adapter /
 * token + cache helpers, and only overrides `send` to compute the turn from the prompt. The
 * commands-only seam is untouched — the reply rides a structured tool_call, never text (#13).
 *
 * Contract: import-only from provider/types.js + core/types.js. No IO.
 */

import type { RenderedPrompt } from '../core/types.js';
import type { ProviderChunk, SendOpts, ToolCall } from './types.js';
import { MockProvider, type MockProviderOpts } from './mock.js';

/**
 * Flatten a RenderedPrompt to plain searchable text. Text segments render as strings;
 * structured `ContentPart[]` segments contribute their text parts. The im_proxy:chat block
 * is a text projection, so its lines (`# Chat …`, `[im:<peer>] <body>`) appear verbatim here.
 */
function promptText(prompt: RenderedPrompt): string {
  const parts: string[] = [];
  for (const seg of prompt.segments) {
    if (typeof seg.rendered === 'string') {
      parts.push(seg.rendered);
    } else {
      for (const cp of seg.rendered) {
        if (cp.type === 'text') parts.push(cp.value);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Pull the inbound message bodies out of the `im_proxy:chat` block. The block renders one line
 * per message as `[<who>]<maybe @me> <body>`, where `<who>` is `me` for the agent's own turns
 * or `im:<peer>` for an inbound. We return the bodies of the `im:<peer>` lines (inbound only),
 * in order — these are what the agent would answer.
 */
function inboundChatBodies(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('# Chat'));
  if (start < 0) return [];
  const bodies: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('# ')) break; // next block header → end of the chat window
    // `[me] …` is the agent's own message; `[im:<peer>] …` is inbound. Skip own + non-message lines.
    const m = /^\[(im:[^\]]+)\](?: @me)? (.*)$/.exec(line);
    if (m) bodies.push(m[2]!);
  }
  return bodies;
}

/** The reply body for an inbound message — a deterministic echo (the proof token). */
function echoOf(body: string): string {
  return `echo: ${body}`;
}

/**
 * ImEchoMockProvider — a MockProvider that, instead of a fixed script, computes each turn from
 * the rendered prompt: reply to the newest inbound IM message it has not already echoed.
 */
export class ImEchoMockProvider extends MockProvider {
  /** Bodies already echoed (so a message is answered exactly once — the loop terminates). */
  private readonly answered = new Set<string>();
  private callSeq = 0;

  constructor(opts: MockProviderOpts = {}) {
    // The base MockProvider needs a script, but we never consume it (we override `send`).
    super([], { id: opts.id ?? 'mock-im-echo', ...opts });
  }

  override send(prompt: RenderedPrompt, opts: SendOpts): AsyncIterable<ProviderChunk> {
    this.last_prompt = prompt;
    this.last_opts = opts;
    this.callSeq += 1;

    const text = promptText(prompt);
    const bodies = inboundChatBodies(text);
    // The newest inbound message whose echo is NOT already in the window and that we have not
    // answered this session. `echoOf(b)` appearing as an inbound line would mean a re-fed echo,
    // which we never re-answer (defends against an echo-of-echo loop too).
    const target = [...bodies]
      .reverse()
      .find((b) => !this.answered.has(b) && !b.startsWith('echo: ') && !bodies.includes(echoOf(b)));

    if (target === undefined) {
      return emptyTurn();
    }
    this.answered.add(target);
    const call: ToolCall = {
      id: `im-echo-${this.callSeq}`,
      name: 'im_proxy.reply',
      args: { body: echoOf(target) },
    };
    return replyTurn(call, target);
  }
}

/** Stream a single reply turn (a thought + one im_proxy.reply tool_call), then done. */
async function* replyTurn(call: ToolCall, target: string): AsyncIterable<ProviderChunk> {
  yield { kind: 'thinking', text: `(im-echo mock) replying to: ${target}` };
  yield { kind: 'tool_call', call };
  yield {
    kind: 'done',
    response: { raw: { content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.args }] } },
  };
}

/** Stream an empty turn (no commands → the runtime loop settles to idle). */
async function* emptyTurn(): AsyncIterable<ProviderChunk> {
  yield { kind: 'done', response: { raw: { content: [] } } };
}
