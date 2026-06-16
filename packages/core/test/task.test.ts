/**
 * test/task.test.ts — the task BlockApp (impl-apps owned). Covers §4.2 + §3.6 + AI-3=B:
 *
 *   - the full CRUD command surface (add/update/complete/reopen/remove) over jsonl + state;
 *   - the §3.6 three-audience invoker gates: write commands all-invoker, query commands
 *     (`list`/`get`/`count`) `['user','app']`, `set_config` user-only, `ingest`
 *     `['app','user']`, and `remove_physical` `['user','app']` + `block:delete_physical`
 *     so the AGENT is flatly denied (AI-3=B — its free delete is the soft `remove`);
 *   - the `task:list` builder: slow_changing, owner=system, pure, and SHRINKS to null
 *     when no task is open (tier-driven block disappearance);
 *   - `task.count` returns a SCALAR number (the `task_count` contract via, R-1) and the
 *     manifest's `provides` shape;
 *   - `ingest` durably appends, projects, and wakes the runtime with a base-ified
 *     WakeEvent (source='task', reason='task_arrived', ref=id, §3.7);
 *   - jsonl uses a temp dir so the repo's real `.block-agent` is never touched.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppRegistry } from '../src/app/registry.js';
import { BlockTree } from '../src/core/block.js';
import { Operations } from '../src/core/operations.js';
import {
  TASK_LIST_BLOCK,
  TaskApp,
  type Task,
  type TaskAppOptions,
  type TaskState,
} from '@block-agent/app-task/manifest.js';
import type { Block, BlockName, InvokerContext, WakeEvent } from '../src/core/types.js';
import type { AppContext, BuildContext, BuilderManifest } from '../src/app/types.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'task-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const AGENT: InvokerContext = { invoker: 'agent', identity: 'main' };
const USER: InvokerContext = { invoker: 'user', identity: 'human' };
const APP: InvokerContext = { invoker: 'app', identity: 'ext:jira' };

/** A throwaway BuildContext; the task builder ignores it (state-only build). */
function fakeBuildContext(): BuildContext {
  return {
    snapshot: {
      root: { id: 'r', name: 'root:root', children: [], content_text: null, content_blob: null },
      hash: 'h',
      get: () => null,
    },
    read: () => null,
    deterministic_clock: () => 0,
    deterministic_random: () => 0,
    content_addressed_id: (s) => s,
    config: {},
  };
}

/** A minimal AppContext carrying a fixed state — all the builder reads (INV #16). */
function stateCtx(state: TaskState): AppContext<TaskState> {
  return {
    app_id: 'task',
    state,
    set_state: () => undefined,
    list_commands: () => [],
    list_builders: () => [],
    list_blocks: () => [],
    invoke_command: async () => ({ ok: true }),
    read: async () => [],
    on: () => undefined,
    emit: () => undefined,
    spawn_system_agent: () => ({ id: 'x', stop: () => undefined }),
  };
}

/** Install a TaskApp into a registry, capturing every WakeEvent. */
function installApp(opts: Omit<TaskAppOptions, 'dir' | 'configBase'> = {}): {
  app: TaskApp;
  registry: AppRegistry;
  wakes: WakeEvent[];
} {
  const app = new TaskApp({ ...opts, dir: join(dir, 'store'), configBase: dir });
  const registry = new AppRegistry();
  const wakes: WakeEvent[] = [];
  registry.wakeHook = (e) => wakes.push(e);
  registry.install(app.manifest());
  return { app, registry, wakes };
}

/** Wire the App through the REAL Operations + default PolicyEngine (the gate). */
function wire(opts: Omit<TaskAppOptions, 'dir' | 'configBase'> = {}) {
  const app = new TaskApp({ ...opts, dir: join(dir, 'store'), configBase: dir });
  const reg = new AppRegistry();
  reg.install(app.manifest());
  const root: Block = {
    id: 'root', name: 'root:root', children: [], content_text: null, content_blob: null,
  };
  const tree = new BlockTree(root);
  const ops = Operations.with_default_policy({ tree, registry: reg });
  return { app, reg, ops };
}

/** Resolve the task:list builder. */
function listBuilder(registry: AppRegistry): BuilderManifest {
  const b = registry.resolve_builder(TASK_LIST_BLOCK);
  if (b === null) throw new Error('no builder for task:list');
  return b;
}

/** The App's live tasks (read through its live AppContext). */
function liveTasks(reg: AppRegistry): Task[] {
  return (reg.get_app_context('task')?.state as TaskState).tasks;
}

/** The App's first live task (tests that just created one). Asserts it exists. */
function firstTask(reg: AppRegistry): Task {
  const t = liveTasks(reg)[0];
  if (t === undefined) throw new Error('expected at least one live task');
  return t;
}

/** Build a TaskState the builder can render from a plain list of tasks. */
function makeState(tasks: Task[]): TaskState {
  return { tasks, config: { list_limit: 50 } };
}

// ---------------------------------------------------------------------------
// CRUD over jsonl + state
// ---------------------------------------------------------------------------

describe('task CRUD', () => {
  it('add creates an open task and persists to jsonl + state', async () => {
    const { app, registry } = installApp();
    const res = await registry.route('task.add', { title: 'buy milk' }, AGENT);
    expect(res.ok).toBe(true);
    const id = (res.data as { id: string }).id;

    const live = liveTasks(registry);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id, title: 'buy milk', status: 'open', source: 'agent' });
    // durable
    expect(app.store.readAll().map((t) => t.id)).toEqual([id]);
  });

  it('add tags the source from the invoker (user vs agent)', async () => {
    const { registry } = installApp();
    await registry.route('task.add', { title: 'a' }, USER);
    expect(firstTask(registry).source).toBe('user');
  });

  it('complete / reopen flip status; the durable log folds to the latest', async () => {
    const { app, registry } = installApp();
    const id = (await registry.route('task.add', { title: 't' }, AGENT)).data as { id: string };
    await registry.route('task.complete', { id: id.id }, AGENT);
    expect(firstTask(registry).status).toBe('done');
    await registry.route('task.reopen', { id: id.id }, AGENT);
    expect(firstTask(registry).status).toBe('open');
    // jsonl folds to a single live task at its latest status.
    expect(app.store.readAll()).toHaveLength(1);
    expect(app.store.readAll()[0]!.status).toBe('open');
  });

  it('update applies a partial patch (incl. status)', async () => {
    const { registry } = installApp();
    const id = ((await registry.route('task.add', { title: 't' }, AGENT)).data as { id: string }).id;
    const res = await registry.route(
      'task.update',
      { id, patch: { title: 'renamed', priority: 3, status: 'done' } },
      AGENT,
    );
    expect(res.ok).toBe(true);
    expect(firstTask(registry)).toMatchObject({ title: 'renamed', priority: 3, status: 'done' });
  });

  it('remove is a SOFT delete = archive (record survives, INV #5)', async () => {
    const { app, registry } = installApp();
    const id = ((await registry.route('task.add', { title: 't' }, AGENT)).data as { id: string }).id;
    const res = await registry.route('task.remove', { id }, AGENT);
    expect(res.ok).toBe(true);
    // still present, just archived (not gone).
    expect(firstTask(registry).status).toBe('archived');
    expect(app.store.readAll()).toHaveLength(1);
  });

  it('update / complete reject an unknown id', async () => {
    const { registry } = installApp();
    expect((await registry.route('task.complete', { id: 'nope' }, AGENT)).ok).toBe(false);
    expect((await registry.route('task.update', { id: 'nope', patch: {} }, AGENT)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// remove_physical — AI-3=B: agent flatly DENIED at the policy gate
// ---------------------------------------------------------------------------

describe('task.remove_physical (AI-3=B)', () => {
  it('DENIES the agent (block:delete_physical + invoker gate) — its free delete is soft remove', async () => {
    const { app, reg, ops } = wire();
    const id = ((await ops.invoke_command('task.add', { title: 't' }, AGENT)).data as { id: string }).id;

    const res = await ops.invoke_command('task.remove_physical', { id }, AGENT);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    // The record is untouched (the handler never ran).
    expect(app.store.readAll()).toHaveLength(1);
  });

  it('ALLOWS user/app and physically purges the store record', async () => {
    const { app, ops } = wire();
    const id = ((await ops.invoke_command('task.add', { title: 't' }, AGENT)).data as { id: string }).id;

    const res = await ops.invoke_command('task.remove_physical', { id }, USER);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ physical: true });
    // physically gone from the durable log.
    expect(app.store.readAll()).toHaveLength(0);
  });

  it('declares block:delete_physical + allowed_invokers on the manifest', () => {
    const { registry: reg } = installApp();
    const cmd = reg.resolve_command('task.remove_physical');
    expect(cmd?.capabilities?.map((c) => c.name)).toContain('block:delete_physical');
    expect(cmd?.allowed_invokers).toEqual(['user', 'app']);
  });
});

// ---------------------------------------------------------------------------
// ingest — external front door: persist + wake (§3.7)
// ---------------------------------------------------------------------------

describe('task.ingest (§3.7 external front door + wake)', () => {
  it('persists, projects, and wakes with a base-ified app_event (source=task, reason=task_arrived)', async () => {
    const { app, registry, wakes } = installApp();
    const event = app.ingest({ title: 'externally assigned' });

    expect(event).toMatchObject({ kind: 'app_event', source: 'task', reason: 'task_arrived' });
    expect(wakes).toEqual([event]);
    // durable + state
    expect(app.store.readAll().map((t) => t.title)).toEqual(['externally assigned']);
    expect(firstTask(registry).source).toBe('external');
  });

  it('stores ext_id as a SEPARATE foreign-ref field; the primary id stays internal', () => {
    const { app, registry } = installApp();
    app.ingest({ title: 'jira-123', ext_id: 'JIRA-123' });
    const t = firstTask(registry);
    expect(t.id).toMatch(/^task_/); // internal deterministic id, NOT the ext key
    expect(t.ext_id).toBe('JIRA-123');
  });

  it('ingest command reports the wake reason + id', async () => {
    const { registry } = installApp();
    const res = await registry.route('task.ingest', { title: 'x' }, APP);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ woke: 'task_arrived' });
    expect((res.data as { id: string }).id).toBeTruthy();
  });

  it('throws if ingest is called before install', () => {
    const app = new TaskApp({ dir: join(dir, 'store'), configBase: dir });
    expect(() => app.ingest({ title: 'nope' })).toThrow(/before install/);
  });

  it('DENIES the agent on ingest (cannot forge an external assignment, §4.2)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('task.ingest', { title: 'forged' }, AGENT);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
  });
});

// ---------------------------------------------------------------------------
// builder: task:list — slow_changing, owner=system, pure, shrink to null
// ---------------------------------------------------------------------------

describe('task:list builder', () => {
  it('is slow_changing and owner=system (INV #4)', () => {
    const { registry } = installApp();
    const b = listBuilder(registry);
    expect(b.cache_tier).toBe('slow_changing');
    expect(b.owner).toBe('system');
    expect(registry.tier_of(TASK_LIST_BLOCK)).toBe('slow_changing');
  });

  it('renders OPEN tasks and is byte-identical for the same state (INV #1/#16)', async () => {
    const b = listBuilder(installApp().registry);
    const state = makeState([
      { id: 't1', title: 'alpha', status: 'open', source: 'user', ts: 1 },
      { id: 't2', title: 'beta', status: 'done', source: 'user', ts: 2 },
    ]);
    const b1 = await b.build(fakeBuildContext(), stateCtx(state));
    const b2 = await b.build(fakeBuildContext(), stateCtx(state));
    expect(b1!.name).toBe(TASK_LIST_BLOCK);
    expect(b1!.content_text).toContain('alpha'); // open shown
    expect(b1!.content_text).not.toContain('beta'); // done hidden
    expect(b2!.content_text).toBe(b1!.content_text);
  });

  it('SHRINKS to null when no task is open (the block disappears)', async () => {
    const b = listBuilder(installApp().registry);
    // no tasks
    expect(await b.build(fakeBuildContext(), stateCtx(makeState([])))).toBeNull();
    // only a done task → still null
    const done = makeState([{ id: 't', title: 'x', status: 'done', source: 'user', ts: 1 }]);
    expect(await b.build(fakeBuildContext(), stateCtx(done))).toBeNull();
  });

  it('the block round-trips through complete (shrinks once the last open task is done)', async () => {
    const { registry } = installApp();
    const id = ((await registry.route('task.add', { title: 'only' }, AGENT)).data as { id: string }).id;
    const b = listBuilder(registry);
    let block = await b.build(fakeBuildContext(), stateCtx(makeState(liveTasks(registry))));
    expect(block).not.toBeNull();
    await registry.route('task.complete', { id }, AGENT);
    block = await b.build(fakeBuildContext(), stateCtx(makeState(liveTasks(registry))));
    expect(block).toBeNull(); // tier-driven shrink
  });
});

// ---------------------------------------------------------------------------
// query commands: list / get / count — invoker gate + count scalar + provides
// ---------------------------------------------------------------------------

describe('task query commands (§3.6 + contract via)', () => {
  it('count returns a SCALAR number (open tasks) and is readonly', async () => {
    const { registry } = installApp();
    await registry.route('task.add', { title: 'a' }, AGENT);
    await registry.route('task.add', { title: 'b' }, AGENT);
    const res = await registry.route('task.count', {}, APP);
    expect(res.ok).toBe(true);
    expect(res.data).toBe(2); // a bare number, not { count: 2 }
    const cmd = registry.resolve_command('task.count');
    expect(cmd?.readonly).toBe(true);
    expect(cmd?.result_schema).toEqual({ type: 'number' });
  });

  it('count excludes done/archived tasks', async () => {
    const { registry } = installApp();
    const id = ((await registry.route('task.add', { title: 'a' }, AGENT)).data as { id: string }).id;
    await registry.route('task.add', { title: 'b' }, AGENT);
    await registry.route('task.complete', { id }, AGENT);
    expect((await registry.route('task.count', {}, APP)).data).toBe(1);
  });

  it('list / get return data; list defaults to open', async () => {
    const { registry } = installApp();
    await registry.route('task.add', { title: 'a' }, USER);
    const list = await registry.route('task.list', {}, USER);
    expect((list.data as { tasks: Task[] }).tasks).toHaveLength(1);
    const id = (list.data as { tasks: Task[] }).tasks[0]!.id;
    const get = await registry.route('task.get', { id }, USER);
    expect((get.data as { task: Task }).task.id).toBe(id);
  });

  it('query commands are app/user-only (excluded from the agent tool catalog, DR-F)', () => {
    const { registry } = installApp();
    expect(registry.resolve_command('task.list')?.allowed_invokers).toEqual(['user', 'app']);
    expect(registry.resolve_command('task.get')?.allowed_invokers).toEqual(['user', 'app']);
    expect(registry.resolve_command('task.count')?.allowed_invokers).toEqual(['app', 'user']);
  });

  it('DENIES the agent on count/list at the policy gate', async () => {
    const { ops } = wire();
    expect((await ops.invoke_command('task.count', {}, AGENT)).ok).toBe(false);
    expect((await ops.invoke_command('task.list', {}, AGENT)).ok).toBe(false);
  });

  it('provides the task_count contract via the bare `count` command', () => {
    const { registry } = installApp();
    const m = registry.get('task')!;
    expect(m.provides).toEqual([{ contract: 'task_count', via: 'count' }]);
  });
});

// ---------------------------------------------------------------------------
// config: file seed + user-only set_config (agent DENIED)
// ---------------------------------------------------------------------------

describe('task config (file seed + user-only set_config)', () => {
  it('seeds list_limit from config.json over the compiled default', () => {
    writeConfig(dir, { list_limit: 7 });
    const { reg } = wire();
    expect((reg.get('task')!.initial_state as TaskState).config.list_limit).toBe(7);
  });

  it('DENIES the agent (anti self-modification)', async () => {
    const { ops, reg } = wire();
    const res = await ops.invoke_command('task.set_config', { list_limit: 1 }, AGENT);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect((reg.get('task')!.initial_state as TaskState).config.list_limit).toBe(50);
  });

  it('ALLOWS the user and clamps', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('task.set_config', { list_limit: 99999 }, USER);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ updated: ['list_limit'] });
  });

  it('declares set_config as user-only on the manifest', () => {
    const { registry: reg } = installApp();
    expect(reg.resolve_command('task.set_config')?.allowed_invokers).toEqual(['user']);
  });
});

// ---------------------------------------------------------------------------
// jsonl discipline — temp dir, never the repo's real .block-agent
// ---------------------------------------------------------------------------

describe('task jsonl store', () => {
  it('folds the log to latest-per-id and survives a reload from the same dir', async () => {
    const storeDir = join(dir, 'store');
    const { app, registry } = installApp();
    const id = ((await registry.route('task.add', { title: 'x' }, AGENT)).data as { id: string }).id;
    await registry.route('task.update', { id, patch: { title: 'y' } }, AGENT);
    expect(app.store.readAll()).toHaveLength(1);
    expect(app.store.readAll()[0]!.title).toBe('y');

    // A fresh App on the SAME dir reads the folded live task.
    const reloaded = new TaskApp({ dir: storeDir, configBase: dir });
    expect(reloaded.store.readAll().map((t) => t.title)).toEqual(['y']);
  });
});

// ---------------------------------------------------------------------------
// restart restore (D1 §5.2): a fresh App on the same dir re-hydrates initial_state
// ---------------------------------------------------------------------------

describe('task restart restore (D1 §5.2)', () => {
  it('re-hydrates the bounded task list into initial_state from the durable log', async () => {
    const storeDir = join(dir, 'store');
    const { app, registry } = installApp();
    const a = ((await registry.route('task.add', { title: 'alpha' }, AGENT)).data as { id: string }).id;
    await registry.route('task.add', { title: 'beta' }, USER);
    await registry.route('task.complete', { id: a }, AGENT); // alpha → done (still live)

    // A fresh App on the SAME dir boots with the projection restored (NOT empty), and the
    // folded live status survives (alpha done, beta open).
    const reloaded = new TaskApp({ dir: storeDir, configBase: dir });
    const restored = (reloaded.manifest().initial_state as TaskState).tasks;
    expect(restored.map((t) => t.title)).toEqual(['alpha', 'beta']);
    expect(restored.find((t) => t.title === 'alpha')!.status).toBe('done');
    expect(restored.find((t) => t.title === 'beta')!.status).toBe('open');
    // The durable jsonl is intact regardless (the source of the restore).
    expect(app.store.readAll()).toHaveLength(2);
  });

  it('advances the id counter past the restored ids so a new task never collides', async () => {
    const storeDir = join(dir, 'store');
    const { registry } = installApp();
    await registry.route('task.add', { title: 'one' }, AGENT); // task_1
    await registry.route('task.add', { title: 'two' }, AGENT); // task_2

    const reloaded = new TaskApp({ dir: storeDir, configBase: dir });
    const reg2 = new AppRegistry();
    reg2.install(reloaded.manifest());
    const res = await reg2.route('task.add', { title: 'three' }, AGENT);
    // Next id is task_3, not a re-used task_1 — and it does not clobber a restored task.
    expect((res.data as { id: string }).id).toBe('task_3');
    expect((reg2.get_app_context('task')?.state as TaskState).tasks.map((t) => t.id)).toEqual([
      'task_1',
      'task_2',
      'task_3',
    ]);
  });

  it('boots bounded: an over-limit durable log keeps the most-recent list_limit tasks', async () => {
    const storeDir = join(dir, 'store');
    writeConfig(dir, { list_limit: 3 });
    const { registry } = installApp();
    for (let i = 1; i <= 6; i += 1) await registry.route('task.add', { title: `t${i}` }, AGENT);

    const reloaded = new TaskApp({ dir: storeDir, configBase: dir });
    const restored = (reloaded.manifest().initial_state as TaskState).tasks;
    // Bounded to list_limit, keeping the most-recent by monotonic ts (t4..t6).
    expect(restored.map((t) => t.title)).toEqual(['t4', 't5', 't6']);
  });

  it('a missing durable log boots an empty list (zero regression)', () => {
    const fresh = new TaskApp({ dir: join(dir, 'never-written'), configBase: dir });
    expect((fresh.manifest().initial_state as TaskState).tasks).toEqual([]);
  });

  it('a crash-torn durable log degrades gracefully (drops the torn tail, never throws)', () => {
    const storeDir = join(dir, 'store');
    mkdirSync(storeDir, { recursive: true });
    // Two clean records + a torn trailing line (no newline) — the store's startup
    // tail-truncate drops the torn line, restore reads the two clean tasks, never throws.
    writeFileSync(
      join(storeDir, 'tasks.jsonl'),
      '{"op":"upsert","id":"task_1","title":"kept","status":"open","source":"agent","ts":1}\n' +
        '{"op":"upsert","id":"task_2","title":"also","status":"open","source":"agent","ts":2}\n' +
        '{"op":"upsert","id":"task_3","title":"torn',
    );
    let app: TaskApp | undefined;
    expect(() => {
      app = new TaskApp({ dir: storeDir, configBase: dir });
    }).not.toThrow();
    const restored = (app!.manifest().initial_state as TaskState).tasks;
    expect(restored.map((t) => t.title)).toEqual(['kept', 'also']);
  });
});

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Write a task config.json under the configBase the tests pass in. */
function writeConfig(base: string, cfg: Record<string, number>): void {
  const appDir = join(base, 'task');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'config.json'), JSON.stringify(cfg));
}
