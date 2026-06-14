/**
 * test/task_proxy.test.ts — unit tests for the task_proxy BlockApp.
 *
 * Strategy (mirrors apps/memory_letta/test): inject a FakeTaskClient — no real Task
 * service, no network, no WS. Drive the manifest's command factories + builders against a
 * minimal AppContext / BuildContext stub. Assertions:
 *   - board render is PURE + byte-identical for the same state (INV #1), columns + subtask
 *     indent + progress/工时 aggregation + assignee-name resolution.
 *   - claim/assign/start/complete/add/split/update forward to the right client method and
 *     upsert the returned task into state.
 *   - ingest upserts + raises a base-ified app_event wake; agent invoker is barred.
 *   - the 5-state set is honored; closed/cancelled hidden by default, shown via config.
 *   - org_directory consume (state.directory.members) resolves owner → display name.
 *   - count returns the scalar active count (the task_count via).
 *   - remove_physical is block:delete_physical + ['user','app'] (agent denied), local-only.
 *   - set_config is user-only.
 *   - a no-client (degraded) manifest still installs with render + read-only commands.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  AppContext,
  AppManifest,
  BuildContext,
  BuilderManifest,
  CommandManifest,
} from '@block-agent/core/app/types.js';
import type { BlockName, BlockSnapshot, InvokerContext, WakeEvent } from '@block-agent/core/core/types.js';
import {
  TaskProxyApp,
  type TaskProxyState,
  BOARD_BLOCK,
  MINE_BLOCK,
} from '../src/manifest.js';
import type {
  Task,
  TaskBoard,
  TaskCreateRequest,
  TaskUpdateRequest,
} from '../src/wire.js';
import type { TaskChangeHandler, TaskServiceClient } from '../src/task_client.js';

// ============================================================================
// FakeTaskClient — in-memory stub, no network / no WS
// ============================================================================

let seq = 0;

function makeTask(partial: Partial<Task> & { id: string; title: string }): Task {
  seq += 1;
  return {
    status: 'open',
    creator: 'p_creator',
    ts: seq,
    seq,
    ...partial,
  };
}

class FakeTaskClient implements TaskServiceClient {
  readonly self: string;
  readonly tasks = new Map<string, Task>();
  readonly calls: Array<{ op: string; args: unknown }> = [];
  private handler: TaskChangeHandler | null = null;
  closed = false;

  constructor(self = 'p_self', seed: Task[] = []) {
    this.self = self;
    for (const t of seed) this.tasks.set(t.id, t);
  }

  private record(op: string, args: unknown): void {
    this.calls.push({ op, args });
  }

  async create(req: TaskCreateRequest): Promise<Task> {
    this.record('create', req);
    seq += 1;
    const t = makeTask({
      id: `t_${seq}`,
      title: req.title,
      creator: this.self,
      ...(req.assignee !== undefined ? { owner: req.assignee } : {}),
      ...(req.parent !== undefined ? { parent: req.parent } : {}),
      ...(req.estimate !== undefined ? { estimate: req.estimate } : {}),
    });
    this.tasks.set(t.id, t);
    return t;
  }

  async assign(id: string, assignee: string): Promise<Task> {
    this.record('assign', { id, assignee });
    const t = { ...this.require(id), owner: assignee };
    this.tasks.set(id, t);
    return t;
  }

  async start(id: string): Promise<Task> {
    this.record('start', { id });
    const t: Task = { ...this.require(id), status: 'in_progress' };
    this.tasks.set(id, t);
    return t;
  }

  async update(req: TaskUpdateRequest): Promise<Task> {
    this.record('update', req);
    const { id, ...patch } = req;
    const t = { ...this.require(id), ...patch } as Task;
    this.tasks.set(id, t);
    return t;
  }

  async close(id: string, opts: { cancelled?: boolean; reason?: string } = {}): Promise<Task> {
    this.record('close', { id, ...opts });
    const t: Task = {
      ...this.require(id),
      status: opts.cancelled === true ? 'cancelled' : 'done',
      ...(opts.reason !== undefined ? { closed_reason: opts.reason } : {}),
    };
    this.tasks.set(id, t);
    return t;
  }

  async list(opts: { owner?: string } = {}): Promise<Task[]> {
    this.record('list', opts);
    const all = [...this.tasks.values()];
    // Explicit owner=X → strict owner filter. No-param → owner ∪ creator for the token
    // subject (this.self), mirroring task.md §4.6 list semantics.
    if (opts.owner !== undefined) return all.filter((t) => t.owner === opts.owner);
    return all.filter((t) => t.owner === this.self || t.creator === this.self);
  }

  async board(): Promise<TaskBoard> {
    this.record('board', {});
    const empty: TaskBoard = { open: [], in_progress: [], done: [], closed: [], cancelled: [] };
    for (const t of this.tasks.values()) empty[t.status].push(t);
    return empty;
  }

  subscribe(onChange: TaskChangeHandler): void {
    this.handler = onChange;
  }

  close_connection(): void {
    this.closed = true;
  }

  /** Test hook: simulate a WS push frame. */
  push(task: Task): void {
    this.handler?.(task);
  }

  private require(id: string): Task {
    const t = this.tasks.get(id);
    if (t === undefined) throw new Error(`fake: no task ${id}`);
    return t;
  }
}

// ============================================================================
// Minimal AppContext stub (captures wakes for ingest tests)
// ============================================================================

interface StubCtx extends AppContext<TaskProxyState> {
  wakes: WakeEvent[];
}

function makeCtx(initial: TaskProxyState): StubCtx {
  let state = initial;
  const wakes: WakeEvent[] = [];
  return {
    app_id: 'task_proxy',
    get state() {
      return state;
    },
    set_state(updater) {
      state = updater(state);
    },
    list_commands: () => [],
    list_builders: () => [],
    list_blocks: () => [],
    async invoke_command() {
      return { ok: true };
    },
    async read() {
      return [];
    },
    on() {},
    emit() {},
    spawn_system_agent() {
      return { id: 'fake', stop() {} };
    },
    wake(e: WakeEvent) {
      wakes.push(e);
    },
    wakes,
  };
}

function makeInvoker(role: 'user' | 'agent' | 'app' = 'agent'): InvokerContext {
  return { invoker: role };
}

function emptyState(overrides: Partial<TaskProxyState> = {}): TaskProxyState {
  return {
    tasks: [],
    directory: {},
    config: { list_limit: 50, show_columns: ['in_progress', 'open', 'done'] },
    ...overrides,
  };
}

// ============================================================================
// Manifest reflection helpers
// ============================================================================

function getCommand(manifest: AppManifest, name: string): CommandManifest<TaskProxyState> {
  const factory = manifest.commands.find((f) => f(emptyState() as never).name === name);
  if (!factory) throw new Error(`Command '${name}' not found`);
  return factory(emptyState() as never) as CommandManifest<TaskProxyState>;
}

function hasCommand(manifest: AppManifest, name: string): boolean {
  return manifest.commands.some((f) => f(emptyState() as never).name === name);
}

function getBuilder(manifest: AppManifest, outputBlock: BlockName): BuilderManifest {
  const factory = manifest.builders.find((f) =>
    f(emptyState() as never).outputs.includes(outputBlock),
  );
  if (!factory) throw new Error(`Builder for '${outputBlock}' not found`);
  return factory(emptyState() as never);
}

// ============================================================================
// Minimal BuildContext (INV #16 — deterministic, no I/O)
// ============================================================================

const FAKE_SNAPSHOT: BlockSnapshot = {
  root: {
    id: 'root',
    name: 'core:root' as BlockName,
    children: [],
    content_text: null,
    content_blob: null,
  },
  hash: 'fake-hash',
  get: () => null,
};

const FAKE_BUILD_CTX: BuildContext = {
  snapshot: FAKE_SNAPSHOT,
  read: () => null,
  deterministic_clock: () => 0,
  deterministic_random: () => 0,
  content_addressed_id: (s: string) => `sha-${s.slice(0, 8)}`,
  config: {},
};

/** Build a block via a builder against a state, returning content_text (or null). */
async function renderBlock(
  manifest: AppManifest,
  block: BlockName,
  state: TaskProxyState,
): Promise<string | null> {
  const builder = getBuilder(manifest, block);
  const ctx = makeCtx(state);
  const out = await builder.build(FAKE_BUILD_CTX, ctx);
  return out?.content_text ?? null;
}

beforeEach(() => {
  seq = 0;
});

// ============================================================================
// Board builder — render, columns, subtasks, names (INV #1 byte-identical)
// ============================================================================

describe('task_proxy:board builder', () => {
  it('returns null when there are no active tasks (block disappears)', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    expect(await renderBlock(manifest, BOARD_BLOCK, emptyState())).toBeNull();
    // only closed/cancelled present, default columns → still null
    const state = emptyState({
      tasks: [
        makeTask({ id: 't_1', title: 'old', status: 'closed' }),
        makeTask({ id: 't_2', title: 'gone', status: 'cancelled' }),
      ],
    });
    expect(await renderBlock(manifest, BOARD_BLOCK, state)).toBeNull();
  });

  it('renders columns in config order with assignee names from org_directory', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    const state = emptyState({
      directory: {
        members: [
          { principal_id: 'p_zk', name: '周键清', title: '工程师' },
          { principal_id: 'p_zr', name: '朱铫尧' },
        ],
      },
      tasks: [
        makeTask({ id: 't_12', title: '仿真服务 WS 封装', status: 'in_progress', owner: 'p_zk', priority: 1, estimate: 64, spent: 20, due: '06-29' }),
        makeTask({ id: 't_30', title: 'Domain 接入', status: 'open', owner: 'p_zr' }),
        makeTask({ id: 't_31', title: 'handler 骨架', status: 'open', owner: 'p_zr', parent: 't_30' }),
        makeTask({ id: 't_28', title: '接口定义', status: 'done', owner: 'p_zk' }),
      ],
    });
    const text = await renderBlock(manifest, BOARD_BLOCK, state);
    expect(text).not.toBeNull();
    // columns present in order in_progress → open → done
    const t = text!;
    expect(t.indexOf('进行中')).toBeLessThan(t.indexOf('待开始'));
    expect(t.indexOf('待开始')).toBeLessThan(t.indexOf('已完成'));
    // name resolution + 工时 annotation
    expect(t).toContain('负责人: 周键清');
    expect(t).toContain('负责人: 朱铫尧');
    expect(t).toContain('估64h/耗20h');
    // subtask indented under its parent
    expect(t).toContain('  - [t_31] handler 骨架  (子任务)');
  });

  it('resolves to DirectoryMember.name (real name), not display (locked with OAproxy)', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    const state = emptyState({
      directory: {
        org_id: 'org_1',
        members: [
          // name = real name, display = IM 花名 → name wins
          { principal_id: 'p_a', name: '张三', display: '三哥', title: 'PM' },
          // no name → falls back to display
          { principal_id: 'p_b', display: '李四(花名)' },
        ],
      },
      tasks: [
        makeTask({ id: 't_1', title: 'a', status: 'open', owner: 'p_a' }),
        makeTask({ id: 't_2', title: 'b', status: 'open', owner: 'p_b' }),
      ],
    });
    const t = (await renderBlock(manifest, BOARD_BLOCK, state))!;
    expect(t).toContain('负责人: 张三'); // real name
    expect(t).not.toContain('三哥'); // not the 花名
    expect(t).toContain('负责人: 李四(花名)'); // display only as fallback when name absent
  });

  it('is byte-identical for the same snapshot (INV #1)', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    const mk = () =>
      emptyState({
        tasks: [
          makeTaskFixed('t_2', 'second', 'open', 2),
          makeTaskFixed('t_1', 'first', 'in_progress', 1),
        ],
      });
    const a = await renderBlock(manifest, BOARD_BLOCK, mk());
    const b = await renderBlock(manifest, BOARD_BLOCK, mk());
    expect(a).toBe(b);
    // ordering keyed off seq (deterministic), not array order
    expect(a!.indexOf('first')).toBeLessThan(a!.indexOf('second'));
  });

  it('falls back to raw principal_id when the directory has no name', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    const state = emptyState({ tasks: [makeTask({ id: 't_1', title: 'x', status: 'open', owner: 'p_unknown' })] });
    const text = await renderBlock(manifest, BOARD_BLOCK, state);
    expect(text).toContain('负责人: p_unknown');
  });

  it('shows closed/cancelled columns only when config.show_columns opts in', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    const state = emptyState({
      config: { list_limit: 50, show_columns: ['done', 'closed', 'cancelled'] },
      tasks: [
        makeTask({ id: 't_1', title: 'shipped', status: 'closed' }),
        makeTask({ id: 't_2', title: 'dropped', status: 'cancelled' }),
      ],
    });
    const text = await renderBlock(manifest, BOARD_BLOCK, state);
    expect(text).toContain('已关闭');
    expect(text).toContain('已取消');
  });
});

/** Deterministic task helper for byte-identical tests (fixed seq, not the global counter). */
function makeTaskFixed(id: string, title: string, status: Task['status'], s: number): Task {
  return { id, title, status, creator: 'p_c', owner: 'p_x', ts: s, seq: s };
}

// ============================================================================
// mine view
// ============================================================================

describe('task_proxy:mine builder', () => {
  it('renders only the agent-owned active tasks (owner === self)', async () => {
    const client = new FakeTaskClient('p_me');
    const manifest = new TaskProxyApp({ client }).manifest();
    const state = emptyState({
      tasks: [
        makeTask({ id: 't_1', title: 'mine open', status: 'open', owner: 'p_me' }),
        makeTask({ id: 't_2', title: 'mine done', status: 'done', owner: 'p_me' }),
        makeTask({ id: 't_3', title: 'theirs', status: 'open', owner: 'p_other' }),
      ],
    });
    const text = await renderBlock(manifest, MINE_BLOCK, state);
    expect(text).toContain('mine open');
    expect(text).not.toContain('mine done'); // done is not active
    expect(text).not.toContain('theirs');
  });

  it('returns null when the agent owns no active task', async () => {
    const client = new FakeTaskClient('p_me');
    const manifest = new TaskProxyApp({ client }).manifest();
    const state = emptyState({ tasks: [makeTask({ id: 't_1', title: 'theirs', status: 'open', owner: 'p_other' })] });
    expect(await renderBlock(manifest, MINE_BLOCK, state)).toBeNull();
  });
});

// ============================================================================
// command forwarding
// ============================================================================

describe('command forwarding', () => {
  let client: FakeTaskClient;
  let manifest: AppManifest;

  beforeEach(() => {
    client = new FakeTaskClient('p_self');
    manifest = new TaskProxyApp({ client }).manifest();
  });

  it('add → client.create + upsert', async () => {
    const ctx = makeCtx(emptyState());
    const res = await getCommand(manifest, 'add').invoke({ title: 'new task', estimate: 8 }, ctx, makeInvoker());
    expect(res.ok).toBe(true);
    expect(client.calls.find((c) => c.op === 'create')).toBeTruthy();
    expect(ctx.state.tasks).toHaveLength(1);
    expect(ctx.state.tasks[0]!.title).toBe('new task');
  });

  it('split → create with parent', async () => {
    const ctx = makeCtx(emptyState());
    const res = await getCommand(manifest, 'split').invoke({ parent: 't_99', title: 'sub' }, ctx, makeInvoker());
    expect(res.ok).toBe(true);
    const call = client.calls.find((c) => c.op === 'create')!;
    expect((call.args as TaskCreateRequest).parent).toBe('t_99');
    expect(ctx.state.tasks[0]!.parent).toBe('t_99');
  });

  it('claim → assign to client.self (not agent content)', async () => {
    client.tasks.set('t_1', makeTask({ id: 't_1', title: 'x', status: 'open' }));
    const ctx = makeCtx(emptyState());
    const res = await getCommand(manifest, 'claim').invoke({ id: 't_1' }, ctx, makeInvoker());
    expect(res.ok).toBe(true);
    const call = client.calls.find((c) => c.op === 'assign')!;
    expect((call.args as { assignee: string }).assignee).toBe('p_self');
    expect(ctx.state.tasks[0]!.owner).toBe('p_self');
  });

  it('assign → assign to a named principal', async () => {
    client.tasks.set('t_1', makeTask({ id: 't_1', title: 'x', status: 'open' }));
    const ctx = makeCtx(emptyState());
    await getCommand(manifest, 'assign').invoke({ id: 't_1', assignee: 'p_zr' }, ctx, makeInvoker());
    expect((client.calls.find((c) => c.op === 'assign')!.args as { assignee: string }).assignee).toBe('p_zr');
    expect(ctx.state.tasks[0]!.owner).toBe('p_zr');
  });

  it('start → open becomes in_progress', async () => {
    client.tasks.set('t_1', makeTask({ id: 't_1', title: 'x', status: 'open' }));
    const ctx = makeCtx(emptyState());
    const res = await getCommand(manifest, 'start').invoke({ id: 't_1' }, ctx, makeInvoker());
    expect(res.ok).toBe(true);
    expect(ctx.state.tasks[0]!.status).toBe('in_progress');
  });

  it('update → forwards 工时 patch', async () => {
    client.tasks.set('t_1', makeTask({ id: 't_1', title: 'x', status: 'in_progress' }));
    const ctx = makeCtx(emptyState());
    await getCommand(manifest, 'update').invoke({ id: 't_1', patch: { spent: 5, left: 3 } }, ctx, makeInvoker());
    const call = client.calls.find((c) => c.op === 'update')!;
    expect(call.args as TaskUpdateRequest).toMatchObject({ id: 't_1', spent: 5, left: 3 });
    expect(ctx.state.tasks[0]!.spent).toBe(5);
  });

  it('complete → done; complete{cancelled} → cancelled (5-state)', async () => {
    client.tasks.set('t_1', makeTask({ id: 't_1', title: 'a', status: 'in_progress' }));
    client.tasks.set('t_2', makeTask({ id: 't_2', title: 'b', status: 'open' }));
    const ctx = makeCtx(emptyState());
    await getCommand(manifest, 'complete').invoke({ id: 't_1' }, ctx, makeInvoker());
    await getCommand(manifest, 'complete').invoke({ id: 't_2', cancelled: true }, ctx, makeInvoker());
    expect(ctx.state.tasks.find((t) => t.id === 't_1')!.status).toBe('done');
    expect(ctx.state.tasks.find((t) => t.id === 't_2')!.status).toBe('cancelled');
  });

  it('forwards a clear error when the service throws (degrades, no crash)', async () => {
    const ctx = makeCtx(emptyState());
    // t_missing not in the fake → require() throws
    const res = await getCommand(manifest, 'start').invoke({ id: 't_missing' }, ctx, makeInvoker());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Task service unavailable');
  });
});

// ============================================================================
// ingest → wake + agent barred
// ============================================================================

describe('task_proxy.ingest', () => {
  it('upserts the full task and raises a base-ified app_event wake', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    const ctx = makeCtx(emptyState());
    const task = makeTask({ id: 't_42', title: 'assigned to me', status: 'open', owner: 'p_self' });
    const res = await getCommand(manifest, 'ingest').invoke({ task }, ctx, makeInvoker('app'));
    expect(res.ok).toBe(true);
    expect(ctx.state.tasks.find((t) => t.id === 't_42')).toBeTruthy();
    expect(ctx.wakes).toHaveLength(1);
    expect(ctx.wakes[0]).toMatchObject({ kind: 'app_event', source: 'task_proxy', reason: 'task_updated', ref: 't_42' });
  });

  it('upserts (does not duplicate) on a repeat frame for the same id', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    const ctx = makeCtx(emptyState());
    const cmd = getCommand(manifest, 'ingest');
    await cmd.invoke({ task: makeTask({ id: 't_1', title: 'v1', status: 'open' }) }, ctx, makeInvoker('app'));
    await cmd.invoke({ task: makeTask({ id: 't_1', title: 'v2', status: 'in_progress' }) }, ctx, makeInvoker('app'));
    expect(ctx.state.tasks).toHaveLength(1);
    expect(ctx.state.tasks[0]!.status).toBe('in_progress');
  });

  it('declares allowed_invokers ["app","user"] (the agent is barred by PolicyEngine)', () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    expect(getCommand(manifest, 'ingest').allowed_invokers).toEqual(['app', 'user']);
  });

  it('rejects a malformed task', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    const ctx = makeCtx(emptyState());
    const res = await getCommand(manifest, 'ingest').invoke({ task: { id: 't_1' } }, ctx, makeInvoker('app'));
    expect(res.ok).toBe(false);
  });
});

// ============================================================================
// contracts + gates
// ============================================================================

describe('task_count contract via', () => {
  it('counts active (open + in_progress) tasks as a scalar', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    const state = emptyState({
      tasks: [
        makeTask({ id: 't_1', title: 'a', status: 'open' }),
        makeTask({ id: 't_2', title: 'b', status: 'in_progress' }),
        makeTask({ id: 't_3', title: 'c', status: 'done' }),
        makeTask({ id: 't_4', title: 'd', status: 'cancelled' }),
      ],
    });
    const res = await getCommand(manifest, 'count').invoke({}, makeCtx(state), makeInvoker('app'));
    expect(res).toEqual({ ok: true, data: 2 });
  });

  it('manifest provides task_count via count, consumes org_directory as directory', () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    expect(manifest.provides).toEqual([{ contract: 'task_count', via: 'count' }]);
    expect(manifest.consumes).toEqual([{ contract: 'org_directory', as: 'directory' }]);
  });
});

describe('gates', () => {
  it('remove_physical is block:delete_physical + [user,app] (agent denied), local-only', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    const cmd = getCommand(manifest, 'remove_physical');
    expect(cmd.capabilities).toEqual([{ name: 'block:delete_physical' }]);
    expect(cmd.allowed_invokers).toEqual(['user', 'app']);
    // it only drops the LOCAL projection, never a server task
    const state = emptyState({ tasks: [makeTask({ id: 't_1', title: 'x', status: 'open' })] });
    const ctx = makeCtx(state);
    const res = await cmd.invoke({ id: 't_1' }, ctx, makeInvoker('user'));
    expect(res).toMatchObject({ ok: true, data: { id: 't_1', local_only: true } });
    expect(ctx.state.tasks).toHaveLength(0);
  });

  it('set_config is user-only and retunes list_limit / show_columns', async () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    const cmd = getCommand(manifest, 'set_config');
    expect(cmd.allowed_invokers).toEqual(['user']);
    const ctx = makeCtx(emptyState());
    const res = await cmd.invoke({ list_limit: 10, show_columns: ['open'] }, ctx, makeInvoker('user'));
    expect(res.ok).toBe(true);
    expect(ctx.state.config.list_limit).toBe(10);
    expect(ctx.state.config.show_columns).toEqual(['open']);
  });

  it('net commands declare net:http', () => {
    const manifest = new TaskProxyApp({ client: new FakeTaskClient() }).manifest();
    for (const name of ['add', 'split', 'claim', 'assign', 'start', 'update', 'complete']) {
      const caps = getCommand(manifest, name).capabilities ?? [];
      expect(caps).toContainEqual({ name: 'net:http' });
    }
  });
});

// ============================================================================
// on_install: first-screen pull + WS push→wake; on_uninstall teardown
// ============================================================================

describe('on_install / on_uninstall', () => {
  it('pulls the no-param list (= owner ∪ creator) on install; excludes unrelated (task.md §4.6)', async () => {
    // Architect ruling (after team-lead froze Phase B commit 3a4297b): no-param GET /task/list
    // = owner ∪ creator, computed SERVER-side. The proxy makes a SINGLE no-arg call (no local
    // set arithmetic) — the boot set then matches §5 WS push relevance (board ⊇ WS set, no
    // backfill gap). So a task the agent created-but-assigned-out (t_2, creator=self) IS folded,
    // and an unrelated task (t_3) is not.
    const client = new FakeTaskClient('p_self', [
      makeTask({ id: 't_1', title: 'assigned to me', status: 'open', owner: 'p_self', creator: 'p_boss' }),
      makeTask({ id: 't_2', title: 'I created, assigned out', status: 'open', owner: 'p_other', creator: 'p_self' }),
      makeTask({ id: 't_3', title: 'unrelated', status: 'open', owner: 'p_other', creator: 'p_boss' }),
    ]);
    const manifest = new TaskProxyApp({ client }).manifest();
    const ctx = makeCtx(emptyState());
    await manifest.on_install!(ctx);
    const listCalls = client.calls.filter((c) => c.op === 'list');
    expect(listCalls).toHaveLength(1); // single no-arg call, union is server-side
    expect((listCalls[0]!.args as { owner?: string }).owner).toBeUndefined(); // no-param
    expect(ctx.state.tasks.map((t) => t.id).sort()).toEqual(['t_1', 't_2']); // owner∪creator, not t_3
  });

  it('a WS push upserts + wakes', async () => {
    const client = new FakeTaskClient('p_self');
    const manifest = new TaskProxyApp({ client }).manifest();
    const ctx = makeCtx(emptyState());
    await manifest.on_install!(ctx);
    client.push(makeTask({ id: 't_9', title: 'pushed', status: 'open', owner: 'p_self' }));
    expect(ctx.state.tasks.find((t) => t.id === 't_9')).toBeTruthy();
    expect(ctx.wakes.some((w) => w.kind === 'app_event' && w.ref === 't_9')).toBe(true);
  });

  it('on_uninstall closes the connection (never deletes server tasks)', async () => {
    const client = new FakeTaskClient('p_self');
    const manifest = new TaskProxyApp({ client }).manifest();
    await manifest.on_uninstall!(makeCtx(emptyState()));
    expect(client.closed).toBe(true);
  });
});

// ============================================================================
// degraded (no client) shell
// ============================================================================

describe('degraded shell (no client configured)', () => {
  it('installs render + read-only commands, omits net commands', () => {
    const manifest = new TaskProxyApp({}).manifest(); // no client, env unset in test
    // builders still present
    expect(manifest.builders).toHaveLength(2);
    // read-only / app commands present
    for (const name of ['ingest', 'list', 'count', 'remove_physical', 'set_config']) {
      expect(hasCommand(manifest, name)).toBe(true);
    }
    // net commands absent
    for (const name of ['add', 'claim', 'assign', 'start', 'update', 'complete', 'split']) {
      expect(hasCommand(manifest, name)).toBe(false);
    }
  });

  it('on_install does not throw without a client', async () => {
    const manifest = new TaskProxyApp({}).manifest();
    await expect(manifest.on_install!(makeCtx(emptyState()))).resolves.toBeUndefined();
  });
});
