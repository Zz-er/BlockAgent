/**
 * apps/base — the `base` BlockApp (formerly `actions`, with the former `tools` app merged
 * in): the unified action/observation ledger PLUS the agent's built-in tool commands.
 *
 * Authoritative design: ai_com/design/actions-app-architecture.md (§3 data model,
 * §4 render, §5 commands, §7 overflow, §9 file list, §10 steps 3-6).
 *
 * THE GAP THIS CLOSES (§0/§1): the agent REPEATS operations because it sees its
 * FAILURES but never its SUCCESSES. block-agent scatters effects across app blocks
 * and drops the per-call success signal at agent_runtime.ts:950. `actions` records
 * BOTH every agent command (success + failure) and every external input into a
 * two-layer ledger and renders one bounded window — the action↔observation pair an
 * LLM is trained on, which is what stops the repetition.
 *
 * TWO LAYERS (§3):
 *   - LAYER 1 — full jsonl ledger off-tree (`ActionLogStore`): every record in FULL,
 *     append-only, ≤64KB/line throw-not-tear, startup tail-truncate, single-writer.
 *     This is the audit log `base.show({seq})` joins on. (Mechanics originally cloned
 *     from the former `tools` app's history store, now merged away.)
 *   - LAYER 2 — bounded render state (`BaseState.recent`): a count-bounded window
 *     of rendered rows (command + input, interleaved), a count-bounded render window
 *     (INV #14). `RecentActionsBuilder` projects it into one block `base:recent`.
 *
 * SEQ — the MESSAGES precedent, NOT tools' content-hash id. `seq` is a deterministic
 * monotonic counter; its high-water is seeded by scanning the jsonl tail for
 * max(seq)+1 (messages' `highestSeq`, apps/messages/src/manifest.ts:839-849), NOT a
 * clock and NOT an FNV-1a content hash. Seeded from the jsonl tail max (not the
 * bounded `state.recent` which rolls), so a post-overflow restart never reuses seqs.
 *
 * THE CONTROL COMMANDS (§5):
 *   - `record`     — app-only (`allowed_invokers:['app']`), `block:write`. The DUMB
 *     SINK: the two launch subscriptions (onCommand / onInput) call it. The agent
 *     cannot forge the ledger. Appends the FULL record to jsonl + pushes a bounded
 *     row into `state.recent`, advancing `compacted_seq` on overflow scroll-out (§7).
 *   - `show`       — readonly, user+app, NOT in the agent catalog. Pulls the full
 *     persisted record by `seq` from the jsonl (the "full args" retrieval).
 *   - `set_config` — user-only (`allowed_invokers:['user']`), `block:write`. Retunes
 *     window/threshold/detail/char-limits, clamped. Anti-self-modify gate — the agent
 *     can never change how much of its own trajectory it sees (the `tools.set_config`
 *     / `messages.set_config` gate).
 *   - `end_turn`   — readonly, agent+user, NO capability. The bare YIELD: end the wake
 *     WITHOUT a message. Decouples "stop the turn" from "reply to the user" so a group
 *     agent can stay silent and a scheduled wake can go idle. Hybrid — `messages.reply`
 *     remains sugar for "reply + end_turn".
 *
 * THE TOOL COMMANDS (merged from the former `tools` app): actions also AGGREGATES the
 * agent's concrete tools — `base.read_file` / `base.grep` / `base.bash` /
 * `base.http_request` (formerly `tools.*`). The `tools` app was deleted and folded
 * here: a tool is just a command, available to every invoker, with per-invoker strictness
 * decided by PolicyEngine (§9.4). Each tool command (a) refuses if not in `state.enabled`,
 * (b) runs its handler, and (c) returns the result body in `CommandResult.data`
 * (`{ tool, id, result }`) — which is the SINGLE path the tool output reaches the agent:
 * the actions ledger captures it via `onCommand` at `command_detail=3`. The tool commands
 * are commands (not builders), so a real fs read is fine (build-determinism INV #16
 * constrains builders, not commands). CAPABILITIES are UNCHANGED: `bash` declares
 * `op:dangerous` (agent → pending/approval), `http_request` declares `net:http` (host
 * allowlist host-side), `read_file`/`grep` are real reads (no cap). NO RECURSION: a tool
 * command on the agent lane fires onCommand → the launch sub calls `base.record`
 * (invoker:'app') via Operations DIRECTLY (never the agent lane) → never re-emits onCommand.
 *
 * INVARIANTS held here:
 *   #1 / #16  `RecentActionsBuilder` is PURE: reads `state.recent` only — never the
 *             jsonl, never a clock / random. `ts`/`seq` are STORED data (stamped at
 *             the boundary outside any build). Same state → byte-identical bytes.
 *    #4       builder owner is `system` ('agent' is illegal).
 *   #14       `BaseState` is bounded JSON (window count-capped; full log is jsonl).
 *    #5       overflow archives to jsonl; no physical delete path.
 *   #11       `base.record` re-enters Operations + PolicyEngine (the launch subs).
 *   #15       block name `base:recent` (colon); commands dotted.
 *
 * Contracts only: imports `app/types.js` + `core/types.js` + the architect-owned
 * `_app_config.js` helper; never the registry or a sibling app. House style (§0.5):
 * block-world nouns get the `Block` prefix; extension unit `BlockApp` + short
 * satellites (`AppManifest` etc.).
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type {
  Block,
  BlockName,
  CommandEvent,
  InputDescriptor,
  InvokerContext,
} from '@block-agent/core/core/types.js';
import type {
  AppContext,
  AppManifest,
  BuildContext,
  BuilderManifest,
  Capability,
  CommandManifest,
  CommandResult,
  JsonSchema,
} from '@block-agent/core/app/types.js';
import { APPS_DIR, readAppConfig } from '@block-agent/core/apps/_app_config.js';

// ============================================================================
// Identity & block names
// ============================================================================

/** App id and tree namespace (§2). Block names use the bare id prefix (INV #15). */
export const BASE_APP_ID = 'base' as const;
const TREE_NAMESPACE = '/base' as const;

/**
 * The ONE block this App renders: the recent-actions window. cache_tier `volatile`
 * — it changes every recorded action, so it renders at the tail next to
 * `messages:recent` (§4).
 */
export const RECENT_BLOCK: BlockName = 'base:recent';

/** The off-tree jsonl ledger file under `.block-agent/apps/base/` (§3.1). */
const LOG_FILE = 'log.jsonl' as const;

/** §3.1 / §12.2: each jsonl line MUST be ≤ 64KB (a longer record is rejected, not torn). */
const MAX_LINE_BYTES = 64 * 1024;

// ============================================================================
// The two telemetry payloads `base.record` consumes (§2.1 / §3.3)
// ============================================================================
//
// core owns the canonical shapes (`CommandEvent` / `InputDescriptor`, core/types.ts).
// The launch subscriptions hand them to `base.record` plus a `kind` discriminator
// (and, for commands, a boundary-stamped `ts` — InputDescriptor already carries its
// own ts from the ingest site). `base.record` is the DUMB SINK: it discriminates on
// `kind` and reads only the public fields below. We alias the core types so a field
// rename in core surfaces as a typecheck error here (tight coupling to the contract),
// never a silent drift.

/** §2.1 — one agent command with content (success result OR failure error). */
export type CommandEventLike = CommandEvent;

/** §3.3 — one external input, mapped by the receiving app into public fields. */
export type InputDescriptorLike = InputDescriptor;

// ============================================================================
// Layer 2 state (INV #14 — all JSON-serializable + bounded)
// ============================================================================

/**
 * ActionRow — one rendered row in the bounded window (§3.2). A discriminated union
 * over `kind`: a command row carries the verb + outcome (+ content at detail≥2); an
 * input row carries the source/sender + preview (+ content at input_detail=3). The
 * FULL record always lives in the jsonl — this is the bounded projection.
 */
export type ActionRow =
  | {
      seq: number;
      kind: 'command';
      ts: string;
      verb: string;
      ok: boolean;
      error?: string;
      ref?: string;
      /** Args text, before the `→` (filled at command_detail≥2; truncated at 2). */
      args_text?: string;
      /** Result body, after the `→` (filled at command_detail=3, success only). */
      result_text?: string;
    }
  | {
      seq: number;
      kind: 'input';
      ts: string;
      source: string;
      sender?: string;
      preview: string;
      content?: string; // filled at input_detail=3
    };

/**
 * BaseState (§3.2) — the bounded render state. `recent` is the count-bounded
 * interleaved window; `config` carries the tunable knobs (schema-validated, INV #14);
 * `compacted_seq` is the high-water below which every seq has scrolled out / folded.
 */
export interface BaseState {
  recent: ActionRow[];
  config: BaseConfig;
  compacted_seq: number;
  /**
   * The set of enabled tool names (the `enabled` subset gate, merged from the former
   * `tools` app). A string ARRAY not a Set — a Set is a class instance, rejected by INV
   * #14 state validation; the array carries the same meaning ("the set of enabled tool
   * names"). Config-seeded (BUILTIN_TOOLS by default); a tool command refuses if its name
   * is not in this list, INDEPENDENT of policy (policy gates by invoker; `enabled` gates
   * the tool category itself). Not command-tunable (tools' wasn't either).
   */
  enabled: string[];
}

/** The tools shipped enabled by default. Read-only reads first, then gated tools. */
export const BUILTIN_TOOLS = ['read_file', 'grep', 'bash', 'http_request'] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

// ----------------------------------------------------------------------------
// Config (§3.4) — file-seeded + user-only command; CLAMP like tools.
// ----------------------------------------------------------------------------

/** Config knobs seeded from `.block-agent/apps/base/config.json` (§3.4). */
export interface BaseConfig {
  /** Bounded render window (count) — CLAMP like tools' tool_history_count. */
  window_size: number;
  /** Overflow ratio (0..1), messages precedent. */
  compression_threshold: number;
  /** Command render detail. Default 3 (v1, F2 — tool results preserved). */
  command_detail: 1 | 2 | 3;
  /** Char cap for the command content at command_detail=2. */
  command_char_limit: number;
  /** Input render detail. Default 2. */
  input_detail: 1 | 2 | 3;
  /** Char cap for the input preview at input_detail=2. */
  input_char_limit: number;
}

/** Compiled defaults (§3.4 — command_detail=3 / input_detail=2 are the locked v1 defaults). */
export const DEFAULT_CONFIG: BaseConfig = {
  window_size: 20,
  compression_threshold: 0.8,
  command_detail: 3,
  command_char_limit: 200,
  input_detail: 2,
  input_char_limit: 80,
};

/** Clamp bounds — `window_size` and the char limits clamp to [0,100] / [0, ...] like tools. */
const MIN_WINDOW = 0;
const MAX_WINDOW = 100;
const MIN_CHAR_LIMIT = 0;
const MAX_CHAR_LIMIT = 100_000;

/** Clamp an integer knob into [lo, hi]; non-finite → fallback. */
function clampInt(n: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/** Clamp a detail level into {1,2,3}; anything else → fallback. */
function clampDetail(n: unknown, fallback: 1 | 2 | 3): 1 | 2 | 3 {
  if (n === 1 || n === 2 || n === 3) return n;
  return fallback;
}

/** Clamp a 0..1 ratio; non-finite/out-of-range → fallback. */
function clampRatio(n: unknown, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/** Clamp a whole config into range (boot seed + set_config both run this). */
function clampConfig(cfg: BaseConfig): BaseConfig {
  return {
    window_size: clampInt(cfg.window_size, MIN_WINDOW, MAX_WINDOW, DEFAULT_CONFIG.window_size),
    compression_threshold: clampRatio(cfg.compression_threshold, DEFAULT_CONFIG.compression_threshold),
    command_detail: clampDetail(cfg.command_detail, DEFAULT_CONFIG.command_detail),
    command_char_limit: clampInt(
      cfg.command_char_limit,
      MIN_CHAR_LIMIT,
      MAX_CHAR_LIMIT,
      DEFAULT_CONFIG.command_char_limit,
    ),
    input_detail: clampDetail(cfg.input_detail, DEFAULT_CONFIG.input_detail),
    input_char_limit: clampInt(
      cfg.input_char_limit,
      MIN_CHAR_LIMIT,
      MAX_CHAR_LIMIT,
      DEFAULT_CONFIG.input_char_limit,
    ),
  };
}

/**
 * state_schema (INV #14): `recent` (array of rows), `config` (the knob object),
 * `compacted_seq` (number) — all required. The registry's set_state Proxy does a
 * shallow required-key check plus the deep JSON-serializable guard.
 */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['recent', 'config', 'compacted_seq', 'enabled'],
  properties: {
    recent: { type: 'array' },
    compacted_seq: { type: 'number' },
    enabled: { type: 'array', items: { type: 'string' } },
    config: {
      type: 'object',
      required: [
        'window_size',
        'compression_threshold',
        'command_detail',
        'command_char_limit',
        'input_detail',
        'input_char_limit',
      ],
      properties: {
        window_size: { type: 'number' },
        compression_threshold: { type: 'number' },
        command_detail: { type: 'number' },
        command_char_limit: { type: 'number' },
        input_detail: { type: 'number' },
        input_char_limit: { type: 'number' },
      },
    },
  },
};

// ============================================================================
// Layer 1 — the off-tree jsonl ledger (full audit log, §3.1)
// ============================================================================

/**
 * ActionLogRecord (§3.1) — one FULL record on a jsonl line. `seq` is the app-assigned
 * monotonic counter (high-water seeded from the tail). Command rows carry args/ok/
 * result/error/ref; input rows carry the InputDescriptor's public fields plus any
 * app-arbitrary extra fields (kept here, jsonl-only — `actions` never parses them).
 */
export interface ActionLogRecord {
  seq: number;
  kind: 'command' | 'input';
  /** Command full-name | input source. */
  name: string;
  args?: unknown;
  ok?: boolean;
  result?: unknown;
  error?: string;
  ref?: string;
  /** Input-only public fields (mirrored here for the jsonl audit + base.show). */
  source?: string;
  sender?: string;
  preview?: string;
  content?: string;
  invoker?: string;
  /** Stamped at the boundary (the launch subscription / ingest handler), never in build. */
  ts: string;
  /** Any further app fields ride along as extras (jsonl-only). */
  [extra: string]: unknown;
}

/**
 * ActionLogStore — the durable, append-only log of EVERY recorded action (§3.1).
 * One JSON object per line, each ≤64KB (throw-not-tear). On construction it
 * truncates any crash-torn trailing line so reads only see complete records. This is
 * actions' own store — it deliberately does NOT import a sibling app's store (no
 * sibling-app coupling); the discipline is the same as tools' `ToolHistoryStore`.
 *
 * Single-writer: the turn loop / launch subscriptions are the one writer (the same
 * assumption tools makes), so no advisory lock here.
 */
export class ActionLogStore {
  constructor(private readonly path: string) {
    this.truncateIncompleteTail();
  }

  /** Append one record as a single jsonl line. Rejects an over-64KB line (not torn). */
  append(record: ActionLogRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_LINE_BYTES)
      throw new Error(
        `actions log line is ${bytes}B, exceeds the ${MAX_LINE_BYTES}B/line limit (§3.1)`,
      );
    appendFileSync(this.path, line);
  }

  /** Read all complete records currently in the file (seq seed / `base.show` / tests). */
  readAll(): ActionLogRecord[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const out: ActionLogRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as ActionLogRecord);
      } catch {
        continue; // skip unparseable (shouldn't happen after tail-truncate)
      }
    }
    return out;
  }

  /** The full record for one `seq` (the `base.show` join), or null if absent. */
  findBySeq(seq: number): ActionLogRecord | null {
    // Scan from the tail — recent records are the common lookup, and seqs are unique.
    const all = this.readAll();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]?.seq === seq) return all[i] ?? null;
    }
    return null;
  }

  /**
   * High-water seed (§3.1): the next seq is max(seq in the jsonl) + 1. Scans the FULL
   * tail (not the bounded window), so a post-overflow restart never reuses a seq.
   * Empty / torn / absent file → 0 (the first record takes seq 0). The messages
   * `highestSeq` pattern, adapted to a single monotonic counter.
   */
  nextSeq(): number {
    const all = this.readAll();
    let max = -1;
    for (const r of all) {
      if (typeof r.seq === 'number' && Number.isFinite(r.seq) && r.seq > max) max = r.seq;
    }
    return max + 1;
  }

  /** §3.1 startup scan: drop a crash-torn trailing line (truncate to last `\n`). */
  private truncateIncompleteTail(): void {
    if (!existsSync(this.path)) return;
    const buf = readFileSync(this.path);
    if (buf.length === 0) return;
    const lastNewline = buf.lastIndexOf(0x0a); // '\n'
    const keep = lastNewline + 1;
    if (keep === buf.length) return; // already ends on a clean line boundary
    const fd = openSync(this.path, 'r+');
    try {
      ftruncateSync(fd, keep);
    } finally {
      closeSync(fd);
    }
  }
}

// ============================================================================
// Capability tokens
// ============================================================================

/** Ordinary tree write — `record` + `set_config` both write the projection / config. */
const CAP_BLOCK_WRITE: Capability = { name: 'block:write' };

// ----------------------------------------------------------------------------
// Tool capability tokens (merged from the former `tools` app, §9.4 — UNCHANGED)
// ----------------------------------------------------------------------------
//
// Names match core/policy.ts CAP.* exactly; re-declared here as strings rather than
// importing the policy impl (contracts-only rule). The engine special-cases:
//   - `net:http`     — agent: granted-but-host-scoped (host allowlisting is a host-side
//                      concern, §9.4 H2).
//   - `op:dangerous` — agent: → `pending` (approval, §9.4 "危险命令 → 触发审批流").

/** Outbound HTTP — `http_request` needs it (§9.4 出站网络 host). */
const CAP_NET_HTTP: Capability = { name: 'net:http' };
/** Marks a destructive command → agent invoker resolves to `pending` (§9.4). */
const CAP_DANGEROUS: Capability = { name: 'op:dangerous' };

// ============================================================================
// Tool implementations (merged from `tools`) — each produces a ToolCallRecord
// ============================================================================
//
// A tool handler returns a ToolCallRecord; the command wrapper (below) returns it as
// `CommandResult.data`. NO handler writes a block op (display is the actions ledger via
// onCommand), and `build` never runs here — these are command-path handlers, so a real
// fs read is fine (build-determinism INV #16 constrains builders, not commands).

/**
 * One tool call's result (request + result), returned to the caller in
 * `CommandResult.data` and captured by the actions ledger via `onCommand`. Not persisted
 * separately — the record exists only for the duration of one command.
 */
export interface ToolCallRecord {
  /** Stable invocation id (caller-supplied tool_call id, or derived — see below). */
  id: string;
  tool: BuiltinTool;
  /** The request args, normalized to a plain JSON object (or null if none). */
  request: Record<string, unknown> | null;
  ok: boolean;
  /** The result body text (what the agent reads back); empty on error. */
  result: string;
  /** Set when ok === false. */
  error?: string;
}

/** Build a success record for a tool call. */
function toolOk(
  tool: BuiltinTool,
  id: string,
  request: Record<string, unknown> | null,
  result: string,
): ToolCallRecord {
  return { id, tool, request, ok: true, result };
}

/** Build a failure record for a tool call (result body empty, error set). */
function toolFail(
  tool: BuiltinTool,
  id: string,
  request: Record<string, unknown> | null,
  error: string,
): ToolCallRecord {
  return { id, tool, request, ok: false, result: '', error: `${tool}: ${error}` };
}

/** `read_file` — read a UTF-8 text file. Real, side-effect-free read. */
async function readFileTool(id: string, args: unknown): Promise<ToolCallRecord> {
  const request = asRecord(args);
  const path = stringArg(args, 'path');
  if (path === null) return toolFail('read_file', id, request, 'missing string arg `path`');
  try {
    const { readFile: fsReadFile } = await import('node:fs/promises');
    const text = await fsReadFile(path, 'utf8');
    return toolOk('read_file', id, request, text);
  } catch (err) {
    return toolFail('read_file', id, request, err instanceof Error ? err.message : String(err));
  }
}

/** `grep` — search a file's lines for a literal substring (deterministic). */
async function grepTool(id: string, args: unknown): Promise<ToolCallRecord> {
  const request = asRecord(args);
  const pattern = stringArg(args, 'pattern');
  const path = stringArg(args, 'path');
  if (pattern === null) return toolFail('grep', id, request, 'missing string arg `pattern`');
  if (path === null) return toolFail('grep', id, request, 'missing string arg `path`');
  try {
    const { readFile: fsReadFile } = await import('node:fs/promises');
    const text = await fsReadFile(path, 'utf8');
    const lines = text.split('\n');
    const matches: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.includes(pattern)) matches.push(`${i + 1}:${line}`);
    }
    return toolOk('grep', id, request, matches.join('\n'));
  } catch (err) {
    return toolFail('grep', id, request, err instanceof Error ? err.message : String(err));
  }
}

/**
 * `bash` — run a shell command. DANGEROUS: declares `op:dangerous`, so the agent invoker
 * is gated to `pending` BEFORE this runs (§9.4). v3.0 SAFE STUB: records the requested
 * command, does NOT spawn a shell.
 */
async function bashTool(id: string, args: unknown): Promise<ToolCallRecord> {
  const request = asRecord(args);
  const command = stringArg(args, 'command');
  if (command === null) return toolFail('bash', id, request, 'missing string arg `command`');
  return toolOk('bash', id, request, `[bash stub] would run: ${command}`);
}

/**
 * `http_request` — make an outbound HTTP call. Declares `net:http` (§9.4): the agent is
 * granted the token but the host must be allowlisted host-side. v3.0 SAFE STUB: records the
 * requested (method, url), does NOT open a socket.
 */
async function httpRequestTool(id: string, args: unknown): Promise<ToolCallRecord> {
  const request = asRecord(args);
  const url = stringArg(args, 'url');
  if (url === null) return toolFail('http_request', id, request, 'missing string arg `url`');
  const method = stringArg(args, 'method') ?? 'GET';
  return toolOk('http_request', id, request, `[http_request stub] would ${method} ${url}`);
}

// ----------------------------------------------------------------------------
// Tool command wrapper — enabled gate → run → return result in CommandResult.data
// ----------------------------------------------------------------------------
//
// Each tool command (a) refuses if the tool is not in `state.enabled` (independent of
// policy), (b) runs the handler, and (c) returns the record body in `CommandResult.data`
// (`{ tool, id, result }`). That returned data is the ONLY path the tool output reaches the
// agent — the actions ledger captures it via `onCommand` at `command_detail=3`. The tool
// command writes NO block and keeps NO state.

/** The runner signature each tool exposes. */
type ToolRunner = (id: string, args: unknown) => Promise<ToolCallRecord>;

function toolCommand(
  tool: BuiltinTool,
  description: string,
  capabilities: Capability[],
  run: ToolRunner,
  argsSchema: JsonSchema,
): CommandManifest<BaseState> {
  return {
    name: tool,
    description,
    args_schema: argsSchema,
    capabilities,
    async invoke(
      args: unknown,
      ctx: AppContext<BaseState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      // A disabled tool refuses before doing anything — independent of policy (policy
      // gates by invoker; `enabled` gates the tool category itself).
      if (!ctx.state.enabled.includes(tool)) {
        return { ok: false, error: `${tool}: tool '${tool}' is not enabled`, data: { tool } };
      }

      const id = invocationIdFor(tool, args);
      const record = await run(id, args);

      // Return the record as data — the actions ledger captures `{ tool, id, result }` via
      // onCommand (command_detail=3). No block op, no state mutation: the command executes
      // the tool, the ledger displays it.
      return record.ok
        ? { ok: true, data: { tool, id, result: record.result } }
        : { ok: false, error: record.error ?? `${tool} failed`, data: { tool, id } };
    },
  };
}

// ============================================================================
// Pure row-building helpers (no IO, no clock, no random)
// ============================================================================

/** Truncate `s` to `limit` chars, appending an ellipsis when it was cut (deterministic). */
function truncate(s: string, limit: number): string {
  if (limit <= 0) return '';
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…`;
}

/** Deterministic, stable canonical JSON (sorted keys) for command args/result text. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

// ----------------------------------------------------------------------------
// Tool-arg helpers (merged from `tools`) — no IO, no clock, no random
// ----------------------------------------------------------------------------

/** Read a string-valued arg by key from an args record; null if absent/non-string. */
function stringArg(args: unknown, key: string): string | null {
  const rec = asRecord(args);
  if (rec === null) return null;
  const v = rec[key];
  return typeof v === 'string' ? v : null;
}

/**
 * Pull the caller-supplied invocation id, or derive a stable one (no clock/random). A
 * turn's tool_call id maps 1:1 to its record; absent → FNV-1a over (tool, args) so replays
 * of the same call are byte-identical.
 */
function invocationIdFor(tool: BuiltinTool, args: unknown): string {
  const explicit = stringArg(args, 'invocation_id');
  if (explicit !== null) return explicit;
  return `${tool}.${fnv1a(`${tool}:${canonicalJson(args)}`)}`;
}

/** FNV-1a 32-bit hex — a stable, dependency-free content hash for invocation ids. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build the bounded command ROW for `state.recent` from a full command event, applying
 * the `command_detail` level (§4):
 *   L1 = verb → ok/err (+ error)              — `args_text`/`result_text` left undefined
 *   L2 = + the args, truncated to command_char_limit (the call that ran)
 *   L3 = + the full args + the full result body (the observation that stops repetition)
 * The full record is always in the jsonl regardless of level; errors render at ALL
 * levels (the failure signal is never lost — only successful result bodies drop below 3).
 */
function buildCommandRow(seq: number, ts: string, e: CommandEventLike, config: BaseConfig): ActionRow {
  const row: ActionRow = {
    seq,
    kind: 'command',
    ts,
    verb: e.name,
    ok: e.ok,
  };
  if (!e.ok && e.error !== undefined) row.error = e.error;
  if (e.ref !== undefined) row.ref = e.ref;
  if (config.command_detail >= 2) {
    const argsText = canonicalJson(e.args);
    row.args_text = config.command_detail >= 3 ? argsText : truncate(argsText, config.command_char_limit);
  }
  // The result body (the success observation) is full-detail only — it is the unique
  // tool-result carrier (F2), so it is preserved at L3 and dropped below it.
  if (config.command_detail >= 3 && e.ok && e.result !== undefined) {
    row.result_text = canonicalJson(e.result);
  }
  return row;
}

/**
 * Build the bounded input ROW for `state.recent` from an input descriptor, applying
 * the `input_detail` level: L1 = source + sender + ts; L2 = + truncated preview (the
 * full body stays in `messages:recent` — no dup at the default); L3 = + full content.
 */
function buildInputRow(seq: number, ts: string, d: InputDescriptorLike, config: BaseConfig): ActionRow {
  const row: ActionRow = {
    seq,
    kind: 'input',
    ts,
    source: d.source,
    preview: config.input_detail >= 2 ? truncate(d.preview, config.input_char_limit) : '',
  };
  if (d.sender !== undefined) row.sender = d.sender;
  if (config.input_detail >= 3 && d.content !== undefined) row.content = d.content;
  return row;
}

/**
 * Append `row` to the window and keep only the most-recent `window_size` (drop oldest).
 * Returns the bounded next window plus the highest seq that scrolled OUT (or null if
 * none did) so the caller can advance `compacted_seq` (§7 scroll-out + INV #5: the
 * scrolled-out rows are retained in the jsonl, never deleted).
 */
function pushBounded(
  recent: readonly ActionRow[],
  row: ActionRow,
  window_size: number,
): { next: ActionRow[]; scrolledOutMaxSeq: number | null } {
  if (window_size <= 0) {
    // Nothing renders, but the row still scrolled out of a zero-size window.
    return { next: [], scrolledOutMaxSeq: row.seq };
  }
  const grown = [...recent, row];
  if (grown.length <= window_size) return { next: grown, scrolledOutMaxSeq: null };
  const dropCount = grown.length - window_size;
  const dropped = grown.slice(0, dropCount);
  const kept = grown.slice(dropCount);
  // Rows are pushed in seq order, so the last dropped row carries the max scrolled-out seq.
  const last = dropped[dropped.length - 1];
  return { next: kept, scrolledOutMaxSeq: last ? last.seq : null };
}

// ============================================================================
// Commands — record (app-only) + show (readonly) + set_config (user-only)
// ============================================================================

/** Narrow loosely-typed args to a plain record, or null. */
function asRecord(args: unknown): Record<string, unknown> | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

/**
 * base.record — the DUMB SINK (§5). `allowed_invokers:['app']`: only the two launch
 * subscriptions (onCommand / onInput, both fired with `invoker:'app'`) reach it; the
 * agent can never forge the ledger. Discriminates on `kind`:
 *   - kind:'command' → append the full CommandEvent (+ts) to jsonl; push a bounded
 *     command row (detail-applied) into state.recent.
 *   - kind:'input'   → append the full InputDescriptor (+ts +extras) to jsonl; push a
 *     bounded input row into state.recent.
 * On overflow the oldest rows scroll out of the window and `compacted_seq` advances to
 * the max scrolled-out seq (§7) — the jsonl keeps everything (INV #5; `base.show`).
 *
 * `ctx.config` is NOT used for the window/detail — those live in `state.config` (so
 * they are schema-validated and user-retunable at runtime, the tools precedent).
 */
function recordCommand(store: ActionLogStore, nextSeqRef: { value: number }): CommandManifest<BaseState> {
  return {
    name: 'record',
    description: 'Append one action/input to the ledger (app/runtime only).',
    capabilities: [CAP_BLOCK_WRITE],
    // App-only: the runtime's onCommand/onInput sinks, never an agent/user action.
    allowed_invokers: ['app'],
    args_schema: {
      type: 'object',
      required: ['kind', 'ts'],
      properties: {
        kind: { type: 'string' },
        ts: { type: 'string' },
      },
    },
    async invoke(
      args: unknown,
      ctx: AppContext<BaseState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      const a = asRecord(args);
      if (a === null) return { ok: false, error: 'record requires an args object' };
      const kind = a['kind'];
      const ts = typeof a['ts'] === 'string' ? (a['ts'] as string) : '';
      if (kind !== 'command' && kind !== 'input')
        return { ok: false, error: "record requires `kind` of 'command' | 'input'" };

      // Assign the next monotonic seq (the high-water counter; deterministic, no clock).
      const seq = nextSeqRef.value;
      nextSeqRef.value = seq + 1;

      const config = ctx.state.config;
      let row: ActionRow;
      let logRecord: ActionLogRecord;

      if (kind === 'command') {
        const e = a as unknown as CommandEventLike;
        row = buildCommandRow(seq, ts, e, config);
        // Build the full jsonl record, assigning optionals only when present
        // (exactOptionalPropertyTypes — never write an explicit `undefined`).
        logRecord = { seq, kind: 'command', name: e.name, args: e.args, ok: e.ok, ts };
        if (e.result !== undefined) logRecord.result = e.result;
        if (e.error !== undefined) logRecord.error = e.error;
        if (e.ref !== undefined) logRecord.ref = e.ref;
        if (e.invoker !== undefined) logRecord.invoker = e.invoker;
      } else {
        const d = a as unknown as InputDescriptorLike;
        row = buildInputRow(seq, ts, d, config);
        logRecord = { seq, kind: 'input', name: d.source, source: d.source, preview: d.preview, ts };
        if (d.sender !== undefined) logRecord.sender = d.sender;
        if (d.content !== undefined) logRecord.content = d.content;
        // Carry any app-arbitrary extras into the jsonl audit (everything except the
        // framing keys + the public fields the typed record already names). `actions`
        // never parses them — they ride along for the full-record audit / `base.show`.
        for (const key of Object.keys(a)) {
          if (key === 'kind' || key === 'ts' || key === 'source' || key === 'sender') continue;
          if (key === 'preview' || key === 'content') continue;
          logRecord[key] = a[key];
        }
      }

      // (1) durable append FIRST (the full audit log lives in the store).
      store.append(logRecord);
      // (2) update the bounded projection window + advance compacted_seq on scroll-out.
      ctx.set_state((s) => {
        const { next, scrolledOutMaxSeq } = pushBounded(s.recent, row, s.config.window_size);
        return {
          ...s,
          recent: next,
          compacted_seq: scrolledOutMaxSeq === null ? s.compacted_seq : scrolledOutMaxSeq,
        };
      });

      return { ok: true, data: { seq, kind } };
    },
  };
}

/** Args for `base.show`. */
interface ShowArgs {
  seq?: number;
}

/**
 * base.show({ seq }) — readonly retrieval of the FULL persisted record by seq (§5).
 * `allowed_invokers:['user','app']`, readonly (no ops). NOT in the agent catalog (the
 * agent reads the rendered window; full bodies are an operator/host concern). Joins on
 * the jsonl audit log via `ActionLogStore.findBySeq`.
 */
function showCommand(store: ActionLogStore): CommandManifest<BaseState> {
  return {
    name: 'show',
    description: 'Show the full persisted record for one `seq` (user/app readonly).',
    readonly: true,
    allowed_invokers: ['user', 'app'],
    args_schema: {
      type: 'object',
      required: ['seq'],
      properties: { seq: { type: 'number' } },
    },
    async invoke(
      args: unknown,
      _ctx: AppContext<BaseState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      const a = args as ShowArgs | undefined;
      if (typeof a?.seq !== 'number' || !Number.isFinite(a.seq))
        return { ok: false, error: 'show requires a numeric `seq`' };
      const record = store.findBySeq(a.seq);
      if (record === null) return { ok: false, error: `no record with seq ${a.seq}`, data: { seq: a.seq } };
      return { ok: true, data: { record } };
    },
  };
}

/**
 * base.end_turn — the bare YIELD primitive (the turn-lifecycle decision the runtime
 * was missing). Ends the current wake WITHOUT emitting any outward message.
 *
 * Why it lives here: ending a turn and speaking to the user are DIFFERENT concepts.
 * `messages.reply` conflates them (it is sugar for "reply + end_turn"); but a group
 * agent that decides a message is not for it, or a long-running agent that wakes,
 * does housekeeping, and goes idle, needs to STOP without speaking. The only prior
 * no-message exit was "produce zero commands", which models never take — so this
 * gives them a positive, nameable terminal action.
 *
 * Mechanics: returns `end_turn:true` + `end_turn_kind:'yield'`, so the runtime stops the
 * loop (agent_runtime.ts §8.1) and reports the turn as `ended_by:'yield'` (distinct from
 * a reply). It is `readonly` (no ops, no state mutation) and needs no capability — it
 * writes nothing, it only signals "I am done". Agent-callable (the primary user) and
 * user-callable (a manual "stop this wake"). Because a yield is SILENT (no chat bubble),
 * the runtime DOES record it in the command ledger (`base:recent`) — unlike a reply,
 * which is skipped there since it already surfaces as the bubble — so a silent stop
 * still leaves a visible trace. Hybrid by design: reply stays the ergonomic default for
 * the chat case, this is the explicit exit for the silent / scheduled-wake cases.
 */
function endTurnCommand(): CommandManifest<BaseState> {
  return {
    name: 'end_turn',
    description:
      'End this turn WITHOUT replying — go idle. Use when you have nothing to say: a ' +
      'message not addressed to you, or you are done and no reply is needed. Tool calls ' +
      'alone keep the runtime re-prompting you; this is the silent way to stop.',
    readonly: true,
    allowed_invokers: ['agent', 'user'],
    args_schema: { type: 'object', properties: {} },
    async invoke(
      _args: unknown,
      _ctx: AppContext<BaseState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      // The terminal primitive: ending the turn, decoupled from speaking. No ops, no
      // message — just the end_turn signal the runtime stops on. `end_turn_kind:'yield'`
      // tells the runtime this is a SILENT end (report as ended_by:'yield' + record in
      // base:recent), not a reply (which would surface as a chat bubble instead).
      return { ok: true, end_turn: true, end_turn_kind: 'yield' };
    },
  };
}

/** Args for `base.set_config` — every knob optional (retune just what you name). */
interface SetConfigArgs {
  window_size?: number;
  compression_threshold?: number;
  command_detail?: number;
  command_char_limit?: number;
  input_detail?: number;
  input_char_limit?: number;
}

/**
 * base.set_config(...) — user-only runtime retune of the window/threshold/detail/
 * char-limits (§5). `allowed_invokers:['user']` makes PolicyEngine DENY invoker `agent`
 * (and `app`) on the invoker gate (the same anti-self-mod gate as `tools.set_config` /
 * `messages.set_config` — the agent can never change how much of its own trajectory it
 * sees). The handler merges over the current config, clamps the whole thing, and trims
 * `state.recent` to the new window so the next render honors it immediately.
 *
 * DETAIL is baked at RECORD time: a row encodes its detail level when it is recorded
 * (immutable thereafter, like the jsonl). A `command_detail`/`input_detail` change
 * therefore applies to NEW rows going forward — rows already in the window keep their
 * baked level until they scroll out. `window_size` IS retroactive (the window is just
 * trimmed). This keeps the render a pure function of the stored rows (INV #1) and avoids
 * re-deriving content the row no longer holds.
 */
function setConfigCommand(): CommandManifest<BaseState> {
  return {
    name: 'set_config',
    description:
      'Retune window_size / compression_threshold / command_detail / input_detail / char limits. User-only.',
    capabilities: [CAP_BLOCK_WRITE],
    allowed_invokers: ['user'],
    args_schema: {
      type: 'object',
      properties: {
        window_size: { type: 'number' },
        compression_threshold: { type: 'number' },
        command_detail: { type: 'number' },
        command_char_limit: { type: 'number' },
        input_detail: { type: 'number' },
        input_char_limit: { type: 'number' },
      },
    },
    async invoke(
      args: unknown,
      ctx: AppContext<BaseState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      const a = (args as SetConfigArgs | undefined) ?? {};
      if (Object.keys(a).length === 0)
        return { ok: false, error: 'set_config requires at least one knob to retune' };
      ctx.set_state((s) => {
        const merged = clampConfig({ ...s.config, ...a } as BaseConfig);
        const ws = merged.window_size;
        return {
          ...s,
          config: merged,
          recent: ws <= 0 ? [] : s.recent.slice(Math.max(0, s.recent.length - ws)),
        };
      });
      return { ok: true, data: { config: (ctx.state as BaseState).config } };
    },
  };
}

// ============================================================================
// RecentActionsBuilder — the single volatile owner of `base:recent`
// ============================================================================

/**
 * RecentActionsBuilder — owns the single block `base:recent` (INV #3: one owner per
 * name) and renders the bounded interleaved window. cache_tier `volatile` — it changes
 * every recorded action, so it renders at the tail next to `messages:recent` (§4).
 * owner `'system'` (never 'agent', INV #4).
 *
 * INV #16: `build` is PURE — it reads `app_ctx.state.recent` only, never the jsonl,
 * never a clock/random. `ts`/`seq` are STORED data (stamped at the boundary). Same
 * state → byte-identical output (INV #1). Rows are an interleaved timeline sorted by
 * stored `seq` (a deterministic total order over stored ints). Empty window → null.
 */
function recentActionsBuilder(): BuilderManifest {
  return {
    name: 'RecentActionsBuilder',
    version: '1.0.0',
    owner: 'system', // INV #4: 'agent' is illegal.
    app_id: BASE_APP_ID,
    inputs: [],
    outputs: [RECENT_BLOCK],
    cache_tier: 'volatile',
    async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
      const state = app_ctx?.state as BaseState | undefined;
      const recent = state?.recent ?? [];
      if (recent.length === 0) return null;
      return {
        id: RECENT_BLOCK,
        name: RECENT_BLOCK,
        children: [],
        content_text: renderRecent(recent),
        content_blob: null,
      };
    },
  };
}

/**
 * Deterministic text projection of the recent-actions window (§4, no clock/random).
 * Interleaved timeline sorted by `seq`. Each row already encodes its detail level (the
 * row builder applied command_detail/input_detail when the row was recorded), so the
 * render is purely row-driven — the output is a function of `recent` alone (INV #1).
 *   input   L1: `[seq] input ← {sender} @{ts}`  L2: `+ "{preview}"`  L3: `+ {content}`
 *   command L1: `[seq] {verb} → ok/err (error)` L2: `+ {args}`       L3: `+ {args} → {result} (ref)`
 */
function renderRecent(recent: readonly ActionRow[]): string {
  // Sort by seq (a deterministic total order over stored ints). Copy first — never
  // mutate the frozen state array in place (INV #1 hygiene).
  const sorted = [...recent].sort((a, b) => a.seq - b.seq);
  const lines = sorted.map((row) =>
    row.kind === 'command' ? renderCommandRow(row) : renderInputRow(row),
  );
  return ['# Recent actions', ...lines].join('\n');
}

/**
 * Render one command row in the §4 layout:
 *   `[seq] verb {args} → ok/err (error|ref) {result}`
 * The args (when present, detail≥2) sit before the `→`; ref renders at L3; the result
 * body (detail=3, success) sits after the outcome. Errors render at every level. The
 * detail gating already happened at record time, so this just reads what the row holds.
 */
function renderCommandRow(row: Extract<ActionRow, { kind: 'command' }>): string {
  // args before the arrow (the call that ran) — populated by the row builder at detail≥2.
  const argsPart = row.args_text !== undefined && row.args_text.length > 0 ? ` ${row.args_text}` : '';
  const outcome = row.ok
    ? `ok${row.ref !== undefined ? ` (${row.ref})` : ''}`
    : `err${row.error !== undefined ? ` (${row.error})` : ''}`;
  let line = `[${row.seq}] ${row.verb}${argsPart} → ${outcome}`;
  // result body after the outcome (the observation) — populated at detail=3, success only.
  if (row.result_text !== undefined && row.result_text.length > 0) line += ` ${row.result_text}`;
  return line;
}

/**
 * Render one input row (§4): `[seq] input ← {sender} @{ts}` (+ `"preview"` at L2, or the
 * full `content` at L3). Row-driven: the detail level was applied by the row builder
 * (preview empty at L1, content present only at L3), so the renderer just reads what the
 * row stored — keeping the output a pure function of the row, not a re-gate on config.
 */
function renderInputRow(row: Extract<ActionRow, { kind: 'input' }>): string {
  const who = row.sender !== undefined && row.sender.length > 0 ? row.sender : row.source;
  const head = `[${row.seq}] input ← ${who} @${row.ts}`;
  if (row.content !== undefined && row.content.length > 0) return `${head} ${row.content}`;
  if (row.preview.length > 0) return `${head} "${row.preview}"`;
  return head;
}

// ============================================================================
// The AppManifest
// ============================================================================

/**
 * BaseApp — the concrete `base` BlockApp. Holds the durable jsonl ledger and a
 * monotonic seq counter (high-water seeded from the jsonl tail). `manifest()` produces
 * the AppManifest the AppRegistry installs. Config is seeded from the App's config.json
 * at construction (off the hot path), clamped, then carried in state.
 *
 * The default storage/config base dir is `.block-agent/apps/base/`; tests inject a
 * temp dir so they neither read the repo's real config nor write to it.
 */
export class BaseApp {
  readonly store: ActionLogStore;
  private readonly config: BaseConfig;
  /** The enabled-tool subset (merged from `tools`): config-seeded over BUILTIN_TOOLS. */
  private readonly enabled: string[];
  /** Shared monotonic seq cursor: seeded from the jsonl tail, advanced by `record`. */
  private readonly nextSeqRef: { value: number };

  constructor(baseDir: string = APPS_DIR) {
    const dir = join(baseDir, BASE_APP_ID);
    mkdirSync(dir, { recursive: true });
    this.store = new ActionLogStore(join(dir, LOG_FILE));
    // Seed config from the file over the compiled defaults (never throws at boot), then
    // clamp before it reaches state. The helper is generic over Record<string,unknown>.
    const defaults: Record<string, unknown> = { ...DEFAULT_CONFIG };
    const seeded = readAppConfig(BASE_APP_ID, defaults, baseDir);
    this.config = clampConfig(seeded as unknown as BaseConfig);
    // The enabled-tools subset (merged from the former `tools` app): read an optional
    // `enabled_tools` string array from the same config file (over the BUILTIN_TOOLS
    // default). Config-seeded only — not command-tunable (tools' wasn't either).
    const rawEnabled = (seeded as Record<string, unknown>)['enabled_tools'];
    this.enabled =
      Array.isArray(rawEnabled) && rawEnabled.every((x) => typeof x === 'string')
        ? [...(rawEnabled as string[])]
        : [...BUILTIN_TOOLS];
    // High-water seq seed from the jsonl tail (§3.1) — NOT from the bounded window.
    this.nextSeqRef = { value: this.store.nextSeq() };
  }

  /**
   * The AppManifest to hand to `AppRegistry.install`. Returned widened to the bare
   * `AppManifest` (TEAM CONVENTION — the TS2379 fix); the typed `BaseState`
   * discipline is kept inside the command/builder factories.
   *
   * `recent` boots EMPTY: the bounded window is a live projection of incoming records,
   * not a restart-restore (the full audit is the jsonl; `base.show` reaches it). The
   * seq counter still resumes from the jsonl high-water so a restart never reuses a seq.
   */
  manifest(): AppManifest {
    const store = this.store;
    const nextSeqRef = this.nextSeqRef;
    const initial_state: BaseState = {
      recent: [],
      config: this.config,
      compacted_seq: -1,
      enabled: [...this.enabled],
    };
    const manifest: AppManifest<BaseState> = {
      id: BASE_APP_ID,
      version: '1.0.0',
      depends_on: [],
      tree_namespace: TREE_NAMESPACE,
      initial_state,
      state_schema: STATE_SCHEMA,
      builders: [() => recentActionsBuilder()],
      commands: [
        () => recordCommand(store, nextSeqRef),
        () => showCommand(store),
        () => setConfigCommand(),
        // The bare YIELD: end the turn without replying (group silence / scheduled-wake
        // housekeeping). Hybrid — messages.reply stays sugar for "reply + end_turn".
        () => endTurnCommand(),
        // Tool commands (merged from the former `tools` app), exposed as `base.<tool>`.
        // Capability gates UNCHANGED (§9.4): bash → op:dangerous (agent → pending),
        // http_request → net:http (host-allowlisted), read_file/grep are real reads.
        () =>
          toolCommand(
            'read_file',
            'Read a UTF-8 text file; the body is returned in the command result.',
            [],
            readFileTool,
            { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
          ),
        () =>
          toolCommand(
            'grep',
            'Search a file for a literal substring; matches are returned in the command result.',
            [],
            grepTool,
            {
              type: 'object',
              required: ['pattern', 'path'],
              properties: { pattern: { type: 'string' }, path: { type: 'string' } },
            },
          ),
        () =>
          toolCommand(
            'bash',
            'Run a shell command (DANGEROUS → agent invoker requires approval).',
            [CAP_DANGEROUS],
            bashTool,
            { type: 'object', required: ['command'], properties: { command: { type: 'string' } } },
          ),
        () =>
          toolCommand(
            'http_request',
            'Make an outbound HTTP request (net:http → host-allowlisted for the agent).',
            [CAP_NET_HTTP],
            httpRequestTool,
            {
              type: 'object',
              required: ['url'],
              properties: { url: { type: 'string' }, method: { type: 'string' } },
            },
          ),
      ],
    };
    return manifest as AppManifest;
  }
}

/**
 * makeBaseApp — convenience factory that constructs an `BaseApp` (default storage
 * dir) and returns its manifest, for callers that don't need the App handle. Tests that
 * need a temp dir or the durable store construct `new BaseApp(dir)` directly.
 */
export function makeBaseApp(): AppManifest {
  return new BaseApp().manifest();
}

// Re-export names + defaults + pure helpers for tests / cross-app references.
export {
  TREE_NAMESPACE,
  LOG_FILE,
  MAX_LINE_BYTES,
  clampConfig,
  buildCommandRow,
  buildInputRow,
  pushBounded,
  renderRecent,
};
