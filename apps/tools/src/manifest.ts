/**
 * apps/tools.ts — the `tools` meta-app (impl-tools owned). Spec: v3.1 §6.7 +
 * ai_com/design/actions-app-architecture.md §3.2/§4.
 *
 * tools is a META-APP: it does not model one domain object, it AGGREGATES the
 * agent's concrete tools — each tool (`read_file` / `grep` / `bash` /
 * `http_request`) is one command tools registers, e.g. `tools.read_file`. There
 * is no separate "tool channel": a tool is just a command, available to every
 * invoker, with per-invoker strictness decided by PolicyEngine (§4 / §9.4).
 *
 * DISPLAY MOVED TO `actions` (no more `tools:recent`): the `actions` app now records
 * + renders EVERY agent command (including tool calls) and their results via the core
 * `onCommand` channel. tools therefore no longer renders its own recent-N projection
 * block — that would DUPLICATE the same tool call in both `tools:recent` and
 * `actions:recent`. tools keeps only EXECUTION: each command runs its tool and returns
 * the result body in `CommandResult.data` (`{ tool, id, result }`). That returned data
 * is the single path the tool output reaches the agent — `actions` captures it via
 * `onCommand` at `command_detail=3`. tools renders NO block and keeps NO recent window.
 *
 * CAPABILITIES & danger (§9.4) — UNCHANGED:
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
 * Contracts only: imports `app/types.js` + `core/types.js`; never the registry or a
 * sibling app. House style (§0.5): block-world nouns get the `Block` prefix; extension
 * unit `BlockApp` + short satellites (`AppManifest` etc.).
 */

import type { InvokerContext } from '@block-agent/core/core/types.js';
import type {
  AppContext,
  AppManifest,
  Capability,
  CommandManifest,
  CommandResult,
  JsonSchema,
} from '@block-agent/core/app/types.js';

// ============================================================================
// Identity & block names
// ============================================================================

/** App id and tree namespace (§6.7). Block names use the bare id prefix (INV #15). */
export const TOOLS_APP_ID = 'tools' as const;
const TREE_NAMESPACE = '/tools' as const;

// ============================================================================
// State (INV #14 — all JSON-serializable + bounded)
// ============================================================================

/**
 * One tool call's result (request + result), returned to the caller in
 * `CommandResult.data` and captured by `actions` via `onCommand`. tools no longer
 * persists these — the record exists only for the duration of one command.
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
 * tools state (§6.7). `enabled` is a string ARRAY not a Set — a Set is a class
 * instance, rejected by INV #14 state validation; the array carries the same meaning
 * ("the set of enabled tool names"). It is the ONLY state tools holds now: the
 * recent-N display moved to `actions`, so there is no recent window and no projection
 * config. JSON + bounded → INV #14.
 */
export interface ToolsState {
  enabled: string[];
}

/** The tools shipped enabled by default. Read-only reads first, then gated tools. */
export const BUILTIN_TOOLS = ['read_file', 'grep', 'bash', 'http_request'] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/**
 * state_schema (INV #14): `enabled` (string array) — required. The registry's
 * set_state Proxy does a shallow required-key check plus the deep JSON-serializable
 * guard (rejects Set/fn/Block).
 */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['enabled'],
  properties: {
    enabled: { type: 'array', items: { type: 'string' } },
  },
};

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

// ============================================================================
// Tool implementations — each produces a ToolCallRecord (request + result)
// ============================================================================
//
// A tool handler returns a ToolCallRecord; the command wrapper (below) returns it as
// `CommandResult.data`. NO handler writes a block op (display moved to `actions`), and
// `build` never runs here — these are command-path handlers, so a real fs read is fine
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
// Command wrapper — enabled gate → run → return result in CommandResult.data
// ============================================================================
//
// Each tool command (a) refuses if the tool is not in `state.enabled` (independent
// of policy), (b) runs the handler, and (c) returns the record body in
// `CommandResult.data` (`{ tool, id, result }`). That returned data is the ONLY path
// the tool output reaches the agent — the `actions` app captures it via `onCommand`
// at `command_detail=3`. tools writes NO block and keeps NO recent window.

/** The runner signature each tool exposes. */
type ToolRunner = (id: string, args: unknown) => Promise<ToolCallRecord>;

function toolCommand(
  tool: BuiltinTool,
  description: string,
  capabilities: Capability[],
  run: ToolRunner,
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

      // Return the record as data — `actions` captures `{ tool, id, result }` via
      // onCommand (command_detail=3). No block op, no state mutation: tools executes
      // tools, `actions` displays them.
      return record.ok
        ? { ok: true, data: { tool, id, result: record.result } }
        : { ok: false, error: record.error ?? `${tool} failed`, data: { tool, id } };
    },
  };
}
// ============================================================================
// The AppManifest
// ============================================================================

/**
 * ToolsApp — the concrete `tools` BlockApp. Produces the AppManifest the AppRegistry
 * installs. tools is now display-free + storage-free: it executes tools and returns
 * their results; the `actions` app records + renders them. The constructor takes a
 * `baseDir` only for signature compatibility with existing wiring/tests; nothing is
 * read from or written to it anymore.
 */
export class ToolsApp {
  // baseDir kept in the signature for compatibility; tools no longer touches disk.
  constructor(_baseDir?: string) {}

  /**
   * The AppManifest to hand to `AppRegistry.install` (§6.7). Returned widened to
   * the bare `AppManifest` (TEAM CONVENTION — the TS2379 fix): the typed
   * `ToolsState` discipline is kept inside the command factories; the runtime state
   * shape is guaranteed by `state_schema` + `initial_state`.
   */
  manifest(): AppManifest {
    const initial_state: ToolsState = {
      enabled: [...BUILTIN_TOOLS],
    };
    const manifest: AppManifest<ToolsState> = {
      id: TOOLS_APP_ID,
      version: '1.0.0',
      depends_on: [],
      tree_namespace: TREE_NAMESPACE,
      initial_state,
      state_schema: STATE_SCHEMA,
      builders: [],
      commands: [
        () =>
          toolCommand(
            'read_file',
            'Read a UTF-8 text file; the body is returned in the command result.',
            [],
            readFile,
            { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
          ),
        () =>
          toolCommand(
            'grep',
            'Search a file for a literal substring; matches are returned in the command result.',
            [],
            grep,
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
            bash,
            { type: 'object', required: ['command'], properties: { command: { type: 'string' } } },
          ),
        () =>
          toolCommand(
            'http_request',
            'Make an outbound HTTP request (net:http → host-allowlisted for the agent).',
            [CAP_NET_HTTP],
            httpRequest,
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
 * makeToolsApp — convenience factory that constructs a `ToolsApp` and returns its
 * manifest, for callers that don't need the App handle.
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
