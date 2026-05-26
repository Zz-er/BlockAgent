/**
 * apps/messages.ts — the messages BlockApp (impl-messages owned).
 *
 * messages is the agent's CONVERSATION-HISTORY MANAGER (rewrite, supersedes the
 * counts-only inbox + the cancelled bounded-pending patch). It is the agent's front
 * door: inbound user messages arrive (from a ChannelAdapter / demo), are durably
 * appended to an append-only jsonl history, projected into the prompt, and then wake
 * the AgentRuntime out of idle (§8.2). As the live history grows past a token budget
 * it is AUTOMATICALLY + INCREMENTALLY compacted: messages older than the most-recent
 * `display_count` are folded into a running summary so the prompt stays bounded while
 * the full history remains durable in jsonl.
 *
 * Authoritative design: ai_com/block-agent-architecture-v3.1.md §6.3 / §8.2 / §12.2,
 * and src/ARCHITECTURE.md "impl-messages → ... REWRITE: conversation-history manager".
 *
 * Two projection blocks (replace the old `messages:inbox`):
 *   - `messages:summary` — the compacted older history, cache_tier `slow_changing`
 *     (changes only when a compaction runs → renders mid-prompt).
 *   - `messages:recent`  — the most-recent `display_count` messages VERBATIM,
 *     cache_tier `volatile` (changes most turns → tail). This is where the agent
 *     actually READS message bodies.
 *
 * INVARIANTS held here:
 *   #14 state is JSON-serializable + bounded (recent window + summary string +
 *       config); the FULL history lives in jsonl, never unbounded in state.
 *   #15 block names are `<app_id>:<name>` (`messages:summary` / `messages:recent`).
 *   #16 both builders are PURE: read `state` only — never jsonl, never the clock /
 *       random. All I/O (jsonl writes) + compaction happen in the command/ingest path.
 *    #4 builder owner is `system` (`agent` is illegal).
 *
 * config (anti-self-modification): `set_config` is `allowed_invokers: ['user']`, the
 * reusable PolicyEngine "who, not what" gate (same as `agent_identity.set`), so the
 * AGENT can never retune its own token budget / threshold / display count.
 *
 * §12.2 jsonl discipline (UNCHANGED): append-only, one JSON object per line, each line
 * ≤ 64KB, an advisory exclusive lock around every append, and startup truncation of a
 * crash-torn trailing line.
 *
 * House style (§0.5): the extension unit is `BlockApp`; satellites stay short;
 * block-world nouns get the `Block` prefix (`SummaryBlockBuilder` / `RecentBlockBuilder`);
 * the App itself is `MessagesApp`.
 */

import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Block, BlockName, InvokerContext, WakeEvent } from '../core/types.js';
import type {
  AppContext,
  AppManifest,
  BuildContext,
  BuilderManifest,
  CommandManifest,
  CommandResult,
  JsonSchema,
} from '../app/types.js';
import { readAppConfig, APPS_DIR } from './_app_config.js';

// ============================================================================
// Constants + pluggable seams
// ============================================================================

/** App id + tree namespace (§6.3). */
const APP_ID = 'messages' as const;
const TREE_NAMESPACE = '/messages' as const;

/** The two blocks this App renders into the prompt (INV #15, replace `messages:inbox`). */
const SUMMARY_BLOCK: BlockName = 'messages:summary';
const RECENT_BLOCK: BlockName = 'messages:recent';

/** jsonl files under `.block-agent/apps/messages/` (§12.1 / §12.2). */
const HISTORY_FILE = 'history.jsonl' as const;
const OUTBOX_REPLIES_FILE = 'outbox.replies.jsonl' as const;

/** §12.2: each jsonl line MUST be ≤ 64KB (a longer record must be split). */
const MAX_LINE_BYTES = 64 * 1024;

/** Bound on how long an append waits for a concurrent appender before giving up. */
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Estimate the token cost of a piece of text. Pluggable: the App holds NO provider
 * handle in v3.0, so the default is the standard char/4 heuristic; a host injects
 * `Provider.estimateTokens` later via the MessagesApp constructor. Deterministic.
 */
export type TokenEstimator = (text: string) => number;
const DEFAULT_ESTIMATE_TOKENS: TokenEstimator = (text) => Math.ceil(text.length / 4);

/**
 * Summarize a run of messages being folded out of the recent window. PLACEHOLDER +
 * pluggable: v3.0 ships a deterministic, LLM-free placeholder (a count marker plus a
 * truncated trace of who said what). A real summarizer arrives later via
 * `spawn_system_agent` / a runtime hook. The TRIGGER logic — not summary quality — is
 * the v3.0 deliverable.
 */
export type Summarizer = (folded: readonly HistoryMessage[], priorSummary: string) => string;
const DEFAULT_SUMMARIZE: Summarizer = (folded, priorSummary) => {
  const trace = folded.map((m) => `${m.role}: ${oneLine(m.content, 80)}`).join(' | ');
  const note = `[${folded.length} earlier message${folded.length === 1 ? '' : 's'} folded] ${trace}`;
  return priorSummary.length === 0 ? note : `${priorSummary}\n${note}`;
};

/** Collapse to a single line and hard-cap length (deterministic; for the placeholder). */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// ============================================================================
// Config (file-seeded; user-only `set_config` to retune at runtime)
// ============================================================================

/**
 * MessagesConfig — the tunable knobs, seeded from `.block-agent/apps/messages/config.json`
 * over these compiled defaults and changeable at runtime only by the USER (set_config).
 *   - max_history_tokens   — token budget for the live projection (summary + recent).
 *   - compression_threshold— fraction (0..1) of the budget that triggers compaction.
 *   - display_count        — how many most-recent messages to keep VERBATIM.
 */
export interface MessagesConfig {
  max_history_tokens: number;
  compression_threshold: number;
  display_count: number;
}

const DEFAULT_CONFIG: MessagesConfig = {
  max_history_tokens: 4000,
  compression_threshold: 0.8,
  display_count: 10,
};

/** Clamp a config to sane ranges (handler-side; defends against bad file/input values). */
function clampConfig(cfg: MessagesConfig): MessagesConfig {
  return {
    max_history_tokens: Math.max(1, Math.floor(cfg.max_history_tokens)),
    compression_threshold: Math.min(1, Math.max(0, cfg.compression_threshold)),
    display_count: Math.max(1, Math.floor(cfg.display_count)),
  };
}

// ============================================================================
// State (bounded projection — INV #14)
// ============================================================================

/** One message in the conversation history (durable in jsonl; projected from state). */
export interface HistoryMessage {
  role: 'user' | 'agent';
  id: string;
  content: string;
  ts?: number;
}

/**
 * ReplyEvent — one agent reply, emitted to `MessagesApp.onReply` subscribers the
 * moment `messages.reply` has durably recorded it (the reply=push design, "Option B"
 * in ai_com/block-agent-cli-design.md §6). A ChannelAdapter (e.g. the CLI) subscribes
 * to deliver replies to its UI — symmetric to `AgentRuntime.onThinking`. Carries the
 * just-assigned reply id, the content, and the optional `reply_to`.
 */
export interface ReplyEvent {
  id: string;
  content: string;
  reply_to?: string;
}

/** A subscriber on the messages reply channel; see `MessagesApp.onReply`. */
export type ReplyListener = (event: ReplyEvent) => void;

/**
 * MessagesState — a BOUNDED projection of the conversation plus the config:
 *   - `recent`  — messages not yet folded into the summary (the live window).
 *     Compaction folds the overflow into `summary` once the token budget is reached,
 *     and the block renders only the last `display_count`, so it stays bounded.
 *   - `summary` — the compacted older history (one string, grows incrementally).
 *   - `config`  — the tunable knobs (seeded from file; user-only to change).
 *
 * INV #14: all JSON-serializable, and bounded (compaction folds `recent` once it
 * exceeds the token budget, so state never grows without limit). The FULL history is
 * the jsonl log, NOT state.
 */
export interface MessagesState {
  recent: HistoryMessage[];
  summary: string;
  config: MessagesConfig;
}

/** INV #14: declare every state key so set_state is schema-checked. */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['recent', 'summary', 'config'],
  properties: {
    recent: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'id', 'content'],
        properties: {
          role: { type: 'string' },
          id: { type: 'string' },
          content: { type: 'string' },
          ts: { type: 'number' },
        },
      },
    },
    summary: { type: 'string' },
    config: {
      type: 'object',
      required: ['max_history_tokens', 'compression_threshold', 'display_count'],
      properties: {
        max_history_tokens: { type: 'number' },
        compression_threshold: { type: 'number' },
        display_count: { type: 'number' },
      },
    },
  },
};

// ============================================================================
// Compaction (effectful path; pure transform over state)
// ============================================================================

/**
 * Token cost of the current projection: the summary plus every message body in the
 * recent window. Deterministic given the estimator.
 */
function projectionTokens(state: MessagesState, estimate: TokenEstimator): number {
  let total = estimate(state.summary);
  for (const m of state.recent) total += estimate(m.content);
  return total;
}

/**
 * Incrementally compact `state` if its projection has reached the budget threshold:
 * fold every message OLDER than the most-recent `display_count` into the summary,
 * leaving the last `display_count` verbatim. Pure: returns a NEW state (safe inside a
 * `set_state` updater); does NOT touch jsonl (the durable log keeps the full history).
 * A no-op when below threshold or when there is nothing foldable.
 */
function compactIfNeeded(
  state: MessagesState,
  estimate: TokenEstimator,
  summarize: Summarizer,
): MessagesState {
  const { display_count, max_history_tokens, compression_threshold } = state.config;
  const trigger = max_history_tokens * compression_threshold;
  if (projectionTokens(state, estimate) < trigger) return state;
  if (state.recent.length <= display_count) return state; // nothing older to fold

  const foldCount = state.recent.length - display_count;
  const folded = state.recent.slice(0, foldCount);
  const kept = state.recent.slice(foldCount);
  return {
    ...state,
    summary: summarize(folded, state.summary),
    recent: kept,
  };
}

// ============================================================================
// Builders — messages:summary (slow_changing) + messages:recent (volatile)
// ============================================================================

/** Narrow an AppContext's state to MessagesState (already schema-valid, INV #14). */
function messagesStateOf(app_ctx: AppContext | undefined): MessagesState | null {
  if (app_ctx === undefined) return null;
  const s = app_ctx.state;
  if (typeof s !== 'object' || s === null) return null;
  const cand = s as Partial<MessagesState>;
  if (!Array.isArray(cand.recent) || typeof cand.summary !== 'string' || cand.config == null)
    return null;
  return s as MessagesState;
}

/**
 * SummaryBlockBuilder — owner of `messages:summary`. Renders the compacted older
 * history. cache_tier `slow_changing`: it changes only when a compaction runs, so it
 * sits in the middle of the prompt and stays cache-warm between compactions. Pure:
 * reads `state.summary` only (INV #16). Renders nothing when there is no summary yet.
 */
const SummaryBlockBuilder: BuilderManifest = {
  name: 'SummaryBlockBuilder',
  version: '1.0.0',
  owner: 'system', // INV #4: 'agent' illegal.
  app_id: APP_ID,
  inputs: [],
  outputs: [SUMMARY_BLOCK],
  cache_tier: 'slow_changing',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = messagesStateOf(app_ctx);
    if (state === null || state.summary.length === 0) return null;
    return {
      id: SUMMARY_BLOCK,
      name: SUMMARY_BLOCK,
      children: [],
      content_text: `# Conversation summary (older messages)\n${state.summary}`,
      content_blob: null,
    };
  },
};

/**
 * RecentBlockBuilder — owner of `messages:recent`. Renders the most-recent
 * `display_count` messages VERBATIM (this is how the agent reads message bodies).
 * cache_tier `volatile`: changes most turns → renders at the tail. Pure: reads
 * `state.recent` + `state.config.display_count` only (INV #16).
 */
const RecentBlockBuilder: BuilderManifest = {
  name: 'RecentBlockBuilder',
  version: '1.0.0',
  owner: 'system',
  app_id: APP_ID,
  inputs: [],
  outputs: [RECENT_BLOCK],
  cache_tier: 'volatile',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = messagesStateOf(app_ctx);
    if (state === null) return null;
    return {
      id: RECENT_BLOCK,
      name: RECENT_BLOCK,
      children: [],
      content_text: renderRecent(state),
      content_blob: null,
    };
  },
};

/** Deterministic text projection of the most-recent `display_count` messages. */
function renderRecent(state: MessagesState): string {
  const window = state.recent.slice(-state.config.display_count);
  if (window.length === 0) return '# Recent messages\n(none)';
  const lines = window.map((m) => `[${m.role}] ${m.content}`);
  return ['# Recent messages', ...lines].join('\n');
}

// ============================================================================
// Commands — ingest / reply / peek / ack / set_config
// ============================================================================

/** Args for `messages.reply`. */
interface ReplyArgs {
  reply_to?: string;
  content: string;
}

/**
 * ingest({ id?, content, from? }) — the §8.2 front door: append a USER message to the
 * durable history + projection, run compaction if the budget is reached, then wake the
 * runtime. NOT a ChannelAdapter — a direct command/method for demo + tests (auth +
 * invoker tagging happen at the entry membrane upstream of the App). The MessagesApp
 * also exposes an `ingest(...)` method that drives this same path.
 */
function ingestCommand(app: MessagesApp): CommandManifest<MessagesState> {
  return {
    name: 'ingest',
    description: 'Deliver an inbound user message into the conversation history (wakes the runtime).',
    capabilities: [{ name: 'block:write' }],
    invoke: async (args): Promise<CommandResult> => {
      const a = args as { id?: unknown; content?: unknown; from?: unknown } | undefined;
      if (typeof a?.content !== 'string')
        return { ok: false, error: 'ingest requires string `content`' };
      const id = typeof a.id === 'string' && a.id.length > 0 ? a.id : app.nextMessageId('user');
      const event = app.ingest({
        id,
        content: a.content,
        ...(typeof a.from === 'string' ? { from: a.from } : {}),
      });
      return { ok: true, data: { msg_id: id, woke: event.kind } };
    },
  };
}

/**
 * reply(reply_to?, content) — emit an AGENT reply: append it to the durable history +
 * the outbox jsonl (the ChannelAdapter ships it onward, §8.2) and into the recent
 * projection (so the conversation block shows the agent's own turns), running
 * compaction if needed. Needs `block:write`. Returns the assigned reply id.
 */
function replyCommand(app: MessagesApp): CommandManifest<MessagesState> {
  return {
    name: 'reply',
    description: 'Reply to the conversation: records the agent message + appends to the outbox.',
    capabilities: [{ name: 'block:write' }],
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = args as Partial<ReplyArgs> | undefined;
      if (typeof a?.content !== 'string')
        return { ok: false, error: 'reply requires string `content`' };
      const reply_to = typeof a.reply_to === 'string' ? a.reply_to : undefined;

      const id = app.nextMessageId('agent');
      const msg: HistoryMessage = { role: 'agent', id, content: a.content };
      // Durable: full history log + the outbox the ChannelAdapter drains.
      app.store.appendHistory(msg);
      app.store.appendReply(id, reply_to ?? '', a.content);
      // Projection: add to recent + compact if the budget is reached.
      ctx.set_state((s) => app.appendToProjection(s as MessagesState, msg));
      // Push the reply to onReply subscribers (a ChannelAdapter's delivery side,
      // §6 Option B) — AFTER the durable write so a subscriber never sees a reply
      // that isn't yet recorded. Fire-and-forget; a throwing listener is isolated.
      app.emitReply({ id, content: a.content, ...(reply_to ? { reply_to } : {}) });
      return { ok: true, data: { reply_id: id, ...(reply_to ? { reply_to } : {}) } };
    },
  };
}

/**
 * peek({ count? }) — read-only: return the most-recent messages (verbatim bodies) plus
 * the current summary, so a caller can inspect the conversation without rendering.
 * Adapted to the history model (the old counts-only peek is gone).
 */
function peekCommand(): CommandManifest<MessagesState> {
  return {
    name: 'peek',
    description: 'Return the recent conversation messages (bodies) and the current summary.',
    invoke: async (args, ctx): Promise<CommandResult> => {
      const state = ctx.state;
      const n = readPositiveInt((args as { count?: unknown } | undefined)?.count);
      const window =
        n === null ? state.recent.slice(-state.config.display_count) : state.recent.slice(-n);
      return { ok: true, data: { recent: window, summary: state.summary } };
    },
  };
}

/**
 * ack({ id }) — drop a message from the RECENT projection by id (it leaves the rendered
 * window but stays in the durable jsonl history). Adapted to the history model: ack
 * means "I've handled this; stop showing it verbatim". The summary is untouched.
 * Unknown id → ok:false.
 */
function ackCommand(): CommandManifest<MessagesState> {
  return {
    name: 'ack',
    description: 'Remove a message from the recent projection by id (stays in the durable log).',
    capabilities: [{ name: 'block:write' }],
    invoke: async (args, ctx): Promise<CommandResult> => {
      const id = (args as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string' || id.length === 0)
        return { ok: false, error: 'ack requires a non-empty `id`' };
      if (!ctx.state.recent.some((m) => m.id === id))
        return { ok: false, error: `message id '${id}' is not in the recent projection` };
      ctx.set_state((s) => ({
        ...(s as MessagesState),
        recent: (s as MessagesState).recent.filter((m) => m.id !== id),
      }));
      return { ok: true, data: { acked: id } };
    },
  };
}

/**
 * set_config({ max_history_tokens?, compression_threshold?, display_count? }) — retune
 * the config at runtime. USER-ONLY: `allowed_invokers: ['user']` makes PolicyEngine
 * deny invoker `agent`/`app` on the invoker gate BEFORE the handler runs, so the AGENT
 * can never change its own token budget / threshold / display count (anti
 * self-modification, same gate as `agent_identity.set`). Validated + clamped, then
 * committed via `ctx.set_state` (re-validated against state_schema, INV #14).
 */
function setConfigCommand(): CommandManifest<MessagesState> {
  return {
    name: 'set_config',
    description: 'Retune messages config (token budget / threshold / display count). User/UI only.',
    capabilities: [{ name: 'block:write' }],
    allowed_invokers: ['user'],
    invoke: async (args, ctx, _invoker: InvokerContext): Promise<CommandResult> => {
      const patch = readConfigPatch(args);
      if (Object.keys(patch).length === 0)
        return {
          ok: false,
          error:
            'set_config: no valid field (max_history_tokens/compression_threshold/display_count)',
        };
      ctx.set_state((s) => {
        const cur = s as MessagesState;
        return { ...cur, config: clampConfig({ ...cur.config, ...patch }) };
      });
      return { ok: true, data: { updated: Object.keys(patch) } };
    },
  };
}

/** Pull the numeric config fields out of `set_config` args; ignore everything else. */
function readConfigPatch(args: unknown): Partial<MessagesConfig> {
  if (typeof args !== 'object' || args === null) return {};
  const a = args as Record<string, unknown>;
  const patch: Partial<MessagesConfig> = {};
  if (typeof a['max_history_tokens'] === 'number') patch.max_history_tokens = a['max_history_tokens'];
  if (typeof a['compression_threshold'] === 'number')
    patch.compression_threshold = a['compression_threshold'];
  if (typeof a['display_count'] === 'number') patch.display_count = a['display_count'];
  return patch;
}

/** A positive integer arg, or null if absent/invalid. */
function readPositiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

// ============================================================================
// jsonl store — append-only, advisory-locked, ≤64KB/line, startup truncate (§12.2)
// ============================================================================

/**
 * JsonlStore — one append-only file under the messages App's storage dir, written per
 * §12.2 (UNCHANGED from the prior implementation). Construction truncates a crash-torn
 * trailing line so reads only ever see complete records. `append` holds an exclusive
 * advisory lock for the duration of the write so concurrent writers never interleave a
 * partial line — Node `O_APPEND` does NOT guarantee whole-line atomicity across fds,
 * hence the explicit lock.
 */
export class JsonlStore {
  private readonly lockPath: string;

  constructor(private readonly path: string) {
    this.lockPath = `${path}.lock`;
    this.truncateIncompleteTail();
  }

  /**
   * Append one record as a single jsonl line, under an exclusive advisory lock.
   * Throws if the serialized line would exceed MAX_LINE_BYTES (§12.2: split a longer
   * record upstream — silently truncating would corrupt the record).
   */
  append(record: unknown): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_LINE_BYTES)
      throw new Error(
        `messages jsonl line is ${bytes}B, exceeds the ${MAX_LINE_BYTES}B/line limit (§12.2)`,
      );

    const release = acquireLock(this.lockPath);
    try {
      const fd = openSync(this.path, 'a');
      try {
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
    } finally {
      release();
    }
  }

  /** Read all complete records currently in the file (used by recovery/tests). */
  readAll(): unknown[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const out: unknown[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      out.push(JSON.parse(line));
    }
    return out;
  }

  /**
   * §12.2 startup scan: the last line may be a torn write from a crash. Truncate the
   * file to the last complete `\n` so no reader ever parses a partial record. A file
   * that is empty or already ends cleanly is left untouched.
   */
  private truncateIncompleteTail(): void {
    if (!existsSync(this.path)) return;
    const buf = readFileSync(this.path);
    if (buf.length === 0) return;
    const lastNewline = buf.lastIndexOf(0x0a); // '\n'
    const keep = lastNewline + 1; // no newline at all → keep 0 → drop the torn line
    if (keep === buf.length) return; // already ends on a clean line boundary
    const fd = openSync(this.path, 'r+');
    try {
      ftruncateSync(fd, keep);
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * Acquire an exclusive advisory lock and return a release thunk. The architecture
 * specifies `flock` LOCK_EX; `flock(2)` is not portable from Node (and absent on
 * Windows), so we use the portable equivalent: an atomic exclusive lock FILE created
 * with the `wx` flag (fails if it already exists), spinning briefly for a concurrent
 * holder to release. Same guarantee the spec wants — one writer appends at a time.
 *
 * TODO (v3.1): no stale-holder reaping — a process that crashes WHILE holding the lock
 * leaves the `*.lock` behind, so later appends spin to the timeout and throw. Low risk
 * for v3.0 (single-process). Do NOT silently delete on EEXIST — that defeats the mutex;
 * a robust fix reaps by mtime / records owner pid + checks liveness.
 */
function acquireLock(lockPath: string): () => void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx'); // atomic create-if-not-exists test-and-set
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() > deadline)
        throw new Error(`messages jsonl lock timeout on ${lockPath} (held too long)`);
      // Tight spin: appends are sub-millisecond; staying synchronous avoids async.
    }
  }
  return () => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already released — releasing twice is harmless */
    }
  };
}

// ============================================================================
// MessagesStore — the jsonl-backed durable history + outbox
// ============================================================================

/**
 * MessagesStore — owns the durable jsonl files for one messages App instance:
 *   - `history.jsonl`        — the FULL ordered conversation (user + agent), the
 *     durable source of truth; compaction never shrinks it.
 *   - `outbox.replies.jsonl` — agent replies for the ChannelAdapter to ship onward.
 * Storage dir defaults to `.block-agent/apps/messages/` (§12.1); tests inject a temp dir.
 */
export class MessagesStore {
  readonly history: JsonlStore;
  readonly outboxReplies: JsonlStore;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.history = new JsonlStore(join(dir, HISTORY_FILE));
    this.outboxReplies = new JsonlStore(join(dir, OUTBOX_REPLIES_FILE));
  }

  /** Append a message to the durable history log. */
  appendHistory(msg: HistoryMessage): void {
    this.history.append(msg);
  }

  /** Append an agent reply to the outbox log. */
  appendReply(id: string, reply_to: string, content: string): void {
    this.outboxReplies.append({ id, reply_to, content });
  }

  /** Every message in the durable history (used to seed projection on boot/tests). */
  readHistory(): HistoryMessage[] {
    return this.history.readAll() as HistoryMessage[];
  }
}

// ============================================================================
// MessagesApp — the BlockApp (manifest + the §8.2 wake-seam ingest door)
// ============================================================================

/** Optional pluggable seams + a custom storage dir for the App. */
export interface MessagesAppOptions {
  /** Storage dir (defaults to `.block-agent/apps/messages/`, §12.1). */
  dir?: string;
  /** Base dir for the config-file seed (defaults to `.block-agent/apps`). */
  configBase?: string;
  /** Token estimator (defaults to char/4); a host injects Provider.estimateTokens later. */
  estimate_tokens?: TokenEstimator;
  /** Summarizer seam (defaults to the deterministic placeholder; no LLM in v3.0). */
  summarize?: Summarizer;
}

/**
 * MessagesApp — the concrete conversation-history BlockApp. `manifest()` produces the
 * AppManifest the AppRegistry installs; the App captures its AppContext in `on_install`
 * so `ingest()` (the §8.2 front door) and the commands can mutate state + wake the
 * runtime after durably appending a message.
 *
 * `ingest` is a direct method (also exposed as the `messages.ingest` command) for demo
 * + tests; it (1) appends to the durable history, (2) updates the recent projection +
 * runs compaction via `set_state`, then (3) calls `ctx.wake?.(...)` — guarded, so an
 * App installed without a running runtime never throws (§8.2 seam).
 */
export class MessagesApp {
  readonly store: MessagesStore;
  private readonly estimate: TokenEstimator;
  private readonly summarize: Summarizer;
  private readonly seedConfig: MessagesConfig;
  private ctx: AppContext<MessagesState> | null = null;
  /** Monotonic per-role counters for deterministic message ids within this instance. */
  private readonly seq: { user: number; agent: number } = { user: 0, agent: 0 };
  /** Subscribers on the reply channel (§6 Option B); see `onReply`. */
  private readonly replyListeners = new Set<ReplyListener>();

  constructor(opts: MessagesAppOptions = {}) {
    const dir = opts.dir ?? join(APPS_DIR, APP_ID);
    this.store = new MessagesStore(dir);
    this.estimate = opts.estimate_tokens ?? DEFAULT_ESTIMATE_TOKENS;
    this.summarize = opts.summarize ?? DEFAULT_SUMMARIZE;
    // File seed: merge config.json over the compiled defaults (never throws at boot).
    // readAppConfig is keyed on a plain record; round-trip through it then re-narrow
    // to MessagesConfig (the keys/types match the defaults it merged over).
    const seeded = readAppConfig(
      APP_ID,
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      opts.configBase ?? APPS_DIR,
    );
    this.seedConfig = clampConfig(seeded as unknown as MessagesConfig);
  }

  /**
   * The AppManifest to hand to `AppRegistry.install` (§6.3). Returned widened to the
   * bare `AppManifest` per the team's locked TS2379 convention; the typed
   * `MessagesState` discipline stays in the command/builder factories. `initial_state`
   * carries the file-seeded config (recovery of prior history into the projection is a
   * v3.1 follow-up — the durable log is intact either way).
   */
  manifest(): AppManifest {
    const app = this;
    const manifest: AppManifest<MessagesState> = {
      id: APP_ID,
      version: '1.0.0',
      depends_on: [],
      tree_namespace: TREE_NAMESPACE,
      initial_state: { recent: [], summary: '', config: this.seedConfig },
      state_schema: STATE_SCHEMA,
      builders: [() => SummaryBlockBuilder, () => RecentBlockBuilder],
      commands: [
        () => ingestCommand(app),
        () => replyCommand(app),
        () => peekCommand(),
        () => ackCommand(),
        () => setConfigCommand(),
      ],
      async on_install(ctx) {
        app.ctx = ctx as AppContext<MessagesState>;
      },
    };
    return manifest as AppManifest;
  }

  /** A deterministic message id for this instance (per-role monotonic counter). */
  nextMessageId(role: 'user' | 'agent'): string {
    this.seq[role] += 1;
    return `${role}_${this.seq[role]}`;
  }

  /**
   * onReply — subscribe to agent replies (§6 Option B, ai_com/block-agent-cli-design.md).
   * The returned thunk unsubscribes. Each `messages.reply` emits a `ReplyEvent` to every
   * subscriber AFTER it has durably recorded the reply, so a subscriber never observes a
   * reply that isn't yet in the history/outbox log. Symmetric to
   * `AgentRuntime.onThinking`: a ChannelAdapter (e.g. the CLI) subscribes to deliver
   * replies to its UI as a push (no polling, no jsonl re-read). Listeners are
   * fire-and-forget; a throwing listener is isolated (try/catch in `emitReply`) so it
   * never breaks the command path. This adds NO contract change and the App holds no UI
   * reference — it just exposes a notification channel an adapter may use.
   */
  onReply(listener: ReplyListener): () => void {
    this.replyListeners.add(listener);
    return () => this.replyListeners.delete(listener);
  }

  /**
   * emitReply — publish a reply to every `onReply` subscriber. Called by the `reply`
   * command after the durable append + projection update. A faulty subscriber is
   * isolated so it never breaks the turn loop (same discipline as the thinking channel).
   */
  emitReply(event: ReplyEvent): void {
    if (this.replyListeners.size === 0) return;
    for (const listener of this.replyListeners) {
      try {
        listener(event);
      } catch {
        // A faulty reply subscriber never breaks the command path (fire-and-forget).
      }
    }
  }

  /**
   * Append a message to the recent projection and compact if the token budget is
   * reached. Pure transform over state (safe inside a `set_state` updater); does NOT
   * touch jsonl. Shared by `ingest` and `reply`.
   */
  appendToProjection(state: MessagesState, msg: HistoryMessage): MessagesState {
    const grown: MessagesState = { ...state, recent: [...state.recent, msg] };
    return compactIfNeeded(grown, this.estimate, this.summarize);
  }

  /**
   * Deliver an inbound USER message (§8.2 front door): durably append it, update the
   * recent projection + compact, then wake the runtime. Returns the WakeEvent raised so
   * a demo/test can assert on it. Throws if the App has not been installed yet.
   */
  ingest(input: { id: string; content: string; from?: string }): WakeEvent {
    const ctx = this.ctx;
    if (ctx === null)
      throw new Error('MessagesApp.ingest called before install (no AppContext captured)');

    const msg: HistoryMessage = { role: 'user', id: input.id, content: input.content };
    // (1) durable write FIRST, so a wake never races ahead of the recorded fact.
    this.store.appendHistory(msg);
    // (2) projection + compaction via the schema-validated state machine.
    ctx.set_state((s) => this.appendToProjection(s as MessagesState, msg));
    // (3) wake the runtime (guarded — inert if no runtime is wired, §8.2 seam).
    const event: WakeEvent = { kind: 'sync_message_arrived', msg_id: input.id };
    ctx.wake?.(event);
    return event;
  }
}

// Block names + defaults exported for tests / cross-app references.
export { SUMMARY_BLOCK, RECENT_BLOCK, DEFAULT_CONFIG };
