/**
 * provider/task_create_mock.ts — TaskCreateMockProvider (impl-provider, offline/dry-run only).
 *
 * A CONTEXT-REACTIVE mock provider for the Task WRITE end-to-end vertical (platform Phase D2b).
 * It is the task-vertical sibling of `im_echo_mock.ts`: same "read the rendered prompt each
 * `send`, react to the `im_proxy:chat` window" shape, but instead of echoing the inbound IM
 * message back to IM, it parses a TASK DIRECTIVE out of it and emits a `task_proxy.add`
 * tool_call carrying the directive's title — driving the human → IM → im_proxy → agent →
 * task_proxy → real Task service WRITE path without a real LLM or API key.
 *
 * The directive grammar (deliberately tiny): an inbound IM body of the form
 *   `create task: <title>`
 * (case-insensitive prefix, optional whitespace around the colon). The `<title>` after the
 * colon is forwarded verbatim as the new task's title — so a per-run NONCE in the title proves
 * the agent genuinely READ the human's directive out of its context (a canned `task_proxy.add`
 * could not reproduce a random nonce). A body that is NOT a task directive produces an empty
 * turn (the runtime loop settles) — so the agent's own boot/seed turns, and any non-directive
 * chatter, never spuriously create a task.
 *
 * Why reactive, not a fixed script: identical reasoning to im_echo_mock.ts — the agent wakes on
 * boot/seed and burns turns BEFORE the human's IM directive lands in context, so a fixed N-turn
 * queue would exhaust (and throw) before the directive is ever rendered. Reacting to the prompt
 * makes the mock robust to the turn count and proves the real loop: directive lands in context →
 * agent emits `task_proxy.add` → task_proxy POSTs /task/create on the real Task service.
 *
 * It is a thin wrapper over MockProvider (same capabilities / thinking_adapter / token + cache
 * helpers); only `send` is overridden to compute the turn from the prompt. The commands-only
 * seam is untouched — the create rides a structured tool_call, never text (#13).
 *
 * Contract: import-only from provider/types.js + core/types.js. No IO.
 */

import type { RenderedPrompt } from '../core/types.js';
import type { ProviderChunk, SendOpts, ToolCall } from './types.js';
import { MockProvider, type MockProviderOpts } from './mock.js';

/**
 * Flatten a RenderedPrompt to plain searchable text. Text segments render as strings; structured
 * `ContentPart[]` segments contribute their text parts. The im_proxy:chat block is a text
 * projection, so its lines (`# Chat …`, `[im:<peer>] <body>`) appear verbatim here.
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
 * per message as `[<who>]<maybe @me> <body>`, where `<who>` is `me` for the agent's own turns or
 * `im:<peer>` for an inbound. We return the bodies of the `im:<peer>` lines (inbound only), in
 * order — these are what the agent would act on. (Mirrors im_echo_mock.ts's parser exactly so the
 * two reactive mocks stay in lockstep with the chat block's render shape.)
 */
function inboundChatBodies(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('# Chat'));
  if (start < 0) return [];
  const bodies: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('# ')) break; // next block header → end of the chat window
    const m = /^\[(im:[^\]]+)\](?: @me)? (.*)$/.exec(line);
    if (m) bodies.push(m[2]!);
  }
  return bodies;
}

/**
 * Parse a `create task: <title>` directive out of an inbound body. Returns the trimmed `<title>`
 * (which may carry a per-run nonce) or null if the body is not a task directive. Case-insensitive
 * on the prefix; tolerant of whitespace around the colon. An empty title is treated as no-match.
 */
function parseTaskDirective(body: string): string | null {
  const m = /^\s*create\s+task\s*:\s*(.+\S)\s*$/i.exec(body);
  return m ? m[1]! : null;
}

/**
 * TaskCreateMockProvider — a MockProvider that, instead of a fixed script, computes each turn
 * from the rendered prompt: emit `task_proxy.add` for the newest inbound IM task directive it has
 * not already actioned.
 */
export class TaskCreateMockProvider extends MockProvider {
  /** Titles already actioned (so a directive creates exactly one task — the loop terminates). */
  private readonly actioned = new Set<string>();
  private callSeq = 0;

  constructor(opts: MockProviderOpts = {}) {
    // The base MockProvider needs a script, but we never consume it (we override `send`).
    super([], { id: opts.id ?? 'mock-task-create', ...opts });
  }

  override send(prompt: RenderedPrompt, opts: SendOpts): AsyncIterable<ProviderChunk> {
    this.last_prompt = prompt;
    this.last_opts = opts;
    this.callSeq += 1;

    const text = promptText(prompt);
    const bodies = inboundChatBodies(text);
    // Newest inbound body that is a task directive whose title we have NOT already actioned.
    let title: string | null = null;
    for (const body of [...bodies].reverse()) {
      const t = parseTaskDirective(body);
      if (t !== null && !this.actioned.has(t)) {
        title = t;
        break;
      }
    }

    if (title === null) {
      return emptyTurn();
    }
    this.actioned.add(title);
    const call: ToolCall = {
      id: `task-create-${this.callSeq}`,
      name: 'task_proxy.add',
      args: { title },
    };
    return createTurn(call, title);
  }
}

/** Stream a single create turn (a thought + one task_proxy.add tool_call), then done. */
async function* createTurn(call: ToolCall, title: string): AsyncIterable<ProviderChunk> {
  yield { kind: 'thinking', text: `(task-create mock) creating task: ${title}` };
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
