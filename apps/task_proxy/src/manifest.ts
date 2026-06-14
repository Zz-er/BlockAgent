/**
 * apps/task_proxy/src/manifest.ts — the `task_proxy` BlockApp (platform Phase C).
 *
 * task_proxy projects the external **Task service** (task.md, the generic common-subset
 * contract — NOT ZenTao) into agent context as a task board. It is a thin DELTA on the
 * built-in `task` app (`apps/task/src/manifest.ts`): same "list app + pure builder +
 * three-audience command surface" shape, with the local jsonl `TaskStore` swapped for a
 * remote `TaskServiceClient` (HTTP/WS). The proxy implements NO task-flow logic — it only
 * projects service ⇄ Block and forwards commands.
 *
 * Authoritative design: BlockAI-team/docs/blockapps/task-proxy.md (§0 reuse map, §2 board
 * builder, §3 state + client, §4 contracts, §5 ingest, §6 command table). Wire contract:
 * task.md §3/§4/§5, mirrored type-only in `./wire.ts`.
 *
 * Projection blocks:
 *   - `task_proxy:board` (slow_changing) — the kanban: state.tasks bucketed by status into
 *     columns (open / in_progress / done; closed/cancelled only via config.show_columns).
 *   - `task_proxy:mine`  (slow_changing) — the agent's focus view: only owner === self.
 *   Both return null when empty (the block disappears, like `task:list`).
 *
 * provides: `[{contract:'task_count', via:'count'}]` — `task.count` returns the scalar
 * ACTIVE (open+in_progress) task count, reusing the built-in TASK_COUNT contract verbatim
 * so a stats app sees task_proxy's remote count summed with the local task app's, zero
 * coupling.
 *
 * consumes: `[{contract:'org_directory', as:'directory'}]` — the OA directory (provided by
 * oa_proxy as the whole `OrgDirectory{org_id, members[]}` object, combine:'first'); the
 * board builder resolves `owner` (assignee principal_id) to a display name. Task service
 * stores only principal_ids; names live in OA (zero drift). (Architect ruling: `as:'directory'`,
 * object form — the truth is `state.directory.members`, indexed to names in the pure builder.)
 *
 * INVARIANTS held here:
 *   #1 / #16  build PURE + byte-identical; no wall-clock / random in build (reads state only).
 *   #4        builder owner 'system' (never 'agent').
 *   #5        remove = soft (no command physically deletes a SERVER task); remove_physical
 *             is block:delete_physical (agent flatly denied) and only drops the LOCAL state
 *             projection — never a server-side hard delete.
 *   #14       state all-JSON + bounded.
 *   #21-style ingest is app/user-only — the agent can never forge an "external assignment".
 *
 * SECURITY (im-proxy.md §7): the bearer token + the agent's own principal_id live privately
 * in the client (from env), never in state. `claim` assigns to `client.self`, not to any
 * agent-supplied content. The WS `task_changed` payload is CONTENT — it flows into state +
 * the pure builder, and the wake it raises is a base-ified app_event (core never learns the
 * "task" concept). It never touches ctx.identity.
 *
 * House style (§0.5): block-world nouns → `Block` prefix (`TaskBoardBlockBuilder`); the App
 * is `TaskProxyApp`; commands `task_proxy.<name>`; blocks `task_proxy:<name>`.
 */

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
import type { Task, TaskStatus } from './wire.js';
import {
  HttpTaskServiceClient,
  parseTask,
  type TaskServiceClient,
} from './task_client.js';

// ============================================================================
// Identity & block names
// ============================================================================

const APP_ID = 'task_proxy' as const;
const TREE_NAMESPACE = '/task_proxy' as const;

/** The two projection blocks this app renders (INV #15). */
export const BOARD_BLOCK: BlockName = 'task_proxy:board';
export const MINE_BLOCK: BlockName = 'task_proxy:mine';

/** Active statuses: what the board renders by default + what `count` counts. */
const ACTIVE_STATUSES: readonly TaskStatus[] = ['open', 'in_progress'];

/** Default kanban columns, in render order. */
const DEFAULT_COLUMNS: TaskStatus[] = ['in_progress', 'open', 'done'];

/** Human-facing column headers (deterministic, render-only). */
const COLUMN_LABEL: Record<TaskStatus, string> = {
  in_progress: '进行中 (in_progress)',
  open: '待开始 (open)',
  done: '已完成 (done)',
  closed: '已关闭 (closed)',
  cancelled: '已取消 (cancelled)',
};

// ============================================================================
// State (bounded projection — INV #14)
// ============================================================================

/**
 * OrgDirectoryView — the shape consume-refresh folds into `state.directory` from the
 * `org_directory` contract (provided by oa_proxy as the whole OrgDirectory object,
 * combine:'first'). Defensively typed: the real `DirectoryMember` carries more
 * (kind, nullable employee_no, dept fields, roles) but the board only needs to resolve a
 * principal_id to a label, so we read `principal_id` + `name` (+ `display`/`title`) and
 * tolerate every other field, or a missing directory. (Locked with OAproxy: resolve to
 * `name` = the authoritative real name; `display` is the IM presentation name, used only as
 * a fallback before the raw id.)
 */
export interface OrgDirectoryView {
  org_id?: string;
  members?: Array<{ principal_id?: string; display?: string; name?: string; title?: string }>;
}

/** Tunable knobs; user-only `set_config` retunes at runtime. */
export interface TaskProxyConfig {
  /** Max tasks rendered into the board (bounded projection). */
  list_limit: number;
  /** Which status columns to render (subset of TaskStatus, in render order). */
  show_columns: TaskStatus[];
}

const DEFAULT_CONFIG: TaskProxyConfig = {
  list_limit: 50,
  show_columns: DEFAULT_COLUMNS,
};

/**
 * TaskProxyState — bounded projection of the agent's tasks (folded from
 * `list?owner=<self>` + WS upserts) plus the consumed directory + config. The full task
 * truth lives in the Task service; state holds only the agent's active window.
 */
export interface TaskProxyState {
  tasks: Task[];
  /** Folded by consume-refresh from the `org_directory` contract (oa_proxy), `as:'directory'`. */
  directory: OrgDirectoryView;
  config: TaskProxyConfig;
}

/** INV #14: declare the schema so set_state is Proxy-validated. */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['tasks', 'directory', 'config'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'status', 'creator', 'ts', 'seq'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string' },
          owner: { type: 'string' },
          creator: { type: 'string' },
          parent: { type: 'string' },
          priority: { type: 'number' },
          estimate: { type: 'number' },
          spent: { type: 'number' },
          left: { type: 'number' },
          due: { type: 'string' },
          finished_at: { type: 'string' },
          closed_reason: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          ext_id: { type: 'string' },
          ts: { type: 'number' },
          seq: { type: 'number' },
        },
      },
    },
    directory: {
      type: 'object',
      properties: {
        org_id: { type: 'string' },
        members: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              principal_id: { type: 'string' },
              name: { type: 'string' },
              title: { type: 'string' },
            },
          },
        },
      },
    },
    config: {
      type: 'object',
      required: ['list_limit', 'show_columns'],
      properties: {
        list_limit: { type: 'number' },
        show_columns: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

/** Clamp a config to sane ranges (drops unknown columns). */
function clampConfig(cfg: TaskProxyConfig): TaskProxyConfig {
  const known = new Set<TaskStatus>(['open', 'in_progress', 'done', 'closed', 'cancelled']);
  const cols = cfg.show_columns.filter((c): c is TaskStatus => known.has(c));
  return {
    list_limit: Math.max(1, Math.min(1000, Math.floor(cfg.list_limit))),
    show_columns: cols.length > 0 ? cols : DEFAULT_COLUMNS,
  };
}

// ============================================================================
// Capabilities
// ============================================================================

const CAP_BLOCK_WRITE: Capability = { name: 'block:write' };
const CAP_NET_HTTP: Capability = { name: 'net:http' };
const CAP_BLOCK_DELETE_PHYSICAL: Capability = { name: 'block:delete_physical' };

// ============================================================================
// Render helpers (PURE — no clock / random, INV #1 / #16)
// ============================================================================

/** Narrow an AppContext's state to TaskProxyState; null if missing / wrong shape. */
function stateOf(app_ctx: AppContext | undefined): TaskProxyState | null {
  if (app_ctx === undefined) return null;
  const s = app_ctx.state;
  if (typeof s !== 'object' || s === null) return null;
  const cand = s as Partial<TaskProxyState>;
  if (!Array.isArray(cand.tasks) || cand.config == null) return null;
  return s as TaskProxyState;
}

/** Index the consumed directory to principal_id → display name (pure, render-time). */
function nameIndex(dir: OrgDirectoryView | undefined): Map<string, string> {
  const idx = new Map<string, string>();
  const members = dir?.members;
  if (!Array.isArray(members)) return idx;
  for (const m of members) {
    if (typeof m?.principal_id !== 'string') continue;
    // Resolve to `name` = the AUTHORITATIVE real name ("周键清"), per OAproxy's lock. NOT
    // `display` — that is the IM-group presentation name (may be a 花名/nickname). `display`
    // is only a last resort before the raw id. Never assume employee_no (nullable, agent=null).
    const label =
      typeof m.name === 'string' && m.name.length > 0
        ? m.name
        : typeof m.display === 'string' && m.display.length > 0
          ? m.display
          : null;
    if (label !== null) idx.set(m.principal_id, label);
  }
  return idx;
}

/** Resolve an owner principal_id to a display name, falling back to the raw id. */
function ownerName(owner: string | undefined, names: Map<string, string>): string {
  if (owner === undefined) return '未指派';
  return names.get(owner) ?? owner;
}

/** Render a task's optional progress / 工时 / due annotation as a `(…)` suffix, or ''. */
function annotation(t: Task): string {
  const parts: string[] = [];
  if (typeof t.priority === 'number') parts.push(`p${t.priority}`);
  const pct = progressPct(t);
  if (pct !== null) parts.push(`${pct}%`);
  if (typeof t.due === 'string' && t.due.length > 0) parts.push(`截止 ${t.due}`);
  if (typeof t.estimate === 'number' || typeof t.spent === 'number') {
    const est = typeof t.estimate === 'number' ? t.estimate : 0;
    const spent = typeof t.spent === 'number' ? t.spent : 0;
    parts.push(`估${est}h/耗${spent}h`);
  }
  return parts.length > 0 ? `  (${parts.join(' · ')})` : '';
}

/**
 * Progress percent for a task (RENDER-time aggregation, NOT stored — task.md §2 note).
 * Leaf: spent/(spent+left). Parent (`subtasks` present): mean of its subtasks' progress.
 * Returns null when there is no signal (no work logged + no subtasks).
 */
function progressPct(t: Task, subtasks: Task[] = []): number | null {
  if (subtasks.length > 0) {
    const kids = subtasks.map((k) => progressPct(k) ?? (k.status === 'done' ? 100 : 0));
    const mean = kids.reduce((a, b) => a + b, 0) / kids.length;
    return Math.round(mean);
  }
  if (t.status === 'done') return 100;
  const spent = typeof t.spent === 'number' ? t.spent : 0;
  const left = typeof t.left === 'number' ? t.left : 0;
  if (spent + left <= 0) return null;
  return Math.round((spent / (spent + left)) * 100);
}

/** Render one task bullet (with optional subtask aggregation for parents). */
function renderTaskLine(t: Task, names: Map<string, string>, subtasks: Task[], indent: boolean): string {
  const head = indent ? '  - ' : '- ';
  const pct = progressPct(t, subtasks);
  const ann = subtasks.length > 0 ? (pct !== null ? `  (${pct}%)` : '') : annotation(t);
  const sub = indent ? '  (子任务)' : '';
  return `${head}[${t.id}] ${t.title}${sub}${ann}   负责人: ${ownerName(t.owner, names)}`;
}

/**
 * Render the kanban from state — PURE. Groups `tasks` by status into the configured
 * columns; under each top-level task its subtasks (parent === task.id) render indented.
 * Deterministic order: tasks sorted by `seq` (service-assigned monotonic), so byte-identical
 * for the same snapshot (INV #1). Returns null when no column has a task.
 */
function renderBoard(state: TaskProxyState): string | null {
  const names = nameIndex(state.directory);
  const limit = state.config.list_limit;
  const columns = state.config.show_columns;

  // Deterministic ordering by service seq (stable, no clock).
  const all = [...state.tasks].sort((a, b) => a.seq - b.seq);
  const byParent = new Map<string, Task[]>();
  for (const t of all) {
    if (typeof t.parent === 'string') {
      const arr = byParent.get(t.parent) ?? [];
      arr.push(t);
      byParent.set(t.parent, arr);
    }
  }

  const sections: string[] = [];
  let rendered = 0;
  for (const status of columns) {
    const tops = all.filter((t) => t.status === status && typeof t.parent !== 'string');
    if (tops.length === 0) continue;
    const lines: string[] = [`## ${COLUMN_LABEL[status]}`];
    for (const top of tops) {
      if (rendered >= limit) break;
      const kids = byParent.get(top.id) ?? [];
      lines.push(renderTaskLine(top, names, kids, false));
      rendered += 1;
      for (const kid of kids) {
        if (rendered >= limit) break;
        lines.push(renderTaskLine(kid, names, [], true));
        rendered += 1;
      }
    }
    sections.push(lines.join('\n'));
    if (rendered >= limit) break;
  }

  if (sections.length === 0) return null;
  return ['# 任务看板', ...sections].join('\n');
}

// ============================================================================
// Builders — task_proxy:board + task_proxy:mine (slow_changing, owner 'system', PURE)
// ============================================================================

const TaskBoardBlockBuilder: BuilderManifest = {
  name: 'TaskBoardBlockBuilder',
  version: '1.0.0',
  owner: 'system', // INV #4
  app_id: APP_ID,
  inputs: [],
  outputs: [BOARD_BLOCK],
  cache_tier: 'slow_changing',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = stateOf(app_ctx);
    if (state === null) return null;
    const text = renderBoard(state);
    if (text === null) return null; // no active tasks → block disappears
    return { id: BOARD_BLOCK, name: BOARD_BLOCK, children: [], content_text: text, content_blob: null };
  },
};

/**
 * MineBlockBuilder — the agent's focus view: only the agent's OWN active tasks
 * (owner === self), flat list. `self` is captured from the client at manifest build
 * (the agent's principal_id), NOT agent content. Returns null when the agent owns no
 * active task.
 */
function makeMineBlockBuilder(self: string): BuilderManifest {
  return {
    name: 'MineBlockBuilder',
    version: '1.0.0',
    owner: 'system',
    app_id: APP_ID,
    inputs: [],
    outputs: [MINE_BLOCK],
    cache_tier: 'slow_changing',
    async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
      const state = stateOf(app_ctx);
      if (state === null) return null;
      const names = nameIndex(state.directory);
      const mine = [...state.tasks]
        .filter((t) => t.owner === self && ACTIVE_STATUSES.includes(t.status))
        .sort((a, b) => a.seq - b.seq)
        .slice(0, state.config.list_limit);
      if (mine.length === 0) return null;
      const lines = mine.map((t) => renderTaskLine(t, names, [], false));
      return {
        id: MINE_BLOCK,
        name: MINE_BLOCK,
        children: [],
        content_text: ['# 我的任务', ...lines].join('\n'),
        content_blob: null,
      };
    },
  };
}

// ============================================================================
// Command helpers (pure)
// ============================================================================

/** A non-empty string arg, or null. */
function readString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Upsert a task into state.tasks by id (replace if present, else append). */
function upsertTask(state: TaskProxyState, task: Task): TaskProxyState {
  const i = state.tasks.findIndex((t) => t.id === task.id);
  if (i === -1) return { ...state, tasks: [...state.tasks, task] };
  const next = state.tasks.slice();
  next[i] = task;
  return { ...state, tasks: next };
}

/** The error a command returns when the Task backend is unreachable / errored. */
function backendError(op: string, err: unknown): CommandResult {
  const detail = err instanceof Error ? err.message : String(err);
  return { ok: false, error: `task_proxy.${op}: Task service unavailable (${detail})` };
}

// ============================================================================
// Commands — add / split / claim / assign / start / update / complete /
//            ingest / list / count / remove_physical / set_config
// ============================================================================

/** task_proxy.add — create a task (POST /task/create). All invokers. */
function addCommand(client: TaskServiceClient): CommandManifest<TaskProxyState> {
  return {
    name: 'add',
    description: 'Create a new task. Provide a `title`; description/priority/due/tags/estimate/assignee optional.',
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
    args_schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number' },
        due: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        estimate: { type: 'number' },
        assignee: { type: 'string' },
      },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = (args ?? {}) as Record<string, unknown>;
      const title = readString(a['title']);
      if (title === null) return { ok: false, error: 'add requires a non-empty string `title`' };
      try {
        const task = await client.create(buildCreateReq(title, a));
        ctx.set_state((s) => upsertTask(s as TaskProxyState, task));
        return { ok: true, data: { id: task.id, status: task.status } };
      } catch (err) {
        return backendError('add', err);
      }
    },
  };
}

/** task_proxy.split — create a SUBTASK (POST /task/create with parent). All invokers. */
function splitCommand(client: TaskServiceClient): CommandManifest<TaskProxyState> {
  return {
    name: 'split',
    description: 'Split a parent task into a subtask: create a task with `parent` set.',
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
    args_schema: {
      type: 'object',
      required: ['parent', 'title'],
      properties: {
        parent: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number' },
        due: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        estimate: { type: 'number' },
        assignee: { type: 'string' },
      },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = (args ?? {}) as Record<string, unknown>;
      const parent = readString(a['parent']);
      const title = readString(a['title']);
      if (parent === null) return { ok: false, error: 'split requires a non-empty `parent`' };
      if (title === null) return { ok: false, error: 'split requires a non-empty `title`' };
      try {
        const task = await client.create({ ...buildCreateReq(title, a), parent });
        ctx.set_state((s) => upsertTask(s as TaskProxyState, task));
        return { ok: true, data: { id: task.id, parent } };
      } catch (err) {
        return backendError('split', err);
      }
    },
  };
}

/** Build a TaskCreateRequest body from loosely-typed args (drops bad types). */
function buildCreateReq(title: string, a: Record<string, unknown>): import('./wire.js').TaskCreateRequest {
  const req: import('./wire.js').TaskCreateRequest = { title };
  if (typeof a['description'] === 'string') req.description = a['description'];
  if (typeof a['priority'] === 'number') req.priority = a['priority'];
  if (typeof a['due'] === 'string') req.due = a['due'];
  if (Array.isArray(a['tags']) && a['tags'].every((t) => typeof t === 'string')) req.tags = a['tags'] as string[];
  if (typeof a['estimate'] === 'number') req.estimate = a['estimate'];
  if (typeof a['assignee'] === 'string' && a['assignee'].length > 0) req.assignee = a['assignee'];
  return req;
}

/**
 * task_proxy.claim — assign a task to MYSELF (POST /task/assign, assignee = client.self).
 * The agent is itself an OA principal; `self` comes from the env-provisioned client
 * identity, never from agent content. All invokers.
 */
function claimCommand(client: TaskServiceClient): CommandManifest<TaskProxyState> {
  return {
    name: 'claim',
    description: 'Claim a task: assign it to yourself (the agent is its own OA principal).',
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
    args_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const id = readString((args as { id?: unknown } | undefined)?.id);
      if (id === null) return { ok: false, error: 'claim requires a non-empty `id`' };
      try {
        const task = await client.assign(id, client.self);
        ctx.set_state((s) => upsertTask(s as TaskProxyState, task));
        return { ok: true, data: { id, owner: task.owner } };
      } catch (err) {
        return backendError('claim', err);
      }
    },
  };
}

/** task_proxy.assign — assign a task to a principal (POST /task/assign). All invokers. */
function assignCommand(client: TaskServiceClient): CommandManifest<TaskProxyState> {
  return {
    name: 'assign',
    description: 'Assign a task to an OA principal by principal_id (assignee).',
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
    args_schema: {
      type: 'object',
      required: ['id', 'assignee'],
      properties: { id: { type: 'string' }, assignee: { type: 'string' } },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = args as { id?: unknown; assignee?: unknown } | undefined;
      const id = readString(a?.id);
      const assignee = readString(a?.assignee);
      if (id === null) return { ok: false, error: 'assign requires a non-empty `id`' };
      if (assignee === null) return { ok: false, error: 'assign requires a non-empty `assignee`' };
      try {
        const task = await client.assign(id, assignee);
        ctx.set_state((s) => upsertTask(s as TaskProxyState, task));
        return { ok: true, data: { id, owner: task.owner } };
      } catch (err) {
        return backendError('assign', err);
      }
    },
  };
}

/** task_proxy.start — open → in_progress (POST /task/start). All invokers. */
function startCommand(client: TaskServiceClient): CommandManifest<TaskProxyState> {
  return {
    name: 'start',
    description: 'Start a task (open → in_progress).',
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
    args_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const id = readString((args as { id?: unknown } | undefined)?.id);
      if (id === null) return { ok: false, error: 'start requires a non-empty `id`' };
      try {
        const task = await client.start(id);
        ctx.set_state((s) => upsertTask(s as TaskProxyState, task));
        return { ok: true, data: { id, status: task.status } };
      } catch (err) {
        return backendError('start', err);
      }
    },
  };
}

/** task_proxy.update — partial update incl. 工时 (POST /task/update). All invokers. */
function updateCommand(client: TaskServiceClient): CommandManifest<TaskProxyState> {
  return {
    name: 'update',
    description: 'Partially update a task (title/description/priority/due/tags/status + estimate/spent/left).',
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
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
            estimate: { type: 'number' },
            spent: { type: 'number' },
            left: { type: 'number' },
          },
        },
      },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = args as { id?: unknown; patch?: unknown } | undefined;
      const id = readString(a?.id);
      if (id === null) return { ok: false, error: 'update requires a non-empty `id`' };
      const patch = (typeof a?.patch === 'object' && a.patch !== null ? a.patch : {}) as Record<string, unknown>;
      try {
        const task = await client.update(buildUpdateReq(id, patch));
        ctx.set_state((s) => upsertTask(s as TaskProxyState, task));
        return { ok: true, data: { id, status: task.status } };
      } catch (err) {
        return backendError('update', err);
      }
    },
  };
}

/** Build a TaskUpdateRequest from loosely-typed patch args (drops bad types). */
function buildUpdateReq(id: string, patch: Record<string, unknown>): import('./wire.js').TaskUpdateRequest {
  const req: import('./wire.js').TaskUpdateRequest = { id };
  if (typeof patch['title'] === 'string' && patch['title'].length > 0) req.title = patch['title'];
  if (typeof patch['description'] === 'string') req.description = patch['description'];
  if (typeof patch['priority'] === 'number') req.priority = patch['priority'];
  if (typeof patch['due'] === 'string') req.due = patch['due'];
  if (Array.isArray(patch['tags']) && patch['tags'].every((t) => typeof t === 'string')) {
    req.tags = patch['tags'] as string[];
  }
  if (isStatus(patch['status'])) req.status = patch['status'];
  if (typeof patch['estimate'] === 'number') req.estimate = patch['estimate'];
  if (typeof patch['spent'] === 'number') req.spent = patch['spent'];
  if (typeof patch['left'] === 'number') req.left = patch['left'];
  return req;
}

/** task_proxy.complete — close/cancel a task (POST /task/close). All invokers. */
function completeCommand(client: TaskServiceClient): CommandManifest<TaskProxyState> {
  return {
    name: 'complete',
    description: 'Complete a task (close). Pass `cancelled:true` to cancel instead.',
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
    args_schema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, cancelled: { type: 'boolean' }, reason: { type: 'string' } },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = args as { id?: unknown; cancelled?: unknown; reason?: unknown } | undefined;
      const id = readString(a?.id);
      if (id === null) return { ok: false, error: 'complete requires a non-empty `id`' };
      const opts: { cancelled?: boolean; reason?: string } = {};
      if (a?.cancelled === true) opts.cancelled = true;
      if (typeof a?.reason === 'string' && a.reason.length > 0) opts.reason = a.reason;
      try {
        const task = await client.close(id, opts);
        ctx.set_state((s) => upsertTask(s as TaskProxyState, task));
        return { ok: true, data: { id, status: task.status } };
      } catch (err) {
        return backendError('complete', err);
      }
    },
  };
}

/**
 * task_proxy.ingest — the inbound front door for a WS `task_changed` frame (or a poll
 * delta). `allowed_invokers:['app','user']` — the AGENT is denied so it can never forge an
 * "external assignment". Upserts the FULL task by service id (the frame carries the whole
 * task — no internal id re-mint, unlike the built-in task app's ext_id → task_N), then
 * wakes the runtime with a base-ified app_event (source='task_proxy', core never learns the
 * "task" concept). The invoker is host-stamped 'app' (the proxy structurally cannot reach
 * user authority).
 */
function ingestCommand(): CommandManifest<TaskProxyState> {
  return {
    name: 'ingest',
    description: 'Deliver an externally-changed task (wakes the runtime). App/user only.',
    capabilities: [CAP_BLOCK_WRITE],
    allowed_invokers: ['app', 'user'],
    args_schema: {
      type: 'object',
      required: ['task'],
      properties: { task: { type: 'object' } },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const task = parseTask((args as { task?: unknown } | undefined)?.task);
      if (task === null) return { ok: false, error: 'ingest requires a well-formed `task`' };
      ctx.set_state((s) => upsertTask(s as TaskProxyState, task));
      const event: WakeEvent = {
        kind: 'app_event',
        source: APP_ID,
        reason: 'task_updated',
        ref: task.id,
      };
      ctx.wake?.(event);
      return { ok: true, data: { id: task.id, status: task.status } };
    },
  };
}

/**
 * task_proxy.list — read-only list for UIs / contract consumers. `['user','app']` (NOT
 * agent: the agent sees its tasks via the board projection block, DR-F). Reads STATE
 * (the folded projection), not the service — pure, no I/O, so it stays a cheap query.
 */
function listCommand(): CommandManifest<TaskProxyState> {
  return {
    name: 'list',
    description: 'List the projected tasks (data). For UIs / contract consumers; not in the agent tool catalog.',
    readonly: true,
    allowed_invokers: ['user', 'app'],
    args_schema: {
      type: 'object',
      properties: {
        filter: { type: 'object', properties: { status: { type: 'string' }, owner: { type: 'string' } } },
        limit: { type: 'number' },
      },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = (typeof args === 'object' && args !== null ? args : {}) as {
        filter?: { status?: unknown; owner?: unknown };
        limit?: unknown;
      };
      let tasks = (ctx.state as TaskProxyState).tasks;
      if (isStatus(a.filter?.status)) tasks = tasks.filter((t) => t.status === a.filter!.status);
      if (typeof a.filter?.owner === 'string') tasks = tasks.filter((t) => t.owner === a.filter!.owner);
      const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : undefined;
      if (limit !== undefined) tasks = tasks.slice(0, limit);
      return { ok: true, data: { tasks } };
    },
  };
}

/**
 * task_proxy.count — the `task_count` contract's via. Returns the scalar ACTIVE
 * (open+in_progress) task count from this proxy's OWN state (INV #11). `readonly` +
 * `result_schema:{type:'number'}` (matches TASK_COUNT.output_schema, R-1). `['app','user']`
 * so it never enters the agent tool catalog.
 */
function countCommand(): CommandManifest<TaskProxyState> {
  return {
    name: 'count',
    description: 'Return the active (open+in_progress) task count (a scalar number). Contract via; app/user only.',
    readonly: true,
    allowed_invokers: ['app', 'user'],
    result_schema: { type: 'number' },
    capabilities: [],
    args_schema: { type: 'object', properties: {} },
    invoke: async (_args, ctx): Promise<CommandResult> => {
      const count = (ctx.state as TaskProxyState).tasks.filter((t) =>
        ACTIVE_STATUSES.includes(t.status),
      ).length;
      return { ok: true, data: count };
    },
  };
}

/**
 * task_proxy.remove_physical — drop a task from the LOCAL state projection only.
 * `block:delete_physical` → PolicyEngine flatly DENIES the agent; `['user','app']`
 * additionally gates the invoker. CRITICAL (INV #5): this NEVER hard-deletes the server
 * task — the proxy can never erase an externally-assigned task; it only forgets its local
 * projection (a fresh list?owner= would re-pull it).
 */
function removePhysicalCommand(): CommandManifest<TaskProxyState> {
  return {
    name: 'remove_physical',
    description:
      'Drop a task from the LOCAL projection only (never deletes the server task). Requires block:delete_physical — agent denied (INV #5).',
    capabilities: [CAP_BLOCK_DELETE_PHYSICAL],
    allowed_invokers: ['user', 'app'],
    args_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const id = readString((args as { id?: unknown } | undefined)?.id);
      if (id === null) return { ok: false, error: 'remove_physical requires a non-empty `id`' };
      ctx.set_state((s) => ({
        ...(s as TaskProxyState),
        tasks: (s as TaskProxyState).tasks.filter((t) => t.id !== id),
      }));
      return { ok: true, data: { id, local_only: true } };
    },
  };
}

/** task_proxy.set_config — user-only retune (list_limit / show_columns). Anti-self-modify. */
function setConfigCommand(): CommandManifest<TaskProxyState> {
  return {
    name: 'set_config',
    description: 'Retune task_proxy config (list_limit, show_columns). User/UI only.',
    capabilities: [CAP_BLOCK_WRITE],
    allowed_invokers: ['user'],
    args_schema: {
      type: 'object',
      properties: {
        list_limit: { type: 'number' },
        show_columns: { type: 'array', items: { type: 'string' } },
      },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
      const updated: string[] = [];
      ctx.set_state((s) => {
        const cur = s as TaskProxyState;
        const next: TaskProxyConfig = { ...cur.config };
        if (typeof a['list_limit'] === 'number') {
          next.list_limit = a['list_limit'] as number;
          updated.push('list_limit');
        }
        if (Array.isArray(a['show_columns']) && a['show_columns'].every((c) => typeof c === 'string')) {
          next.show_columns = a['show_columns'] as TaskStatus[];
          updated.push('show_columns');
        }
        return { ...cur, config: clampConfig(next) };
      });
      if (updated.length === 0) return { ok: false, error: 'set_config: no valid field (list_limit/show_columns)' };
      return { ok: true, data: { updated } };
    },
  };
}

/** Type guard for a TaskStatus value. */
function isStatus(v: unknown): v is TaskStatus {
  return (
    v === 'open' || v === 'in_progress' || v === 'done' || v === 'closed' || v === 'cancelled'
  );
}

// ============================================================================
// TaskProxyApp — the BlockApp factory
// ============================================================================

/** Options for constructing a TaskProxyApp. */
export interface TaskProxyAppOptions {
  /** Injected client (tests pass a FakeTaskClient). When absent, an HttpTaskServiceClient
   *  is built from env (TASK_SERVICE_URL / TASK_SERVICE_TOKEN / TASK_SERVICE_SELF). */
  client?: TaskServiceClient;
}

/** Read the env-provisioned HTTP client config. Returns null if unconfigured (degraded). */
function clientFromEnv(): TaskServiceClient | null {
  const baseUrl = process.env['TASK_SERVICE_URL'];
  const token = process.env['TASK_SERVICE_TOKEN'];
  const self = process.env['TASK_SERVICE_SELF'];
  if (baseUrl === undefined || token === undefined || self === undefined) return null;
  const opts: import('./task_client.js').HttpTaskClientOptions = { baseUrl, token, self };
  const wsUrl = process.env['TASK_SERVICE_WS'];
  if (wsUrl !== undefined) opts.wsUrl = wsUrl;
  return new HttpTaskServiceClient(opts);
}

/**
 * TaskProxyApp — the concrete task_proxy BlockApp. `manifest()` produces the AppManifest the
 * AppRegistry installs. The App captures its AppContext in `on_install` so the WS
 * subscription can upsert + wake; `on_uninstall` only tears down the connection (INV #5 —
 * never deletes server tasks).
 */
export class TaskProxyApp {
  private readonly client: TaskServiceClient | null;
  private ctx: AppContext<TaskProxyState> | null = null;

  constructor(opts: TaskProxyAppOptions = {}) {
    this.client = opts.client ?? clientFromEnv();
  }

  manifest(): AppManifest {
    const app = this;
    const client = this.client;
    const self = client?.self ?? '';

    const initialState: TaskProxyState = {
      tasks: [],
      directory: {},
      config: { list_limit: DEFAULT_CONFIG.list_limit, show_columns: [...DEFAULT_CONFIG.show_columns] },
    };

    // When no client is configured, install a degraded shell: render-only builders +
    // read-only list/count/set_config (no net commands). Keeps the app installable for
    // builder-only tests / offline boot without throwing.
    const netCommands: Array<() => CommandManifest<TaskProxyState>> = client
      ? [
          () => addCommand(client),
          () => splitCommand(client),
          () => claimCommand(client),
          () => assignCommand(client),
          () => startCommand(client),
          () => updateCommand(client),
          () => completeCommand(client),
        ]
      : [];

    const manifest: AppManifest<TaskProxyState> = {
      id: APP_ID,
      version: '1.0.0',
      depends_on: [],
      // Trusted, in-process — same carrier as the built-in task app + im_proxy (im-proxy.md §6).
      trust: 'trusted',
      host: 'in-process',
      provides: [{ contract: 'task_count', via: 'count' }],
      consumes: [{ contract: 'org_directory', as: 'directory' }],
      tree_namespace: TREE_NAMESPACE,
      initial_state: initialState,
      state_schema: STATE_SCHEMA,
      builders: [() => TaskBoardBlockBuilder, () => makeMineBlockBuilder(self)],
      commands: [
        ...netCommands,
        () => ingestCommand(),
        () => listCommand(),
        () => countCommand(),
        () => removePhysicalCommand(),
        () => setConfigCommand(),
      ],
      async on_install(ctx) {
        app.ctx = ctx as AppContext<TaskProxyState>;
        if (client === null) return; // degraded: no first-screen pull, no subscription

        // First screen: pull the agent's "mine" set via the NO-PARAM `GET /task/list` —
        // task.md §4.6: no-param = owner ∪ creator (assigned-to-me ∪ created-by-me), the
        // token subject's relevant set. This is FROZEN, not a guess: Services implemented it
        // in Phase B (commit 3a4297b — store.ts list + ws_hub.ts fan-out share the same
        // owner∪creator set). The proxy stays THIN: a single literal endpoint call, the union
        // is computed SERVER-side, the proxy does NO local set arithmetic ("语义在服务端").
        // Why no-param (not owner=self): the no-param set is the SAME set §5 WS push maintains,
        // so the boot board ⊇ the WS-maintained set — no backfill gap (an owner=self boot would
        // be a strict subset, and a task the agent created-but-assigned-out would pop in only on
        // a later WS push, an IM-seq-hole-class bug). The agent's focus view is the separate
        // `task_proxy:mine` block, which filters owner===self at RENDER time (builder), so the
        // board = relevant全集, mine = assigned-to-me subset — correct division of labor.
        try {
          const tasks = await client.list();
          if (tasks.length > 0) {
            app.ctx?.set_state((s) => {
              let next = s;
              for (const t of tasks) next = upsertTask(next, t);
              return next;
            });
          }
        } catch {
          // Service unreachable at boot → empty projection, never throw (graceful degrade).
        }

        // Push → wake → ingest: each WS frame upserts + raises a base-ified app_event so
        // the runtime re-renders next turn. Best-effort (no WS endpoint → silently skipped).
        client.subscribe((task) => {
          const c = app.ctx;
          if (c === null) return;
          c.set_state((s) => upsertTask(s, task));
          c.wake?.({ kind: 'app_event', source: APP_ID, reason: 'task_updated', ref: task.id });
        });
      },
      async on_uninstall() {
        // Graceful teardown ONLY: drop the WS connection. NEVER deletes server tasks (INV #5).
        client?.close_connection();
      },
    };
    return manifest as AppManifest;
  }
}

// Re-export wire types for test / consumer convenience.
export type { Task, TaskStatus } from './wire.js';
export { DEFAULT_CONFIG };
