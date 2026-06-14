/**
 * apps/task_proxy/src/task_client.ts — TaskServiceClient: out-of-process Task binding.
 *
 * Implements the Task service REST surface (task.md §4) over `fetch`, plus an optional WS
 * `task_changed` subscription (§5). This is the ISOLATED client — same discipline as
 * memory_letta's LettaMemoryStore: the only thing in task_proxy that does network I/O, and
 * the reason `@block-agent/core` never imports task_proxy at runtime (CI core-closure).
 * The manifest's commands declare `net:http`; this file does the actual call.
 *
 * Trust model: the Task service is an external backend. Every response is parsed defensively
 * and deep-copied (via JSON round-trip) before it crosses back into proxy code, so a
 * malformed/oversized payload degrades a single command rather than corrupting state.
 *
 * Graceful degradation: when the service is unreachable, methods THROW a clear error and
 * the calling command returns `{ok:false, error}` — they never crash the turn loop. The
 * WS subscription is best-effort: a connect failure logs and leaves the proxy in the
 * polling-less degraded mode (the runtime still works; it just won't auto-wake on push).
 *
 * IDENTITY (im-proxy.md §7 layer-0): the bearer token is held PRIVATELY here (from
 * `TASK_SERVICE_TOKEN` env, never from state / config / log). The service derives the
 * actor (`creator`) and the effective `owner` filter from the token — the proxy cannot
 * forge another principal's tasks. `claim` = assign to the agent's OWN principal_id, which
 * the proxy reads from the same env-provisioned identity, not from agent-supplied content.
 */

import type {
  Task,
  TaskBoard,
  TaskCreateRequest,
  TaskUpdateRequest,
} from './wire.js';

// ============================================================================
// Client interface (so commands + tests depend on the SHAPE, not the impl)
// ============================================================================

/** A change-frame handler for the WS subscription (§5). */
export type TaskChangeHandler = (task: Task) => void;

/**
 * TaskServiceClient — the network seam task_proxy commands call. The real impl
 * (`HttpTaskServiceClient`) talks to the service; tests inject a fake implementing this
 * same interface (FakeTaskClient) so command forwarding + ingest are tested with zero I/O.
 */
export interface TaskServiceClient {
  /** This client's own principal_id (token subject) — the `claim` assignee + list owner. */
  readonly self: string;

  /** POST /task/create → the created task. */
  create(req: TaskCreateRequest): Promise<Task>;
  /** POST /task/assign → the updated task. */
  assign(id: string, assignee: string): Promise<Task>;
  /** POST /task/start → the updated task (open → in_progress). */
  start(id: string): Promise<Task>;
  /** POST /task/update → the updated task. */
  update(req: TaskUpdateRequest): Promise<Task>;
  /** POST /task/close → the closed/cancelled task. */
  close(id: string, opts?: { cancelled?: boolean; reason?: string }): Promise<Task>;
  /** GET /task/list — folded by the caller into state (owner defaults to self). */
  list(opts?: { owner?: string; status?: string; parent?: string; since?: number }): Promise<Task[]>;
  /** GET /task/board — tasks bucketed by status (derived view). */
  board(opts?: { owner?: string; scope?: 'mine' | 'all' }): Promise<TaskBoard>;

  /**
   * Subscribe to WS `task_changed` frames. Returns immediately; `onChange` fires per frame
   * with the full task (the proxy upserts + wakes). Best-effort: a connect failure is
   * swallowed (the proxy runs degraded). No-op if the client has no WS endpoint.
   */
  subscribe(onChange: TaskChangeHandler): void;

  /** Tear down the WS connection (on_uninstall). NEVER deletes server-side tasks (INV #5). */
  close_connection(): void;
}

// ============================================================================
// Defensive parse — coerce an untrusted JSON body into a Task (deep-copied)
// ============================================================================

/** A finite number or undefined (drops NaN/Infinity/non-number). */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A non-empty string or undefined. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const STATUSES = new Set(['open', 'in_progress', 'done', 'closed', 'cancelled']);

/**
 * Coerce an untrusted JSON value into a Task, deep-copying every field (no live reference
 * to the parsed body crosses into proxy state). Returns null if the minimal shape (id +
 * title + valid status + creator + numeric ts/seq) is missing — the caller treats that as
 * a service error rather than letting a half-task into state.
 *
 * STRICT BY CONTRACT (Architect, non-blocking): `creator`/`ts`/`seq` are required (the
 * contract makes them token-derived / service-assigned), so a missing one drops the WHOLE
 * task. This is deliberate — coercing a missing `creator` to `''` would mask a Services bug.
 * INTEGRATION NOTE: if during Services 联调 a task "vanishes" (created but never appears on
 * the board), this drop is the first place to look — log here before tightening Services,
 * don't loosen this guard.
 */
export function parseTask(v: unknown): Task | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = str(o['id']);
  const title = typeof o['title'] === 'string' ? o['title'] : undefined;
  const status = o['status'];
  const creator = str(o['creator']);
  const ts = num(o['ts']);
  const seq = num(o['seq']);
  if (
    id === undefined ||
    title === undefined ||
    typeof status !== 'string' ||
    !STATUSES.has(status) ||
    creator === undefined ||
    ts === undefined ||
    seq === undefined
  ) {
    return null;
  }
  const task: Task = {
    id,
    title,
    status: status as Task['status'],
    creator,
    ts,
    seq,
  };
  const description = str(o['description']);
  if (description !== undefined) task.description = description;
  const owner = str(o['owner']);
  if (owner !== undefined) task.owner = owner;
  const parent = str(o['parent']);
  if (parent !== undefined) task.parent = parent;
  const priority = num(o['priority']);
  if (priority !== undefined) task.priority = priority;
  const estimate = num(o['estimate']);
  if (estimate !== undefined) task.estimate = estimate;
  const spent = num(o['spent']);
  if (spent !== undefined) task.spent = spent;
  const left = num(o['left']);
  if (left !== undefined) task.left = left;
  const due = str(o['due']);
  if (due !== undefined) task.due = due;
  const finished_at = str(o['finished_at']);
  if (finished_at !== undefined) task.finished_at = finished_at;
  const closed_reason = str(o['closed_reason']);
  if (closed_reason !== undefined) task.closed_reason = closed_reason;
  if (Array.isArray(o['tags'])) {
    const tags = o['tags'].filter((t): t is string => typeof t === 'string');
    if (tags.length > 0) task.tags = tags;
  }
  const ext_id = str(o['ext_id']);
  if (ext_id !== undefined) task.ext_id = ext_id;
  return task;
}

// ============================================================================
// HttpTaskServiceClient — the real REST/WS binding
// ============================================================================

/** Options for the real HTTP client. */
export interface HttpTaskClientOptions {
  /** Service base URL, e.g. http://localhost:8284/task. */
  baseUrl: string;
  /** This client's own principal_id (the token subject). */
  self: string;
  /** Bearer token (from TASK_SERVICE_TOKEN env). Held privately; never logged. */
  token: string;
  /** Optional WS subscribe URL; absent → no push (degraded). */
  wsUrl?: string;
}

/**
 * HttpTaskServiceClient — the production Task-service binding over `fetch` + `WebSocket`.
 *
 * `WebSocket` is lazy-imported (Node 24 exposes a global `WebSocket`; we read it off
 * `globalThis` so a build that never installs this app — or runs builder-only tests —
 * never touches it). A `fetch` failure throws; the calling command degrades.
 */
export class HttpTaskServiceClient implements TaskServiceClient {
  readonly self: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly wsUrl: string | undefined;
  private ws: { close(): void } | null = null;

  constructor(opts: HttpTaskClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.self = opts.self;
    this.token = opts.token;
    this.wsUrl = opts.wsUrl;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`task service ${path} → ${res.status}`);
    return res.json();
  }

  private async get(path: string, query: Record<string, string | undefined>): Promise<unknown> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, v);
    }
    const qs = params.toString();
    const url = `${this.baseUrl}${path}${qs.length > 0 ? `?${qs}` : ''}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`task service ${path} → ${res.status}`);
    return res.json();
  }

  /** Pull `{task}` out of a response body, throwing if the service returned a malformed task. */
  private taskOf(body: unknown, op: string): Task {
    const t = parseTask((body as { task?: unknown } | null)?.task);
    if (t === null) throw new Error(`task service ${op}: malformed task in response`);
    return t;
  }

  async create(req: TaskCreateRequest): Promise<Task> {
    return this.taskOf(await this.post('/create', req), 'create');
  }

  async assign(id: string, assignee: string): Promise<Task> {
    return this.taskOf(await this.post('/assign', { id, assignee }), 'assign');
  }

  async start(id: string): Promise<Task> {
    return this.taskOf(await this.post('/start', { id }), 'start');
  }

  async update(req: TaskUpdateRequest): Promise<Task> {
    return this.taskOf(await this.post('/update', req), 'update');
  }

  async close(id: string, opts: { cancelled?: boolean; reason?: string } = {}): Promise<Task> {
    return this.taskOf(await this.post('/close', { id, ...opts }), 'close');
  }

  async list(
    opts: { owner?: string; status?: string; parent?: string; since?: number } = {},
  ): Promise<Task[]> {
    const body = await this.get('/list', {
      owner: opts.owner,
      status: opts.status,
      parent: opts.parent,
      since: opts.since !== undefined ? String(opts.since) : undefined,
    });
    const rows = (body as { tasks?: unknown } | null)?.tasks;
    if (!Array.isArray(rows)) return [];
    return rows.map(parseTask).filter((t): t is Task => t !== null);
  }

  async board(opts: { owner?: string; scope?: 'mine' | 'all' } = {}): Promise<TaskBoard> {
    const body = await this.get('/board', { owner: opts.owner, scope: opts.scope });
    const cols = (body as { columns?: unknown } | null)?.columns;
    return parseBoard(cols);
  }

  subscribe(onChange: TaskChangeHandler): void {
    if (this.wsUrl === undefined) return;
    const WS = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
    if (WS === undefined) return; // no WS runtime → run degraded (no push)
    try {
      const sock = new WS(`${this.wsUrl}?token=${encodeURIComponent(this.token)}`) as {
        addEventListener(ev: string, cb: (e: { data?: unknown }) => void): void;
        close(): void;
      };
      // A connection failure (Task service absent) is a graceful degrade, never a crash: drop the
      // socket, no live push (render/commands still serve). The global WebSocket doesn't re-throw
      // an unhandled 'error' the way the `ws` EventEmitter does, but handle it for symmetry.
      sock.addEventListener('error', () => {
        this.ws = null;
      });
      sock.addEventListener('message', (e) => {
        let frame: unknown;
        try {
          frame = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
        } catch {
          return; // skip an unparseable frame
        }
        const f = frame as { type?: unknown; task?: unknown };
        if (f.type === 'task_changed' || f.type === 'task_closed') {
          const task = parseTask(f.task);
          if (task !== null) onChange(task);
        }
      });
      this.ws = sock;
    } catch {
      // Best-effort subscription — degrade silently (the proxy still serves render/commands).
      this.ws = null;
    }
  }

  close_connection(): void {
    try {
      this.ws?.close();
    } catch {
      /* already closed — harmless */
    }
    this.ws = null;
  }
}

/** Coerce an untrusted board body into a TaskBoard (every column a Task[]). */
function parseBoard(v: unknown): TaskBoard {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const col = (k: string): Task[] => {
    const rows = o[k];
    if (!Array.isArray(rows)) return [];
    return rows.map(parseTask).filter((t): t is Task => t !== null);
  };
  return {
    open: col('open'),
    in_progress: col('in_progress'),
    done: col('done'),
    closed: col('closed'),
    cancelled: col('cancelled'),
  };
}
