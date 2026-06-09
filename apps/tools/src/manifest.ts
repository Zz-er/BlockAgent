/**
 * apps/tools.ts — the `tools` meta-app (impl-tools owned). Spec: v3.1 §6.7 +
 * ARCHITECTURE.md "impl-tools → recent-N projection".
 *
 * tools is a META-APP: it does not model one domain object, it AGGREGATES the
 * agent's concrete tools — each tool (`read_file` / `grep` / `bash` /
 * `http_request`) is one command tools registers, e.g. `tools.read_file`. There
 * is no separate "tool channel": a tool is just a command, available to every
 * invoker, with per-invoker strictness decided by PolicyEngine (§4 / §9.4).
 *
 * RESULT PROJECTION (recent-N window — replaces the old per-id block):
 *   - DURABLE history: every tool call (request + result) is appended in FULL to a
 *     durable append-only jsonl store (`.block-agent/apps/tools/history.jsonl`).
 *     The store is the full log; the prompt only ever sees a bounded window.
 *   - BOUNDED projection: the App holds the most-recent `tool_history_count` calls
 *     in `state.recent`, and ONE builder renders them into a single block
 *     `tools:recent` (cache_tier `volatile` → renders at the tail, §10.2). This
 *     dissolves the v3.1 prefix-scan follow-up: there are no dynamic per-id block
 *     names (`tools:tool_result.<id>`) and no owner-index gap — one static block,
 *     one owner builder (INV #3).
 *   - `build` is PURE (INV #16): it reads `state.recent` only — never the jsonl,
 *     never a clock/random. A tool call (effectful, command path) appends to the
 *     store and updates `state.recent`, dropping the oldest beyond the window.
 *
 * CONFIG (file-seeded + user-only command), via the shared `_app_config` helper:
 *   - `tool_history_count` (how many recent calls to project) is seeded from
 *     `.block-agent/apps/tools/config.json` at construction (missing/bad file →
 *     compiled default, never throws), stored INTO state (so it is schema-validated
 *     INV #14 and projected deterministically), and retunable at runtime ONLY via
 *     `tools.set_config`, which declares `allowed_invokers: ['user']` — the agent
 *     can never change how many of its own tool results it sees (anti-self-mod).
 *
 * CAPABILITIES & danger (§9.4) — UNCHANGED from the per-id design:
 *   `http_request` declares `net:http`; `bash` declares `op:dangerous` → the agent
 *   invoker resolves to `pending` (approval) at the chokepoint, BEFORE the handler
 *   runs. user/app invokers are broader. `read_file` / `grep` are real reads.
 *
 * v3.0 scope: `read_file` / `grep` are real, deterministic reads (safe for any
 * invoker policy admits). `bash` / `http_request` are CONTROLLED SAFE STUBS — they
 * do not spawn a shell or open a socket; they record the requested action so the
 * gating path is exercised end-to-end without an unsandboxed side effect. A later
 * milestone swaps in a real out-of-process executor behind the CredentialGateway /
 * sandbox (§5b / §9.5); the command surface is final.
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

import type { Block, BlockName, InvokerContext } from '@block-agent/core/core/types.js';
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

/** App id and tree namespace (§6.7). Block names use the bare id prefix (INV #15). */
export const TOOLS_APP_ID = 'tools' as const;
const TREE_NAMESPACE = '/tools' as const;

/**
 * The ONE block this App renders: the recent-calls window. cache_tier `volatile`
 * — it changes every tool call, so it renders at the tail (§10.2). This REPLACES
 * the old dynamic per-id `tools:tool_result.<id>` blocks.
 */
export const RECENT_BLOCK: BlockName = 'tools:recent';

// ============================================================================
// State (INV #14 — all JSON-serializable + bounded)
// ============================================================================

/**
 * One recorded tool call: the request (tool + args) and its result (ok + the body
 * text the agent reads + optional error). This is what both the durable jsonl and
 * the bounded `state.recent` window hold; the projection renders it verbatim.
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

/**
 * tools state (§6.7 + recent-N spec). `enabled` is a string ARRAY not a Set — a Set
 * is a class instance, rejected by INV #14 state validation; the array carries the
 * same meaning ("the set of enabled tool names"). `tool_history_count` is the
 * file-seeded, user-tunable projection window. `recent` is the BOUNDED window of
 * the most-recent calls (≤ `tool_history_count`). All JSON + bounded → INV #14.
 */
export interface ToolsState {
  enabled: string[];
  tool_history_count: number;
  recent: ToolCallRecord[];
}

/** The tools shipped enabled by default. Read-only reads first, then gated tools. */
export const BUILTIN_TOOLS = ['read_file', 'grep', 'bash', 'http_request'] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

// ----------------------------------------------------------------------------
// Config (file-seeded; the only file-tunable knob is the projection window).
// ----------------------------------------------------------------------------

/** Config knobs seeded from `.block-agent/apps/tools/config.json` (over these). */
export interface ToolsConfig {
  tool_history_count: number;
}

/** Compiled defaults: project the 5 most-recent calls unless a file/command retunes. */
export const DEFAULT_CONFIG: ToolsConfig = { tool_history_count: 5 };

/** Clamp bounds for `tool_history_count` (0 = render nothing; cap keeps state bounded). */
const MIN_HISTORY = 0;
const MAX_HISTORY = 100;

/** Clamp a proposed history count into [MIN_HISTORY, MAX_HISTORY]; non-finite → default. */
function clampHistoryCount(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_CONFIG.tool_history_count;
  return Math.max(MIN_HISTORY, Math.min(MAX_HISTORY, Math.floor(n)));
}

/**
 * state_schema (INV #14): `enabled` (string array), `tool_history_count` (number),
 * `recent` (array) — all required. The registry's set_state Proxy does a shallow
 * required-key check plus the deep JSON-serializable guard (rejects Set/fn/Block).
 */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['enabled', 'tool_history_count', 'recent'],
  properties: {
    enabled: { type: 'array', items: { type: 'string' } },
    tool_history_count: { type: 'number' },
    recent: { type: 'array' },
  },
};

// ============================================================================
// Durable history store — append-only jsonl, ≤64KB/line, startup tail-truncate
// ============================================================================

/** §12.2: each jsonl line MUST be ≤ 64KB (a longer record is rejected, not torn). */
const MAX_LINE_BYTES = 64 * 1024;

/**
 * ToolHistoryStore — the durable, append-only log of EVERY tool call (§6.7 "full
 * history in the store; projection is a bounded window"). One JSON object per line,
 * each ≤64KB (§12.2). On construction it truncates any crash-torn trailing line so
 * reads only see complete records. This is tools' own store — it deliberately does
 * NOT import messages' JsonlStore (no sibling-app coupling); the discipline is the
 * same but the file/record shape is tools-specific.
 *
 * v3.0 is single-process; appends are synchronous and short. We do not take an
 * advisory lock here (messages does, for its multi-writer inbox); tool calls are
 * driven by the single AgentRuntime turn loop, so there is one writer. If tools
 * ever gains a concurrent writer, add the same lock-file 'wx' mutex messages uses.
 */
export class ToolHistoryStore {
  constructor(private readonly path: string) {
    this.truncateIncompleteTail();
  }

  /** Append one call record as a single jsonl line. Rejects an over-64KB line. */
  append(record: ToolCallRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_LINE_BYTES)
      throw new Error(
        `tools history line is ${bytes}B, exceeds the ${MAX_LINE_BYTES}B/line limit (§12.2)`,
      );
    appendFileSync(this.path, line);
  }

  /** Read all complete records currently in the file (tests / window rebuild). */
  readAll(): ToolCallRecord[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const out: ToolCallRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      out.push(JSON.parse(line) as ToolCallRecord);
    }
    return out;
  }

  /** The most-recent `n` records (the window seed on boot). */
  recent(n: number): ToolCallRecord[] {
    if (n <= 0) return [];
    const all = this.readAll();
    return all.slice(Math.max(0, all.length - n));
  }

  /** §12.2 startup scan: drop a crash-torn trailing line (truncate to last `\n`). */
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
// Capability tokens the dangerous tools declare (gated by PolicyEngine, §9.4)
// ============================================================================
//
// Names match core/policy.ts CAP.* exactly; re-declared here as strings rather
// than importing the policy impl (contracts-only rule). The engine special-cases:
//   - `net:http`     — agent: granted-but-host-scoped (host allowlisting is a
//                      host-side concern, §9.4 H2).
//   - `op:dangerous` — agent: → `pending` (approval, §9.4 "危险命令 → 触发审批流").

/** Outbound HTTP — `http_request` needs it (§9.4 出站网络 host). */
const CAP_NET_HTTP: Capability = { name: 'net:http' };
/** Marks a destructive command → agent invoker resolves to `pending` (§9.4). */
const CAP_DANGEROUS: Capability = { name: 'op:dangerous' };
/** Ordinary tree write — every tool records into the volatile projection. */
const CAP_BLOCK_WRITE: Capability = { name: 'block:write' };

// ============================================================================
// Tool implementations — each produces a ToolCallRecord (request + result)
// ============================================================================
//
// A tool handler returns a ToolCallRecord; the command wrapper (below) appends it
// to the durable store + pushes it into the bounded `state.recent`. The builder
// then projects `state.recent` into `tools:recent`. NO handler writes a block op
// (the projection is builder-driven from state, per the recent-N spec), and `build`
// never runs here — these are command-path handlers, so a real fs read is fine
// (build-determinism INV #16 constrains builders, not commands).

/** Build a success record for a tool call. */
function ok(
  tool: BuiltinTool,
  id: string,
  request: Record<string, unknown> | null,
  result: string,
): ToolCallRecord {
  return { id, tool, request, ok: true, result };
}

/** Build a failure record for a tool call (result body empty, error set). */
function fail(
  tool: BuiltinTool,
  id: string,
  request: Record<string, unknown> | null,
  error: string,
): ToolCallRecord {
  return { id, tool, request, ok: false, result: '', error: `${tool}: ${error}` };
}

// ---- read_file -------------------------------------------------------------

/** `read_file` — read a UTF-8 text file. Real, side-effect-free read. */
async function readFile(id: string, args: unknown): Promise<ToolCallRecord> {
  const request = asRecord(args);
  const path = stringArg(args, 'path');
  if (path === null) return fail('read_file', id, request, 'missing string arg `path`');
  try {
    const { readFile: fsReadFile } = await import('node:fs/promises');
    const text = await fsReadFile(path, 'utf8');
    return ok('read_file', id, request, text);
  } catch (err) {
    return fail('read_file', id, request, err instanceof Error ? err.message : String(err));
  }
}

// ---- grep ------------------------------------------------------------------

/** `grep` — search a file's lines for a literal substring (deterministic). */
async function grep(id: string, args: unknown): Promise<ToolCallRecord> {
  const request = asRecord(args);
  const pattern = stringArg(args, 'pattern');
  const path = stringArg(args, 'path');
  if (pattern === null) return fail('grep', id, request, 'missing string arg `pattern`');
  if (path === null) return fail('grep', id, request, 'missing string arg `path`');
  try {
    const { readFile: fsReadFile } = await import('node:fs/promises');
    const text = await fsReadFile(path, 'utf8');
    const lines = text.split('\n');
    const matches: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.includes(pattern)) matches.push(`${i + 1}:${line}`);
    }
    return ok('grep', id, request, matches.join('\n'));
  } catch (err) {
    return fail('grep', id, request, err instanceof Error ? err.message : String(err));
  }
}

// ---- bash (controlled safe stub) -------------------------------------------

/**
 * `bash` — run a shell command. DANGEROUS: declares `op:dangerous`, so the agent
 * invoker is gated to `pending` BEFORE this runs (§9.4). v3.0 SAFE STUB: records
 * the requested command, does NOT spawn a shell.
 */
async function bash(id: string, args: unknown): Promise<ToolCallRecord> {
  const request = asRecord(args);
  const command = stringArg(args, 'command');
  if (command === null) return fail('bash', id, request, 'missing string arg `command`');
  return ok('bash', id, request, `[bash stub] would run: ${command}`);
}

// ---- http_request (controlled safe stub) -----------------------------------

/**
 * `http_request` — make an outbound HTTP call. Declares `net:http` (§9.4): the
 * agent is granted the token but the host must be allowlisted host-side. v3.0 SAFE
 * STUB: records the requested (method, url), does NOT open a socket.
 */
async function httpRequest(id: string, args: unknown): Promise<ToolCallRecord> {
  const request = asRecord(args);
  const url = stringArg(args, 'url');
  if (url === null) return fail('http_request', id, request, 'missing string arg `url`');
  const method = stringArg(args, 'method') ?? 'GET';
  return ok('http_request', id, request, `[http_request stub] would ${method} ${url}`);
}

// ============================================================================
// Command wrapper — enabled gate → run → durable append + bounded window update
// ============================================================================
//
// Each tool command (a) refuses if the tool is not in `state.enabled` (independent
// of policy), (b) runs the handler, (c) appends the record to the durable store,
// and (d) pushes it into `state.recent`, dropping the oldest beyond the window.

/** The runner signature each tool exposes. */
type ToolRunner = (id: string, args: unknown) => Promise<ToolCallRecord>;

function toolCommand(
  tool: BuiltinTool,
  description: string,
  capabilities: Capability[],
  run: ToolRunner,
  store: ToolHistoryStore,
  argsSchema: JsonSchema,
): CommandManifest<ToolsState> {
  return {
    name: tool,
    description,
    args_schema: argsSchema,
    capabilities,
    async invoke(
      args: unknown,
      ctx: AppContext<ToolsState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      // A disabled tool refuses before doing anything — independent of policy
      // (policy gates by invoker; `enabled` gates the tool category itself).
      if (!ctx.state.enabled.includes(tool)) {
        return { ok: false, error: `${tool}: tool '${tool}' is not enabled`, data: { tool } };
      }

      const id = invocationIdFor(tool, args);
      const record = await run(id, args);

      // (1) durable append FIRST (full history lives in the store).
      store.append(record);
      // (2) update the bounded projection window (drop oldest beyond the count).
      ctx.set_state((s) => ({ ...s, recent: pushBounded(s.recent, record, s.tool_history_count) }));

      // The builder renders `tools:recent` from state; the command returns the
      // record as data (no block op — projection is builder-driven, not op-driven).
      return record.ok
        ? { ok: true, data: { tool, id, result: record.result } }
        : { ok: false, error: record.error ?? `${tool} failed`, data: { tool, id } };
    },
  };
}

/** Append `record`, then keep only the most-recent `count` (drop oldest). */
function pushBounded(
  recent: readonly ToolCallRecord[],
  record: ToolCallRecord,
  count: number,
): ToolCallRecord[] {
  if (count <= 0) return [];
  const next = [...recent, record];
  return next.length > count ? next.slice(next.length - count) : next;
}

// ============================================================================
// set_config — user-only runtime retune of the projection window
// ============================================================================

/** Args for `tools.set_config`. */
interface SetConfigArgs {
  tool_history_count?: number;
}

/**
 * `tools.set_config({ tool_history_count })` — retune how many recent calls are
 * projected. `allowed_invokers: ['user']` makes PolicyEngine DENY invoker `agent`
 * (and `app`) on the invoker gate (precedence step 0, before capabilities), so the
 * agent can never change how many of its own tool results it sees (anti-self-mod,
 * the same gate as `agent_identity.set`). The handler clamps, then commits via
 * `ctx.set_state`. When the window shrinks, the stored `recent` is trimmed to the
 * new bound so the next render honors it immediately.
 */
function setConfigCommand(): CommandManifest<ToolsState> {
  return {
    name: 'set_config',
    description: 'Retune tool_history_count (recent tool calls projected). User-only.',
    capabilities: [CAP_BLOCK_WRITE],
    allowed_invokers: ['user'],
    args_schema: {
      type: 'object',
      properties: { tool_history_count: { type: 'number' } },
    },
    async invoke(
      args: unknown,
      ctx: AppContext<ToolsState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      const a = args as SetConfigArgs | undefined;
      if (a?.tool_history_count === undefined) {
        return { ok: false, error: 'set_config requires `tool_history_count`' };
      }
      const count = clampHistoryCount(a.tool_history_count);
      ctx.set_state((s) => ({
        ...s,
        tool_history_count: count,
        recent: count <= 0 ? [] : s.recent.slice(Math.max(0, s.recent.length - count)),
      }));
      return { ok: true, data: { tool_history_count: count } };
    },
  };
}

// ============================================================================
// RecentToolsBuilder — the single volatile owner of `tools:recent`
// ============================================================================

/**
 * RecentToolsBuilder — owns the single block `tools:recent` (INV #3: one owner per
 * name) and renders the bounded recent-calls window. cache_tier `volatile` — it
 * changes every tool call, so it renders at the tail (§10.2). `owner: 'tool'`
 * (never 'agent', INV #4).
 *
 * INV #16: `build` is PURE — it reads `app_ctx.state.recent` only, never the jsonl,
 * never a clock/random. Same state → byte-identical output (INV #1). Returns null
 * when there is nothing to show this turn (empty window) so the block renders empty.
 */
function recentToolsBuilder(): BuilderManifest {
  return {
    name: 'RecentToolsBuilder',
    version: '1.0.0',
    owner: 'tool', // INV #4: 'agent' is illegal.
    app_id: TOOLS_APP_ID,
    inputs: [],
    outputs: [RECENT_BLOCK],
    cache_tier: 'volatile',
    async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
      const state = app_ctx?.state as ToolsState | undefined;
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

/** Deterministic text projection of the recent-calls window (no clock/random). */
function renderRecent(recent: readonly ToolCallRecord[]): string {
  const blocks = recent.map((r) => {
    const req = r.request === null ? '{}' : canonicalJson(r.request);
    const head = `[${r.id}] ${r.tool} ${req}`;
    const body = r.ok ? r.result : (r.error ?? 'error');
    return `${head}\n${body}`;
  });
  return blocks.join('\n\n');
}

// ============================================================================
// The AppManifest
// ============================================================================

/**
 * ToolsApp — the concrete `tools` BlockApp. Holds the durable history store and
 * produces the AppManifest the AppRegistry installs. Config is seeded from the
 * App's config.json at construction (off the hot path), then carried in state.
 *
 * The default storage/config base dir is `.block-agent/apps/tools/` (§12.1); tests
 * inject a temp dir so they neither read the repo's real config nor write to it.
 */
export class ToolsApp {
  readonly store: ToolHistoryStore;
  private readonly config: ToolsConfig;

  constructor(baseDir: string = APPS_DIR) {
    const dir = join(baseDir, TOOLS_APP_ID);
    mkdirSync(dir, { recursive: true });
    this.store = new ToolHistoryStore(join(dir, 'history.jsonl'));
    // Seed config from the file over the compiled defaults (never throws at boot),
    // then clamp the one numeric knob into range before it reaches state. The
    // helper is generic over `Record<string, unknown>`, so we hand it a record-typed
    // copy of the defaults and re-narrow the one knob we read back.
    const defaults: Record<string, unknown> = { ...DEFAULT_CONFIG };
    const seeded = readAppConfig(TOOLS_APP_ID, defaults, baseDir);
    this.config = { tool_history_count: clampHistoryCount(seeded['tool_history_count']) };
  }

  /**
   * The AppManifest to hand to `AppRegistry.install` (§6.7). Returned widened to
   * the bare `AppManifest` (TEAM CONVENTION — the TS2379 fix): the typed
   * `ToolsState` discipline is kept inside the command/builder factories; the
   * runtime state shape is guaranteed by `state_schema` + `initial_state`.
   */
  manifest(): AppManifest {
    const store = this.store;
    // Seed `recent` from whatever survived in the durable log (restart recovery),
    // bounded to the configured window.
    const initial_state: ToolsState = {
      enabled: [...BUILTIN_TOOLS],
      tool_history_count: this.config.tool_history_count,
      recent: store.recent(this.config.tool_history_count),
    };
    const manifest: AppManifest<ToolsState> = {
      id: TOOLS_APP_ID,
      version: '1.0.0',
      depends_on: [],
      tree_namespace: TREE_NAMESPACE,
      initial_state,
      state_schema: STATE_SCHEMA,
      builders: [() => recentToolsBuilder()],
      commands: [
        () =>
          toolCommand(
            'read_file',
            'Read a UTF-8 text file; result projected into tools:recent.',
            [CAP_BLOCK_WRITE],
            readFile,
            store,
            { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
          ),
        () =>
          toolCommand(
            'grep',
            'Search a file for a literal substring; matches projected into tools:recent.',
            [CAP_BLOCK_WRITE],
            grep,
            store,
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
            [CAP_DANGEROUS, CAP_BLOCK_WRITE],
            bash,
            store,
            { type: 'object', required: ['command'], properties: { command: { type: 'string' } } },
          ),
        () =>
          toolCommand(
            'http_request',
            'Make an outbound HTTP request (net:http → host-allowlisted for the agent).',
            [CAP_NET_HTTP, CAP_BLOCK_WRITE],
            httpRequest,
            store,
            {
              type: 'object',
              required: ['url'],
              properties: { url: { type: 'string' }, method: { type: 'string' } },
            },
          ),
        () => setConfigCommand(),
      ],
    };
    return manifest as AppManifest;
  }
}

/**
 * makeToolsApp — convenience factory that constructs a `ToolsApp` (default storage
 * dir) and returns its manifest, for callers that don't need the App handle. Tests
 * that need a temp dir or the durable store construct `new ToolsApp(dir)` directly.
 */
export function makeToolsApp(): AppManifest {
  return new ToolsApp().manifest();
}

// ============================================================================
// Pure helpers (no IO, no clock, no random)
// ============================================================================

/** Read a string-valued arg by key from an args record; null if absent/non-string. */
function stringArg(args: unknown, key: string): string | null {
  const rec = asRecord(args);
  if (rec === null) return null;
  const v = rec[key];
  return typeof v === 'string' ? v : null;
}

/** Narrow `args` to a plain record (the request payload), or null. */
function asRecord(args: unknown): Record<string, unknown> | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

/**
 * Pull the caller-supplied invocation id, or derive a stable one (no clock/random).
 * A turn's tool_call id maps 1:1 to its record; absent → FNV-1a over (tool, args)
 * so replays of the same call are byte-identical (INV #1 / #16 hygiene).
 */
function invocationIdFor(tool: BuiltinTool, args: unknown): string {
  const explicit = stringArg(args, 'invocation_id');
  if (explicit !== null) return explicit;
  return `${tool}.${fnv1a(`${tool}:${canonicalJson(args)}`)}`;
}

/** Deterministic, stable canonical JSON (sorted keys) for ids + projection text. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
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
