/**
 * provider/oa_resolve_mock.ts — OaResolveMockProvider (impl-provider, offline/dry-run only).
 *
 * A CONTEXT-REACTIVE mock provider for the OA NAME-RESOLUTION end-to-end vertical (platform
 * Phase D2c). It is the OA sibling of `im_echo_mock.ts` / `task_create_mock.ts`: same "read the
 * rendered prompt each `send`, react to the `im_proxy:chat` window" shape — but instead of a bare
 * echo, it RESOLVES the message sender's real ORG DISPLAY NAME (sourced from the OA service) and
 * folds it into the reply.
 *
 * RESOLUTION DESIGN (team-lead ruling "方案 A" — read the directory, refuse the label):
 *   1. From the `im_proxy:chat` block, take the newest inbound `[im:<label>] <body>` line. The
 *      `<label>` is im_proxy's SANITIZED label for the sender's principal_id (`im:` + sanitize);
 *      `<body>` carries the human's per-run message nonce.
 *   2. From the `oa_proxy:directory` (`# Organization`) block — oa_proxy's projection of the LIVE
 *      OA service — parse each member line `… [<principal_id>]` into (display-name, principal_id).
 *      oa_proxy renders the principal_id as the trailing `[…]` join key for exactly this purpose.
 *   3. MATCH the chat label to a directory member by principal_id (compare `im:<principal_id>`
 *      against the chat label). The matched member's DISPLAY NAME is the resolved name.
 *   4. Reply `resolved: <display-name> | <body>` ONLY when the directory yields a name. If the
 *      sender is NOT in the directory (OA not reached / not yet folded), the mock does NOT fall
 *      back to the `im:<label>` — it emits an empty turn and waits. This is the load-bearing
 *      anti-false-green: a reply carrying a real OA display name can ONLY come from oa_proxy having
 *      pulled the live OA directory into context. (team-lead: 宁可测试红、不假绿.)
 *
 * Why read the DIRECTORY block, not the dm chat header: IM has no DM primitive (every conversation
 * is a group), and im_proxy's bootstrap pins a member's display to the non-empty `im:<peer>` label
 * when the directory is missing and never re-resolves — so reading the header could go green on a
 * bare label without OA. Reading the `# Organization` block (which only carries a real name when OA
 * was reached) and refusing the label closes that false-green hole and gives a direct evidence chain.
 *
 * SECURITY (load-bearing): the resolved display name is CONTENT, not authority. The principal_id is
 * the token-pinned authority at the service boundary (auth.ts derives `from`/`owner` from the
 * bearer, never the body); the directory `[<principal_id>]` tag is the authoritative JOIN KEY, the
 * display name is mere content the agent surfaces. A display name never becomes ctx.identity.
 *
 * Selection (launch.ts buildProviderOrThrow, EXPLICIT conjunction): chosen only when im_proxy AND
 * oa_proxy are BOTH enabled (and NOT task_proxy — the more specific im&&task vertical wins first).
 * Without oa_proxy there is no `# Organization` block to resolve against, so the config falls
 * through to the plain im-echo mock — mirroring task_create_mock's im&&task guard.
 *
 * Why reactive, not a fixed script: identical reasoning to the sibling mocks — the agent wakes on
 * boot/seed and burns turns BEFORE the human's IM message lands in context (and before oa_proxy
 * folds the directory), so a fixed queue would exhaust. Reacting to the prompt makes the mock robust
 * to the turn count and proves the real loop.
 *
 * It is a thin wrapper over MockProvider; only `send` is overridden. The commands-only seam is
 * untouched — the reply rides a structured `im_proxy.reply` tool_call, never text (#13).
 *
 * Contract: import-only from provider/types.js + core/types.js. No IO.
 */

import type { RenderedPrompt } from '../core/types.js';
import type { ProviderChunk, SendOpts, ToolCall } from './types.js';
import { MockProvider, type MockProviderOpts } from './mock.js';

/**
 * Flatten a RenderedPrompt to plain searchable text. Text segments render as strings; structured
 * `ContentPart[]` segments contribute their text parts. Both the `im_proxy:chat` block and the
 * `oa_proxy:directory` (`# Organization`) block are text projections, so their lines appear here.
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

/** One inbound chat message: the sender's sanitized `im:<label>` and the message body. */
interface InboundMessage {
  label: string;
  body: string;
}

/**
 * Pull the inbound messages out of the `im_proxy:chat` block. The block renders one line per message
 * as `[<who>]<maybe @me> <body>`, where `<who>` is `me` for the agent's own turns or `im:<label>`
 * for an inbound. We return the `{label, body}` of the `im:<label>` lines (inbound only), in order.
 */
function inboundMessages(text: string): InboundMessage[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('# Chat'));
  if (start < 0) return [];
  const out: InboundMessage[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('# ')) break; // next block header → end of the chat window
    const m = /^\[(im:[^\]]+)\](?: @me)? (.*)$/.exec(line);
    if (m) out.push({ label: m[1]!, body: m[2]! });
  }
  return out;
}

/**
 * Index the `# Organization` (oa_proxy:directory) block by principal_id → display name. Each member
 * line is `- <display> (<kind>)[ — <meta>] [<principal_id>]`; we read the trailing `[<principal_id>]`
 * join tag and the leading `- <display> (` display name. Lines without the tag are skipped (the
 * directory must carry the principal_id for resolution — that is the whole point of method A).
 */
function directoryIndex(text: string): Map<string, string> {
  const index = new Map<string, string>();
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === '# Organization');
  if (start < 0) return index;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('# ')) break; // next block header → end of the org block
    // `- <display> (<kind>)…  [<principal_id>]` — display up to ` (`, principal in the LAST [...].
    const tag = /\[([^\]]+)\]\s*$/.exec(line);
    const head = /^- (.+?) \(/.exec(line);
    if (tag && head) index.set(tag[1]!, head[1]!);
  }
  return index;
}

/**
 * Resolve an inbound chat label (`im:<label>`) to an OA display name via the directory index. The
 * directory is keyed by raw principal_id; im_proxy's label is `im:` + sanitize(principal_id). For
 * the platform's principal ids (lowercase alphanumerics, sanitize-stable) `im:<principal_id>` is the
 * label, so we match by re-prefixing each directory principal with `im:`. Returns the display name,
 * or null when the sender is not in the directory (→ caller waits, never falls back to the label).
 */
function resolveLabel(label: string, index: Map<string, string>): string | null {
  for (const [principalId, display] of index) {
    if (`im:${principalId}` === label) return display;
  }
  return null;
}

/** The reply body — folds the OA-resolved sender name with the inbound body (which carries the
 * per-run nonce), so the reply proves BOTH name resolution and a live read. */
function resolvedReply(displayName: string, body: string): string {
  return `resolved: ${displayName} | ${body}`;
}

/**
 * OaResolveMockProvider — a MockProvider that, instead of a fixed script, computes each turn from
 * the rendered prompt: reply to the newest inbound IM message it has not already answered, folding
 * in the sender's OA-resolved display name read out of the `# Organization` directory block.
 */
export class OaResolveMockProvider extends MockProvider {
  /** Bodies already answered (so a message is answered exactly once — the loop terminates). */
  private readonly answered = new Set<string>();
  private callSeq = 0;

  constructor(opts: MockProviderOpts = {}) {
    // The base MockProvider needs a script, but we never consume it (we override `send`).
    super([], { id: opts.id ?? 'mock-oa-resolve', ...opts });
  }

  override send(prompt: RenderedPrompt, opts: SendOpts): AsyncIterable<ProviderChunk> {
    this.last_prompt = prompt;
    this.last_opts = opts;
    this.callSeq += 1;

    const text = promptText(prompt);
    const index = directoryIndex(text);
    const inbound = inboundMessages(text);
    // The newest inbound we have not answered and that is not itself one of our resolved replies
    // (defends against re-answering a re-fed reply when it lands back in the window).
    const target = [...inbound]
      .reverse()
      .find((m) => !this.answered.has(m.body) && !m.body.startsWith('resolved: '));

    if (target === undefined) {
      return emptyTurn();
    }
    // METHOD A anti-false-green: resolve the sender via the OA DIRECTORY only. No directory hit →
    // wait (the sender is not yet in the live OA projection); never fall back to the `im:` label.
    const displayName = resolveLabel(target.label, index);
    if (displayName === null) {
      return emptyTurn();
    }
    this.answered.add(target.body);
    const call: ToolCall = {
      id: `oa-resolve-${this.callSeq}`,
      name: 'im_proxy.reply',
      args: { body: resolvedReply(displayName, target.body) },
    };
    return replyTurn(call, displayName, target.body);
  }
}

/** Stream a single reply turn (a thought + one im_proxy.reply tool_call), then done. */
async function* replyTurn(
  call: ToolCall,
  displayName: string,
  body: string,
): AsyncIterable<ProviderChunk> {
  yield { kind: 'thinking', text: `(oa-resolve mock) resolved sender '${displayName}', replying to: ${body}` };
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
