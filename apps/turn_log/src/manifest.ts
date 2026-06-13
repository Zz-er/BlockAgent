/**
 * apps/turn_log/manifest.ts — the `turn_log` BlockApp (the persistent telemetry ledger).
 *
 * turn_log is the ONE writer of `runtime_log.jsonl`, the durable source of truth for the
 * runtime's per-turn telemetry (D1 §4). It subscribes to `AgentRuntime.onTurn` (wired in
 * cli/launch.ts, NOT here) and appends each `TurnRecord` plus a boundary-stamped wall-clock
 * `ts` to the ledger. Many readers — web inspector, budget governor, runtime_stats — READ
 * this one file; exactly one writer (this app) appends to it.
 *
 * Authoritative design: ai_com/design/transparent-context-and-telemetry.md §4 (the ledger),
 * §2.5 (the two-cadence rule), §6 (invariant interactions).
 *
 * Two-cadence rule (§2.5, LOAD-BEARING): the live per-turn stream is telemetry, NOT context.
 * It MUST NOT be rendered into the agent's prompt — a turn_log block in the volatile tier
 * would churn the prompt-cache tail on every single turn (defeating the stable→volatile
 * cache layout, INV #1). So this manifest ships NO render builders and NO agent-facing
 * commands: it is a presence + the store. Any agent-visible rollup is a SEPARATE,
 * slow_changing projection built by another app FROM the ledger, never from the live stream.
 *
 * The wall-clock `ts` is stamped HERE (`Date.now()` at append, called from the boot layer),
 * not in core: core's `TurnRecord` is clock-free (INV #1 / #16 keep core deterministic), and
 * the timestamp is added out-of-core at write time — mirroring how `messages` records carry
 * no clock in state while the jsonl write happens out of band.
 *
 * INVARIANTS held here:
 *   #14    state all-JSON + bounded (empty projection; the truth is the jsonl, not state).
 *   #16    no clock in `build` — there is no builder; the only `Date.now()` is at the boot
 *          append seam (cli/launch.ts), legal because it is app/boot layer, not a builder.
 *   §12.2  JSONL append-only, ≤64KB/line, advisory lock 'wx', startup tail-truncate.
 *
 * House style (§0.5): the App itself is `TurnLogApp`; the store is `TurnLogStore`.
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

import type { TurnRecord } from '@block-agent/core/core/types.js';
import type { AppContext, AppManifest, JsonSchema } from '@block-agent/core/app/types.js';
import { APPS_DIR } from '@block-agent/core/apps/_app_config.js';

// ============================================================================
// Identity & file names
// ============================================================================

/** App id and tree namespace (§4). The APP is `turn_log`; the FILE is `runtime_log.jsonl`. */
const APP_ID = 'turn_log' as const;
const TREE_NAMESPACE = '/turn_log' as const;

/** jsonl ledger under `.block-agent/apps/turn_log/` (§12.1 / §12.2). NOTE the name diverges
 *  from the app id on purpose (D1 §4): the FILE is `runtime_log.jsonl`. */
const RUNTIME_LOG_FILE = 'runtime_log.jsonl' as const;

/** §12.2: each JSONL line MUST be ≤ 64KB. */
const MAX_LINE_BYTES = 64 * 1024;

/** Timeout (ms) spinning for the advisory lock before giving up. */
const LOCK_TIMEOUT_MS = 5_000;

// ============================================================================
// Ledger record
// ============================================================================

/**
 * LedgerRecord — what actually lands in `runtime_log.jsonl`: a `TurnRecord` (core's
 * clock-free telemetry envelope) plus the wall-clock `ts` stamped at write time (§4). `ts`
 * is the only non-core field; it is added by the boot-layer subscriber, never by core.
 */
export type LedgerRecord = TurnRecord & { ts: number };

// ============================================================================
// jsonl store — append-only, advisory-locked, ≤64KB/line, startup truncate (§12.2)
// ============================================================================

/**
 * JsonlStore — one append-only file under the app's storage dir, written per §12.2. Reuses
 * the messages-store discipline verbatim: construction truncates a crash-torn trailing line
 * so reads only ever see complete records; `append` holds an exclusive advisory lock for the
 * duration of the write so concurrent writers never interleave a partial line (Node
 * `O_APPEND` does NOT guarantee whole-line atomicity across fds, hence the explicit lock).
 */
export class JsonlStore {
  private readonly lockPath: string;

  constructor(private readonly path: string) {
    this.lockPath = `${path}.lock`;
    this.truncateIncompleteTail();
  }

  /**
   * Append one record as a single jsonl line, under an exclusive advisory lock. Throws if
   * the serialized line would exceed MAX_LINE_BYTES (§12.2: a longer record means a bug
   * upstream — silently truncating would corrupt it).
   */
  append(record: unknown): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_LINE_BYTES)
      throw new Error(
        `turn_log jsonl line is ${bytes}B, exceeds the ${MAX_LINE_BYTES}B/line limit (§12.2)`,
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

  /** Read all complete records currently in the file (used by readers/tests). */
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
   * §12.2 startup scan: the last line may be a torn write from a crash. Truncate the file to
   * the last complete `\n` so no reader ever parses a partial record. A file that is empty or
   * already ends cleanly is left untouched.
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
 * Acquire an exclusive advisory lock and return a release thunk. The architecture specifies
 * `flock` LOCK_EX; `flock(2)` is not portable from Node (absent on Windows), so we use the
 * portable equivalent: an atomic exclusive lock FILE created with the `wx` flag (fails if it
 * already exists), spinning briefly for a concurrent holder to release. Same guarantee the
 * spec wants — one writer appends at a time. (Same caveat as the messages store: no
 * stale-holder reaping; low risk for v3.0 single-process.)
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
        throw new Error(`turn_log jsonl lock timeout on ${lockPath} (held too long)`);
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
// TurnLogStore — the jsonl-backed durable telemetry ledger
// ============================================================================

/**
 * TurnLogStore — owns the durable `runtime_log.jsonl` for one turn_log App instance. The
 * boot-layer `onTurn` subscriber (cli/launch.ts) calls `append` once per turn; readers
 * (inspector, budget governor, runtime_stats) call `readAll`. Storage dir defaults to
 * `.block-agent/apps/turn_log/` (§12.1); tests inject a temp dir.
 */
export class TurnLogStore {
  readonly log: JsonlStore;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.log = new JsonlStore(join(dir, RUNTIME_LOG_FILE));
  }

  /** Append one ledger record (a TurnRecord already carrying its stamped `ts`) to the log. */
  append(record: LedgerRecord): void {
    this.log.append(record);
  }

  /** Every ledger record currently in the file (used by readers/recovery/tests). */
  readAll(): LedgerRecord[] {
    return this.log.readAll() as LedgerRecord[];
  }
}

// ============================================================================
// State — empty projection (the truth is the jsonl, never state) — INV #14
// ============================================================================

/** TurnLogState — deliberately empty. The persistent truth is the jsonl ledger, not state;
 *  this app renders nothing into the prompt (two-cadence rule §2.5). */
export interface TurnLogState {}

/** Empty initial state. */
const INITIAL_STATE: TurnLogState = {};

/** Permissive empty schema — no required keys, the projection carries no state (INV #14). */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
};

// ============================================================================
// TurnLogApp — the BlockApp
// ============================================================================

/** Options for constructing a TurnLogApp. */
export interface TurnLogAppOptions {
  /** Storage dir (defaults to `.block-agent/apps/turn_log/`). */
  dir?: string;
  /** Injectable store for testing (overrides the jsonl store). */
  store?: TurnLogStore;
}

/**
 * TurnLogApp — the concrete built-in telemetry-ledger BlockApp. `manifest()` produces the
 * AppManifest the AppRegistry installs; the App owns the `TurnLogStore`. It carries NO
 * agent-facing commands and NO render builders (two-cadence rule §2.5) — the actual ledger
 * write is wired in cli/launch.ts via `runtime.onTurn(...)`, which calls `store.append`. The
 * app's presence is what gives the launcher a place to hang that subscription.
 */
export class TurnLogApp {
  readonly store: TurnLogStore;
  private ctx: AppContext<TurnLogState> | null = null;

  constructor(opts: TurnLogAppOptions = {}) {
    const dir = opts.dir ?? join(APPS_DIR, APP_ID);
    this.store = opts.store ?? new TurnLogStore(dir);
  }

  /**
   * The AppManifest to hand to `AppRegistry.install`. Returned widened to the bare
   * `AppManifest` per the team's locked TS2379 convention. No `provides`/`consumes` (this app
   * neither offers nor consumes a contract), no builders, no commands.
   */
  manifest(): AppManifest {
    const app = this;
    const manifest: AppManifest<TurnLogState> = {
      id: APP_ID,
      version: '1.0.0',
      depends_on: [],
      tree_namespace: TREE_NAMESPACE,
      initial_state: INITIAL_STATE,
      state_schema: STATE_SCHEMA,
      builders: [],
      commands: [],
      async on_install(ctx) {
        app.ctx = ctx as AppContext<TurnLogState>;
      },
    };
    return manifest as AppManifest;
  }
}
