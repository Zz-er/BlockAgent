/**
 * apps/task.ts — the built-in `task` BlockApp (impl-apps owned).
 *
 * TaskApp is the agent's TASK MANAGER and the canonical "operational data" App: a
 * shared, UI-agnostic command surface (the App's API, §4.2) that agent / user / app
 * invokers all reach through the SAME commands and the SAME mutation gate, tagged only
 * by invoker. There is no "UI-only API" — a web/mobile UI calls `task.add` as
 * `invoker:'user'`, an external task system arrives through the ExternalTaskAdapter as
 * `invoker:'app'` via `task.ingest`, and the agent calls them as tool calls. One
 * command set, one PolicyEngine chokepoint (v3.1 "三方共享操作面").
 *
 * Authoritative design: ai_com/design/blockapp-multi-app-architecture.md §4.2 (command
 * table) + §3.6 (three-audience allowed_invokers) + §3.5/§3.7 (contract provide + wake).
 *
 * One projection block:
 *   - `task:list` — current OPEN tasks, cache_tier `slow_changing` (changes only when a
 *     task is added/updated/completed/removed). No open tasks → `build` returns null
 *     (the block disappears from the prompt).
 *
 * provides: `[{contract:'task_count', via:'count'}]` — `task.count` is an app-facing
 * readonly via that returns a SCALAR number (open-task count), so a StatsApp consuming
 * `task_count` sees the total with zero coupling to TaskApp's identity (§3.2 / §3.5).
 *
 * INVARIANTS held here:
 *   #1 / #16  build PURE + byte-identical; no wall-clock / random in build.
 *   #3 / #15  block name `task:list`; one owner builder for it.
 *   #4        builder owner 'system' (never 'agent').
 *   #5        remove = soft-delete (archive, status→'archived'); physical purge needs
 *             block:delete_physical (agent flatly denied by PolicyEngine, §9.4 / AI-3=B).
 *   #11       count() reads TaskApp's OWN state (provider computes its own number).
 *   #14       state all-JSON + bounded; full log in JSONL.
 *   §12.2     JSONL append-only, ≤64KB/line, advisory lock 'wx', startup tail-truncate.
 *
 * House style (§0.5): block-world nouns → `Block` prefix (`TaskListBlockBuilder`); the
 * App itself is `TaskApp`. Satellites stay short (`AppManifest`/`AppContext`).
 */

import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Block, BlockName, InvokerContext, WakeEvent } from '@block-agent/core/core/types.js';
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

/** App id and tree namespace (§4.2). */
const APP_ID = 'task' as const;
const TREE_NAMESPACE = '/task' as const;

/** The single block this App renders into the prompt (INV #15). */
export const TASK_LIST_BLOCK: BlockName = 'task:list';

/** jsonl file under `.block-agent/apps/task/` (§12.1 / §12.2). */
const TASKS_FILE = 'tasks.jsonl' as const;

/** §12.2: each JSONL line MUST be ≤ 64KB. */
const MAX_LINE_BYTES = 64 * 1024;

/** Timeout (ms) spinning for the advisory lock before giving up. */
const LOCK_TIMEOUT_MS = 5_000;

// ============================================================================
// Domain types
// ============================================================================

/** A task's lifecycle status (§4.2). `archived` is the soft-delete tombstone (INV #5). */
export type TaskStatus = 'open' | 'done' | 'archived';

/** Where a task came from (§4.2). `external` arrives through `task.ingest`. */
export type TaskSource = 'agent' | 'user' | 'external';

/**
 * Task — one task record (§4.2). Bounded JSON (INV #14). `ts` is a deterministic
 * monotonic sequence (NOT a wall-clock) so build stays byte-identical (INV #1 / #16);
 * the App assigns it from a per-instance counter, never `Date.now()`.
 */
export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority?: number;
  due?: string;
  tags?: string[];
  source: TaskSource;
  /**
   * Foreign reference from the external system that assigned this task (via
   * `task.ingest`). This is NOT our primary id — `id` stays an internal deterministic
   * `task_N` so completion/lookup never depend on an external key's shape. Present only
   * for `source:'external'` tasks that carried an `ext_id`.
   */
  ext_id?: string;
  ts: number;
}

// ============================================================================
// Config (file-seeded; user-only `set_config` to retune at runtime)
// ============================================================================

/**
 * TaskConfig — tunable knobs seeded from `.block-agent/apps/task/config.json` over
 * these compiled defaults. Changeable at runtime only by the USER (set_config).
 *   - list_limit — max open tasks rendered into `task:list` (bounded projection).
 */
export interface TaskConfig {
  list_limit: number;
}

/** Compiled defaults. */
const DEFAULT_CONFIG: TaskConfig = {
  list_limit: 50,
};

/** Clamp a config to sane ranges. */
function clampConfig(cfg: TaskConfig): TaskConfig {
  return {
    list_limit: Math.max(1, Math.min(1000, Math.floor(cfg.list_limit))),
  };
}

// ============================================================================
// State (bounded projection — INV #14)
// ============================================================================

/**
 * TaskState — bounded projection of the task list plus config. The FULL ordered log
 * (every add/update/delete) lives in JSONL; state holds the current live tasks
 * (open + done + archived) as a bounded window (INV #14).
 */
export interface TaskState {
  tasks: Task[];
  config: TaskConfig;
}

/** INV #14: declare the schema so set_state is Proxy-validated. */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['tasks', 'config'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'status', 'source', 'ts'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string' },
          priority: { type: 'number' },
          due: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          source: { type: 'string' },
          ext_id: { type: 'string' },
          ts: { type: 'number' },
        },
      },
    },
    config: {
      type: 'object',
      required: ['list_limit'],
      properties: { list_limit: { type: 'number' } },
    },
  },
};

// ============================================================================
// JSONL store — §12.2 discipline (append-only, ≤64KB/line, lock 'wx', tail-truncate)
// ============================================================================

/**
 * A single JSONL record: either an `upsert` (a full Task, used for add/update/status
 * changes — last write per id wins on read) or a `delete` tombstone (physical purge
 * removes the id from the read view). Soft-delete (archive) is just an `upsert` with
 * status `archived` (INV #5 — the record survives, only its status changes).
 */
type StoreRecord =
  | ({ op: 'upsert' } & Task)
  | { op: 'delete'; id: string };

/**
 * TaskJsonlFile — one append-only JSONL file for the task log. Follows §12.2: each line
 * ≤ 64KB, advisory exclusive lock ('wx'), startup tail-truncate of a crash-torn last
 * line. `readLive` folds the log to the latest record per id, dropping physically
 * deleted ids. `rewriteWithout` rebuilds the file for a physical purge.
 */
class TaskJsonlFile {
  private readonly lockPath: string;

  constructor(private readonly path: string) {
    this.lockPath = `${path}.lock`;
    this.truncateIncompleteTail();
  }

  /** Append one record as a single JSONL line under an exclusive advisory lock. */
  append(record: StoreRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_LINE_BYTES) {
      throw new Error(
        `task jsonl line is ${bytes}B, exceeds the ${MAX_LINE_BYTES}B/line limit (§12.2)`,
      );
    }
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

  /**
   * Fold the log to the latest record per id (upsert = current value; delete =
   * physically gone). Returns the live tasks in first-seen order (deterministic).
   */
  readLive(): Task[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const latest = new Map<string, Task>();
    const order: string[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let row: StoreRecord;
      try {
        row = JSON.parse(line) as StoreRecord;
      } catch {
        continue; // skip unparseable (shouldn't happen after tail-truncate)
      }
      if (row.op === 'delete') {
        latest.delete(row.id);
      } else {
        if (!latest.has(row.id)) order.push(row.id);
        const { op: _op, ...task } = row;
        latest.set(row.id, task);
      }
    }
    return order.filter((id) => latest.has(id)).map((id) => latest.get(id)!);
  }

  /** Rewrite the file keeping only live records minus `id` (physical purge). */
  rewriteWithout(id: string): void {
    const live = this.readLive().filter((t) => t.id !== id);
    const release = acquireLock(this.lockPath);
    try {
      const lines = live.map((t) => `${JSON.stringify({ op: 'upsert', ...t })}\n`).join('');
      writeFileSync(this.path, lines, 'utf8');
    } finally {
      release();
    }
  }

  /** §12.2 startup scan: truncate a crash-torn trailing line. */
  private truncateIncompleteTail(): void {
    if (!existsSync(this.path)) return;
    const buf = readFileSync(this.path);
    if (buf.length === 0) return;
    const lastNewline = buf.lastIndexOf(0x0a); // '\n'
    const keep = lastNewline + 1;
    if (keep === buf.length) return;
    const fd = openSync(this.path, 'r+');
    try {
      ftruncateSync(fd, keep);
    } finally {
      closeSync(fd);
    }
  }
}

/** Portable exclusive advisory lock using atomic 'wx' file creation (§12.2). */
function acquireLock(lockPath: string): () => void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new Error(`task jsonl lock timeout on ${lockPath} (held too long)`);
      }
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
// TaskStore — the durable jsonl-backed task log
// ============================================================================

/**
 * TaskStore — owns the single durable jsonl file for one TaskApp instance:
 * `tasks.jsonl` under `.block-agent/apps/task/` (§12.1). Storage dir defaults to that;
 * tests inject a temp dir. Tasks are upserted by id; soft-delete is an upsert with
 * status `archived` (INV #5); physical purge rewrites the file without the id.
 */
export class TaskStore {
  private readonly file: TaskJsonlFile;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = new TaskJsonlFile(join(dir, TASKS_FILE));
  }

  /** Persist (insert or update) a task. */
  upsert(task: Task): void {
    this.file.append({ op: 'upsert', ...task });
  }

  /** Physically remove a task record from the durable log (purge). */
  removePhysical(id: string): void {
    this.file.rewriteWithout(id);
  }

  /** Every live task in the durable log (used to seed projection / tests). */
  readAll(): Task[] {
    return this.file.readLive();
  }
}

// ============================================================================
// Builder — task:list (slow_changing), owner 'system', PURE (INV #4 / #16)
// ============================================================================

/** Narrow an AppContext's state to TaskState; null if missing / wrong shape. */
function taskStateOf(app_ctx: AppContext | undefined): TaskState | null {
  if (app_ctx === undefined) return null;
  const s = app_ctx.state;
  if (typeof s !== 'object' || s === null) return null;
  const cand = s as Partial<TaskState>;
  if (!Array.isArray(cand.tasks) || cand.config == null) return null;
  return s as TaskState;
}

/** Render a task as a single bullet line (deterministic). */
function renderTask(t: Task): string {
  const prio = typeof t.priority === 'number' ? ` (p${t.priority})` : '';
  const due = typeof t.due === 'string' && t.due.length > 0 ? ` [due ${t.due}]` : '';
  return `- ${t.title}${prio}${due}`;
}

/**
 * TaskListBlockBuilder — owner of `task:list`. Renders the current OPEN tasks (bounded
 * by config.list_limit). cache_tier `slow_changing`: it changes only when a task is
 * added/updated/completed/removed, so it sits mid-prompt and stays cache-warm. Pure:
 * reads `state.tasks` + `state.config.list_limit` only (INV #16). Returns null when no
 * task is open (the block disappears — tier-driven shrink, §4.2).
 */
const TaskListBlockBuilder: BuilderManifest = {
  name: 'TaskListBlockBuilder',
  version: '1.0.0',
  owner: 'system', // INV #4: 'agent' illegal.
  app_id: APP_ID,
  inputs: [],
  outputs: [TASK_LIST_BLOCK],
  cache_tier: 'slow_changing',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = taskStateOf(app_ctx);
    if (state === null) return null;
    const open = state.tasks.filter((t) => t.status === 'open').slice(0, state.config.list_limit);
    if (open.length === 0) return null; // no open tasks → block disappears
    const lines = open.map(renderTask);
    return {
      id: TASK_LIST_BLOCK,
      name: TASK_LIST_BLOCK,
      children: [],
      content_text: ['# Open tasks', ...lines].join('\n'),
      content_blob: null,
    };
  },
};

// ============================================================================
// Capabilities
// ============================================================================

const CAP_BLOCK_WRITE: Capability = { name: 'block:write' };
const CAP_BLOCK_DELETE_PHYSICAL: Capability = { name: 'block:delete_physical' };

// ============================================================================
// Command helpers (pure)
// ============================================================================

/** Find a task by id in state, or null. */
function findTask(state: TaskState, id: string): Task | null {
  return state.tasks.find((t) => t.id === id) ?? null;
}

/** A non-empty string arg, or null. */
function readString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Build the optional fields of a task from loosely-typed args (drops bad types). */
function readTaskFields(args: unknown): Partial<Pick<Task, 'description' | 'priority' | 'due' | 'tags'>> {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const out: Partial<Pick<Task, 'description' | 'priority' | 'due' | 'tags'>> = {};
  if (typeof a['description'] === 'string') out.description = a['description'];
  if (typeof a['priority'] === 'number') out.priority = a['priority'];
  if (typeof a['due'] === 'string') out.due = a['due'];
  if (Array.isArray(a['tags']) && a['tags'].every((t) => typeof t === 'string')) {
    out.tags = a['tags'] as string[];
  }
  return out;
}

// ============================================================================
// Commands — add / update / complete / reopen / remove / remove_physical /
//            ingest / list / get / count / set_config
// ============================================================================

/**
 * task.add({title, description?, priority?, due?, tags?}) — create a new OPEN task.
 * All invokers (the default). source = invoker (agent/user); app→external is handled by
 * `ingest`. Returns `{id}`. Persists to jsonl + state.
 */
function addCommand(app: TaskApp): CommandManifest<TaskState> {
  return {
    name: 'add',
    description: 'Create a new task. Provide a `title`; description/priority/due/tags optional.',
    capabilities: [CAP_BLOCK_WRITE],
    args_schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number' },
        due: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    invoke: async (args, ctx, invoker): Promise<CommandResult> => {
      const title = readString((args as { title?: unknown } | undefined)?.title);
      if (title === null) return { ok: false, error: 'add requires a non-empty string `title`' };
      const source: TaskSource = invoker.invoker === 'user' ? 'user' : 'agent';
      const task = app.makeTask({ title, source, ...readTaskFields(args) });
      app.store.upsert(task);
      ctx.set_state((s) => ({ ...(s as TaskState), tasks: [...(s as TaskState).tasks, task] }));
      return { ok: true, data: { id: task.id } };
    },
  };
}

/**
 * task.update({id, patch}) — partial update of a task's mutable fields (incl. status).
 * All invokers. Persists the merged task to jsonl + state. Unknown id → ok:false.
 */
function updateCommand(app: TaskApp): CommandManifest<TaskState> {
  return {
    name: 'update',
    description: 'Partially update a task by id (title/description/priority/due/tags/status).',
    capabilities: [CAP_BLOCK_WRITE],
    args_schema: {
      type: 'object',
      required: ['id', 'patch'],
      properties: {
        id: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'number' },
            due: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            status: { type: 'string' },
          },
        },
      },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = args as { id?: unknown; patch?: unknown } | undefined;
      const id = readString(a?.id);
      if (id === null) return { ok: false, error: 'update requires a non-empty `id`' };
      const cur = findTask(ctx.state as TaskState, id);
      if (cur === null) return { ok: false, error: `task '${id}' not found` };

      const patch = (typeof a?.patch === 'object' && a.patch !== null ? a.patch : {}) as Record<
        string,
        unknown
      >;
      const next: Task = { ...cur, ...readTaskFields(patch) };
      if (typeof patch['title'] === 'string' && patch['title'].length > 0) next.title = patch['title'];
      if (isStatus(patch['status'])) next.status = patch['status'];

      app.store.upsert(next);
      ctx.set_state((s) => replaceTask(s as TaskState, next));
      return { ok: true, data: { id, status: next.status } };
    },
  };
}

/** task.complete({id}) — status → done. All invokers. */
function completeCommand(app: TaskApp): CommandManifest<TaskState> {
  return statusCommand(app, 'complete', 'done', 'Mark a task done by id.');
}

/** task.reopen({id}) — status → open. All invokers. */
function reopenCommand(app: TaskApp): CommandManifest<TaskState> {
  return statusCommand(app, 'reopen', 'open', 'Reopen a task by id (status → open).');
}

/** task.remove({id}) — SOFT delete = archive (status → archived, INV #5). All invokers. */
function removeCommand(app: TaskApp): CommandManifest<TaskState> {
  return statusCommand(
    app,
    'remove',
    'archived',
    'Soft-delete (archive) a task by id. The record is kept; agent self-delete is soft.',
  );
}

/** Shared body for the status-transition convenience commands. */
function statusCommand(
  app: TaskApp,
  name: string,
  status: TaskStatus,
  description: string,
): CommandManifest<TaskState> {
  return {
    name,
    description,
    capabilities: [CAP_BLOCK_WRITE],
    args_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const id = readString((args as { id?: unknown } | undefined)?.id);
      if (id === null) return { ok: false, error: `${name} requires a non-empty \`id\`` };
      const cur = findTask(ctx.state as TaskState, id);
      if (cur === null) return { ok: false, error: `task '${id}' not found` };
      const next: Task = { ...cur, status };
      app.store.upsert(next);
      ctx.set_state((s) => replaceTask(s as TaskState, next));
      return { ok: true, data: { id, status } };
    },
  };
}

/**
 * task.remove_physical({id}) — PHYSICAL (irrecoverable) purge of the store record.
 * Declares `block:delete_physical` → PolicyEngine flatly DENIES the agent invoker
 * (§9.4 default table); `allowed_invokers:['user','app']` additionally gates the invoker
 * (AI-3=B: agent's "free delete" is the SOFT `task.remove`; physical purge is reserved
 * so the agent can never permanently erase an externally-assigned task). user/app pass
 * through; the handler rewrites the jsonl without the record + drops it from state.
 */
function removePhysicalCommand(app: TaskApp): CommandManifest<TaskState> {
  return {
    name: 'remove_physical',
    description:
      'Physically (irrecoverably) purge a task. Requires block:delete_physical — agent invoker is denied (INV #5 / AI-3=B).',
    capabilities: [CAP_BLOCK_DELETE_PHYSICAL],
    allowed_invokers: ['user', 'app'],
    args_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const id = readString((args as { id?: unknown } | undefined)?.id);
      if (id === null) return { ok: false, error: 'remove_physical requires a non-empty `id`' };
      app.store.removePhysical(id);
      ctx.set_state((s) => ({
        ...(s as TaskState),
        tasks: (s as TaskState).tasks.filter((t) => t.id !== id),
      }));
      return { ok: true, data: { id, physical: true } };
    },
  };
}

/**
 * task.ingest({title, ext_id?, ...}) — the external-assignment front door (§4.2 / §3.7).
 * `allowed_invokers:['app','user']` — the AGENT is denied so it can never forge an
 * "external assignment". Persists FIRST → set_state → wakes the runtime with a base-ified
 * WakeEvent labeled source='task', reason='task_arrived', ref=task_id (§3.7: core never
 * learns the "task" concept — it lives in reason/ref). Also exposed as `app.ingest(...)`
 * for the ExternalTaskAdapter.
 */
function ingestCommand(app: TaskApp): CommandManifest<TaskState> {
  return {
    name: 'ingest',
    description: 'Deliver an externally-assigned task (wakes the runtime). App/user only.',
    capabilities: [CAP_BLOCK_WRITE],
    allowed_invokers: ['app', 'user'],
    args_schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        ext_id: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number' },
        due: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    invoke: async (args): Promise<CommandResult> => {
      const a = args as { title?: unknown; ext_id?: unknown } | undefined;
      const title = readString(a?.title);
      if (title === null) return { ok: false, error: 'ingest requires a non-empty string `title`' };
      const ext_id = readString(a?.ext_id);
      const event = app.ingest({
        title,
        ...(ext_id !== null ? { ext_id } : {}),
        ...readTaskFields(args),
      });
      // ingest always raises a base-ified app_event (§3.7); narrow to read reason/ref.
      const woke = event.kind === 'app_event' ? event.reason : event.kind;
      const id = event.kind === 'app_event' ? event.ref : undefined;
      return { ok: true, data: { id, woke } };
    },
  };
}

/**
 * task.list({filter?, sort?, limit?}) — read-only list for UIs + contract consumers.
 * `allowed_invokers:['user','app']` — NOT agent (the agent already sees open tasks via
 * the `task:list` projection block, so this stays out of the agent tool catalog, DR-F).
 * `filter.status` narrows by status; default returns OPEN tasks.
 */
function listCommand(): CommandManifest<TaskState> {
  return {
    name: 'list',
    description: 'List tasks (data). For UIs / contract consumers; not in the agent tool catalog.',
    readonly: true,
    allowed_invokers: ['user', 'app'],
    args_schema: {
      type: 'object',
      properties: {
        filter: { type: 'object', properties: { status: { type: 'string' } } },
        limit: { type: 'number' },
      },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = (typeof args === 'object' && args !== null ? args : {}) as {
        filter?: { status?: unknown };
        limit?: unknown;
      };
      const status = isStatus(a.filter?.status) ? a.filter!.status : 'open';
      let tasks = (ctx.state as TaskState).tasks.filter((t) => t.status === status);
      const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : undefined;
      if (limit !== undefined) tasks = tasks.slice(0, limit);
      return { ok: true, data: { tasks } };
    },
  };
}

/** task.get({id}) — read-only single-task fetch for UIs. `['user','app']`. */
function getCommand(): CommandManifest<TaskState> {
  return {
    name: 'get',
    description: 'Get a single task by id (data). For UIs; not in the agent tool catalog.',
    readonly: true,
    allowed_invokers: ['user', 'app'],
    args_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const id = readString((args as { id?: unknown } | undefined)?.id);
      if (id === null) return { ok: false, error: 'get requires a non-empty `id`' };
      const task = findTask(ctx.state as TaskState, id);
      if (task === null) return { ok: false, error: `task '${id}' not found` };
      return { ok: true, data: { task } };
    },
  };
}

/**
 * task.count({filter?}) — the `task_count` contract's `via`. `readonly:true` +
 * `result_schema:{type:'number'}` (matches the contract's output_schema, R-1).
 * `allowed_invokers:['app','user']` so it never enters the agent tool catalog (DR-F).
 * Returns a SCALAR number = the count of OPEN tasks (the provider computes its own
 * number from its OWN state, INV #11). Produces no ops (pure read).
 */
function countCommand(): CommandManifest<TaskState> {
  return {
    name: 'count',
    description: 'Return the open task count (a scalar number). Contract via; app/user only.',
    readonly: true,
    allowed_invokers: ['app', 'user'],
    result_schema: { type: 'number' },
    capabilities: [],
    args_schema: {
      type: 'object',
      properties: { filter: { type: 'object', properties: { status: { type: 'string' } } } },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = (typeof args === 'object' && args !== null ? args : {}) as {
        filter?: { status?: unknown };
      };
      const status = isStatus(a.filter?.status) ? a.filter!.status : 'open';
      const count = (ctx.state as TaskState).tasks.filter((t) => t.status === status).length;
      return { ok: true, data: count };
    },
  };
}

/**
 * task.set_config({list_limit?}) — retune config at runtime. USER-ONLY
 * (`allowed_invokers:['user']`) so the agent can never change its own list bound
 * (anti-self-modification, same gate as agent_identity.set).
 */
function setConfigCommand(): CommandManifest<TaskState> {
  return {
    name: 'set_config',
    description: 'Retune task config (list_limit). User/UI only.',
    capabilities: [CAP_BLOCK_WRITE],
    allowed_invokers: ['user'],
    args_schema: { type: 'object', properties: { list_limit: { type: 'number' } } },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
      if (typeof a['list_limit'] !== 'number') {
        return { ok: false, error: 'set_config: no valid field (list_limit)' };
      }
      ctx.set_state((s) => {
        const ts = s as TaskState;
        return { ...ts, config: clampConfig({ ...ts.config, list_limit: a['list_limit'] as number }) };
      });
      return { ok: true, data: { updated: ['list_limit'] } };
    },
  };
}

/** Type guard for a TaskStatus value. */
function isStatus(v: unknown): v is TaskStatus {
  return v === 'open' || v === 'done' || v === 'archived';
}

/** Replace a task (by id) in state.tasks with `next` (pure). */
function replaceTask(state: TaskState, next: Task): TaskState {
  return { ...state, tasks: state.tasks.map((t) => (t.id === next.id ? next : t)) };
}

// ============================================================================
// TaskApp — the BlockApp
// ============================================================================

/** Options for constructing a TaskApp. */
export interface TaskAppOptions {
  /** Storage dir (defaults to `.block-agent/apps/task/`). */
  dir?: string;
  /** Base dir for the config-file seed (defaults to `.block-agent/apps`). */
  configBase?: string;
  /** Injectable store for testing (overrides the jsonl store). */
  store?: TaskStore;
}

/**
 * TaskApp — the concrete built-in task BlockApp. `manifest()` produces the AppManifest
 * the AppRegistry installs; the App captures its AppContext in `on_install` so
 * `ingest()` (the external front door) can mutate state + wake the runtime after a
 * durable append. Tests inject a temp dir so the repo's real `.block-agent` is untouched.
 */
export class TaskApp {
  readonly store: TaskStore;
  private readonly seedConfig: TaskConfig;
  private ctx: AppContext<TaskState> | null = null;
  /** Monotonic counter for deterministic task ids within this instance (INV #16). */
  private seq = 0;

  constructor(opts: TaskAppOptions = {}) {
    const dir = opts.dir ?? join(APPS_DIR, APP_ID);
    this.store = opts.store ?? new TaskStore(dir);
    const seeded = readAppConfig(
      APP_ID,
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      opts.configBase ?? APPS_DIR,
    );
    this.seedConfig = clampConfig(seeded as unknown as TaskConfig);
  }

  /**
   * The AppManifest to hand to `AppRegistry.install`. Returned widened to the bare
   * `AppManifest` per the team's locked TS2379 convention.
   */
  manifest(): AppManifest {
    const app = this;
    const manifest: AppManifest<TaskState> = {
      id: APP_ID,
      version: '1.0.0',
      depends_on: [],
      provides: [{ contract: 'task_count', via: 'count' }],
      tree_namespace: TREE_NAMESPACE,
      initial_state: { tasks: [], config: this.seedConfig },
      state_schema: STATE_SCHEMA,
      builders: [() => TaskListBlockBuilder],
      commands: [
        () => addCommand(app),
        () => updateCommand(app),
        () => completeCommand(app),
        () => reopenCommand(app),
        () => removeCommand(app),
        () => removePhysicalCommand(app),
        () => ingestCommand(app),
        () => listCommand(),
        () => getCommand(),
        () => countCommand(),
        () => setConfigCommand(),
      ],
      async on_install(ctx) {
        app.ctx = ctx as AppContext<TaskState>;
      },
    };
    return manifest as AppManifest;
  }

  /** A deterministic task id for this instance (per-instance monotonic counter). */
  nextTaskId(): string {
    this.seq += 1;
    return `task_${this.seq}`;
  }

  /**
   * Build a Task with a deterministic id + monotonic `ts` (NOT a wall-clock, INV #16).
   * `ts` is the same sequence as the id so ordering is stable on replay.
   */
  makeTask(
    input: { title: string; source: TaskSource } & Partial<
      Pick<Task, 'description' | 'priority' | 'due' | 'tags'>
    >,
  ): Task {
    const seq = this.seq + 1;
    this.seq = seq;
    const task: Task = {
      id: `task_${seq}`,
      title: input.title,
      status: 'open',
      source: input.source,
      ts: seq,
    };
    if (input.description !== undefined) task.description = input.description;
    if (input.priority !== undefined) task.priority = input.priority;
    if (input.due !== undefined) task.due = input.due;
    if (input.tags !== undefined) task.tags = input.tags;
    return task;
  }

  /**
   * Deliver an externally-assigned task (the §3.7 front door): durably append it,
   * update the projection state, then wake the runtime. Returns the WakeEvent raised so
   * a demo/test/adapter can assert on it. Throws if the App has not been installed yet.
   * The primary `id` is always our internal deterministic `task_N` so completion/lookup
   * never depend on an external key's shape; `ext_id`, when present, is stored as a
   * SEPARATE foreign-reference field (the WakeEvent's `ref` carries our internal id).
   */
  ingest(
    input: { title: string; ext_id?: string } & Partial<
      Pick<Task, 'description' | 'priority' | 'due' | 'tags'>
    >,
  ): WakeEvent {
    const ctx = this.ctx;
    if (ctx === null) {
      throw new Error('TaskApp.ingest called before install (no AppContext captured)');
    }
    const seq = this.seq + 1;
    this.seq = seq;
    const id = `task_${seq}`;
    const task: Task = {
      id,
      title: input.title,
      status: 'open',
      source: 'external',
      ts: seq,
    };
    if (input.ext_id !== undefined && input.ext_id.length > 0) task.ext_id = input.ext_id;
    if (input.description !== undefined) task.description = input.description;
    if (input.priority !== undefined) task.priority = input.priority;
    if (input.due !== undefined) task.due = input.due;
    if (input.tags !== undefined) task.tags = input.tags;

    // (1) durable write FIRST, so a wake never races ahead of the recorded fact.
    this.store.upsert(task);
    // (2) projection via the schema-validated state machine.
    ctx.set_state((s) => ({ ...(s as TaskState), tasks: [...(s as TaskState).tasks, task] }));
    // (3) wake the runtime (guarded — inert if no runtime is wired, §8.2 seam). Base-ified
    // WakeEvent (§3.7): source='task', reason='task_arrived', ref=the task id; core never
    // learns the "task" concept.
    const event: WakeEvent = {
      kind: 'app_event',
      source: 'task',
      reason: 'task_arrived',
      ref: id,
    };
    ctx.wake?.(event);
    return event;
  }
}

// Re-export for tests / cross-app references.
export { TASKS_FILE, DEFAULT_CONFIG, APPS_DIR };
