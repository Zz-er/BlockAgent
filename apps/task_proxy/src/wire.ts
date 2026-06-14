/**
 * apps/task_proxy/src/wire.ts — Task service client wire types (TYPE-ONLY mirror).
 *
 * mirrors @blockai/contracts/task.ts §3 (types) + §4 (REST) + §5 (WS frames).
 *
 * A hand-mirrored, `import type`-only copy of the Task service API contract. task_proxy is
 * NOT allowed a dependency on BlockAI-team (Architect ruling) — instead we re-declare the
 * client-side wire shapes here, header-cited, so a contract drift is caught by review
 * against the SSOT, not by a cross-repo dep. Nothing here has a runtime value (pure
 * interfaces / string-literal unions) — it never enters core's runtime closure
 * (CI core-closure), same discipline as memory_letta isolating the Letta SDK and im_proxy
 * mirroring im.ts.
 *
 * SCOPE (the common-subset contract, NOT ZenTao): the service speaks generic task
 * semantics — no ZenTao proper nouns. `tags` is a generic container (project membership
 * rides it); `ext_id` is the opaque escape hatch the backend adapter uses for idempotent
 * writeback. Task DEPENDENCIES and COMMENTS are v1 DEFERRED (task.md §4.x/§4.y) — there is
 * deliberately no TaskDependency / TaskComment here, and `status` has NO `blocked` state
 * (blocked is a derived view of a dependency edge, and that source is deferred).
 *
 * IDENTITY (task.md §4): `creator` / `owner` are principal_ids. `creator` is SERVICE-
 * derived from the bearer token (never the request body); `owner` (assignee) is set via
 * create/assign. The proxy folds `list?owner=<self>` into state — the service derives the
 * effective owner from the token, so the proxy structurally only ever pulls its own tasks.
 */

/**
 * A task's lifecycle status (task.md §3) — the LOCKED 5-state set:
 *   open | in_progress | done | closed + cancelled (取消).
 * `cancelled` is the 5th state (ZenTao `cancel` maps onto it). `blocked` is intentionally
 * absent — it would be a derived view of a task dependency, and dependencies are v1
 * deferred. `doing` is not used (= in_progress renamed, pointless drift).
 */
export type TaskStatus = 'open' | 'in_progress' | 'done' | 'closed' | 'cancelled';

/**
 * Task — the service's frozen task record (task.md §3). Generic common-subset semantics.
 * `ts` is `updated_ts` (display); `seq` is the global monotonic change sequence (the
 * dedupe / sort key on WS frames). The 工时三元 (estimate/spent/left, hours) is optional.
 */
export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  /** principal_id (assignee); undefined when unassigned. */
  owner?: string;
  /** principal_id — service-derived from the token (ZenTao openedBy). */
  creator: string;
  /** parent task id (single-pointer subtask); undefined at top level. */
  parent?: string;
  priority?: number;
  /** 工时三元 (generic optional numbers, hours). v1 may omit. */
  estimate?: number;
  /** consumed (ZenTao consumed). */
  spent?: number;
  /** estimated remaining (ZenTao left). */
  left?: number;
  /** deadline (generic date string). */
  due?: string;
  /** single completion time (filled on close); does NOT mirror ZenTao's 4 dates. */
  finished_at?: string;
  closed_reason?: string;
  /** generic container: project membership / labels ride this. NOT a structural field. */
  tags?: string[];
  /** escape hatch: the backend adapter stores its native task id here for idempotent writeback. */
  ext_id?: string;
  /** updated_ts (display). */
  ts: number;
  /** global monotonic change sequence. */
  seq: number;
}

// ── REST contract (task.md §4). base: /task, with Authorization: Bearer <token>.
//    creator/actor come from the token, NOT the request body. ──────────────────────────

/** §4.1 POST /task/create — create a task. A non-empty `parent` makes it a subtask. */
export interface TaskCreateRequest {
  title: string;
  description?: string;
  priority?: number;
  due?: string;
  tags?: string[];
  /** principal_id; written to owner. */
  assignee?: string;
  /** parent task id. */
  parent?: string;
  estimate?: number;
}
export interface TaskCreateResponse {
  /** status='open', owner=assignee?, seq assigned. */
  task: Task;
}

/** §4.2 POST /task/assign — assign to an OA-registered principal (assignee=principal_id). */
export interface TaskAssignRequest {
  id: string;
  /** principal_id; OA-validated as a legal principal. */
  assignee: string;
}
export interface TaskAssignResponse {
  task: Task;
}

/** §4.3 POST /task/start — open → in_progress. */
export interface TaskStartRequest {
  id: string;
}
export interface TaskStartResponse {
  task: Task;
}

/**
 * §4.4 POST /task/update — partial update (title/description/priority/due/tags/status
 * + 工时 estimate/spent/left).
 */
export interface TaskUpdateRequest {
  id: string;
  title?: string;
  description?: string;
  priority?: number;
  due?: string;
  tags?: string[];
  status?: TaskStatus;
  estimate?: number;
  spent?: number;
  left?: number;
}
export interface TaskUpdateResponse {
  task: Task;
}

/** §4.5 POST /task/close — soft-delete / close (status→'closed'; cancelled=true → 'cancelled'). */
export interface TaskCloseRequest {
  id: string;
  /** true → status='cancelled'. */
  cancelled?: boolean;
  /** stored as closed_reason. */
  reason?: string;
}
export interface TaskCloseResponse {
  task: Task;
}

/**
 * §4.6 GET /task/list?owner=&status=&parent=&since= — list tasks. (Three-state semantics
 * are SERVER-side and FROZEN — Phase B commit 3a4297b; the proxy passes params through and
 * never computes the union locally.)
 *   - explicit `owner=X`   → strictly that owner's tasks.
 *   - no param             → owner ∪ creator (the token subject's "mine" set).
 *   - no param + `parent`  → opens to owner (list every subtask of the parent).
 *   - `since`              → backfill: only tasks whose seq > since.
 */
export interface TaskListResponse {
  tasks: Task[];
  latest_seq: number;
}

/** §4.7 GET /task/board?owner=&scope=<mine|all> — kanban = tasks bucketed by status (derived view). */
export interface TaskBoard {
  open: Task[];
  in_progress: Task[];
  done: Task[];
  closed: Task[];
  cancelled: Task[];
}
export interface TaskBoardResponse {
  columns: TaskBoard;
}

/**
 * §5 WS push frames. WS /task/subscribe, with token. The service pushes only task changes
 * relevant to this subject. `task.seq` is the dedupe / sort key. Each frame carries the
 * FULL task (not just an id), so the proxy upserts by `task.id` directly.
 */
export type TaskPushFrame =
  | { type: 'task_changed'; task: Task }
  | { type: 'task_closed'; task: Task };
