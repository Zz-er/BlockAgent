/**
 * test/multi_app_e2e.test.ts — P4 multi-app end-to-end acceptance (architect-owned).
 *
 * THE TOTAL ACCEPTANCE GATE: this is the one test that proves App↔App communication
 * really runs through the WHOLE stack — a real AppRegistry + real Operations
 * (PolicyEngine inside) + real Renderer (live-AppContext seam) + real AgentRuntime +
 * the real task / messages / stats Apps + the built-in count contracts. Every seam the
 * earlier unit tests stub (consumeRefresh, providers_of, invoke_query, get_app_context)
 * is wired here exactly as the boot wires it, so this exercises the path the CLI ships —
 * the "green but the real loop is broken" class the projection_e2e + consume_refresh
 * files already guard, extended to the full contract round-trip.
 *
 * It walks the §5 trace (blockapp-multi-app-architecture.md §5):
 *   step 2  external `task.ingest` (invoker=app, identity=ext:*) lands a task + wakes the
 *           runtime; the turn runs consume-refresh BEFORE the snapshot;
 *   step 3  Turn 1 — `task.count` → 1 fans into stats.state.task_count=1; the rendered
 *           `stats:summary` block carries that 1 ("1 待办"); `task:list` shows the task;
 *   step 4  the agent (scripted MockProvider) replies: `task.complete` + `messages.chat`;
 *   step 5  Turn 2 — `task.count` → 0 (completed), `messages.count` → 1; `task:list`
 *           build returns null (the block disappears — context auto-shrinks), and
 *           `stats:summary` refreshes to task_count=0 / msg_count=1.
 *
 * P4 CORE GATE (F5 / resolutions.md): assert the STATS contract round-trip + the TIER
 * SHRINK (task:list null collapse). The commands-only rejection (§5 step 4 plain-text
 * branch) is NOT re-asserted here — that is P2/B1's acceptance; re-checking it would pull
 * P4 back onto a P2 dependency (F5). We DO drive a real agent turn (task.complete +
 * messages.chat) because that turn is what makes task_count go 1→0 and msg_count 0→1 —
 * i.e. it is load-bearing for the round-trip, not a commands-only re-test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlockTree } from '../src/core/block.js';
import { Operations } from '../src/core/operations.js';
import { Renderer } from '../src/core/renderer.js';
import { AppRegistry } from '../src/app/registry.js';
import { AgentRuntime } from '../src/runtime/agent_runtime.js';
import { MockProvider } from '../src/provider/mock.js';
import { MESSAGE_COUNT, TASK_COUNT } from '../src/app/contracts.js';
import { MessagesApp } from '../src/apps/messages.js';
import { TaskApp } from '../src/apps/task.js';
import { makeStatsApp } from '../src/apps/stats.js';
import type { MockTurn } from '../src/provider/mock.js';
import type { InvokerContext } from '../src/core/types.js';

// External task assignment is invoker=app, identity-tagged at the entry membrane
// (the ExternalTaskAdapter self-auths exactly this way, cli_channel.ts:37 precedent).
const EXT: InvokerContext = { invoker: 'app', identity: 'ext:jira' };

// The empty-tree root `new BlockTree()` builds (core/block.ts) — the same value launch.ts
// passes as ROOT_NAME. The runtime is given this as root_name so seedProjectionBlocks
// attaches under the real root (CM-4).
const ROOT_NAME = 'core:root' as const;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blockagent-multiapp-e2e-'));
});
afterEach(() => {
  // jsonl stores live under the temp dir → never pollute the repo's .block-agent.
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Boot — wire the real graph EXACTLY like launch.ts (R-6 order), with stats enabled.
// ============================================================================

interface Boot {
  reg: AppRegistry;
  ops: Operations;
  renderer: Renderer;
  runtime: AgentRuntime;
  task: TaskApp;
  messages: MessagesApp;
  tree: BlockTree;
}

/**
 * boot — the canonical R-6 wiring: registry → registerContract(MESSAGE_COUNT/TASK_COUNT)
 * → install task+messages+stats → Operations (PolicyEngine inside) → commandRouter →
 * Renderer (live AppContext) → AgentRuntime(registry) → seedProjectionBlocks(runtime.root).
 * `script` is the MockProvider turn list (one MockTurn dequeued per turn in the loop).
 *
 * stats is enabled WITH `show_block:true` so its block actually renders (the contract
 * round-trip is the gate; the App ships show_block:false by default for prod, but the
 * acceptance test needs the block visible to read the refreshed numbers off it).
 */
function boot(script: MockTurn[]): Boot {
  const reg = new AppRegistry();
  // R-6: register the built-in contracts BEFORE install so checkProvides can resolve
  // each provides.via against the contract's output_schema (declaration-vs-declaration).
  reg.registerContract(MESSAGE_COUNT);
  reg.registerContract(TASK_COUNT);

  // Install the real apps (task + messages providers, stats consumer). Temp dirs for jsonl.
  const task = new TaskApp({ dir: join(dir, 'task'), configBase: join(dir, 'apps') });
  const messages = new MessagesApp({ dir: join(dir, 'messages'), configBase: join(dir, 'apps') });
  reg.install(task.manifest());
  reg.install(messages.manifest());
  // stats consumes message_count + task_count; show_block:true so the block renders here.
  reg.install(makeStatsApp({ msg_count: 0, task_count: 0, config: { show_block: true } }));

  const tree = new BlockTree(); // empty-tree boot (synthetic core:root)
  const ops = Operations.with_default_policy({ tree, registry: reg });
  // Cross-App invoke_command re-enters PolicyEngine (INV #11) — exactly as the boot wires.
  reg.commandRouter = (fn, a, inv) => ops.invoke_command(fn, a, inv);

  const renderer = new Renderer(reg, { app_context_provider: (id) => reg.get_app_context(id) });
  const runtime = new AgentRuntime({
    operations: ops,
    renderer,
    provider: new MockProvider(script),
    registry: reg,
    // CM-4: the seed parent MUST match the live tree root. `new BlockTree()` builds a
    // synthetic `core:root`; the runtime's default root_name is `root:root`, so we pass
    // `core:root` here (exactly as launch.ts passes ROOT_NAME='core:root') so `runtime.root`
    // == the real tree root and seedProjectionBlocks attaches placeholders that exist.
    root_name: ROOT_NAME,
  });
  return { reg, ops, renderer, runtime, task, messages, tree };
}

/** Seed every registered builder-output placeholder under the runtime's real root (CM-4). */
async function seed(b: Boot): Promise<void> {
  await b.reg.seedProjectionBlocks(
    (name) => b.ops.has(name),
    (ops) => b.ops.apply(ops, { invoker: 'app' }),
    b.runtime.root,
  );
}

/** Render the whole prompt and flatten its segments into one searchable string. */
async function renderText(b: Boot): Promise<string> {
  const r = await b.renderer.render(b.ops.snapshot());
  return r.segments.map((s) => (typeof s.rendered === 'string' ? s.rendered : '')).join('\n');
}

/** The stats App's current derived state (consume-refresh overwrites these each turn). */
function statsState(b: Boot): { msg_count: number; task_count: number } {
  const s = b.reg.get_app_context('stats')?.state as
    | { msg_count?: unknown; task_count?: unknown }
    | undefined;
  return {
    msg_count: typeof s?.msg_count === 'number' ? s.msg_count : NaN,
    task_count: typeof s?.task_count === 'number' ? s.task_count : NaN,
  };
}

// ============================================================================
// THE acceptance trace
// ============================================================================

describe('multi-app e2e (real Registry + Operations + Renderer + Runtime + task/messages/stats)', () => {
  it('§5 trace: external ingest → stats sees task_count=1 → agent completes+chats → task:list collapses, stats refreshes', async () => {
    // The agent's turn (§5 step 4): complete the task, then reply to the user. The reply
    // (messages.chat) carries end_turn:true so the runtime stops the loop after it.
    // NOTE on the task id: TaskApp's id scheme (confirmed with impl-apps) is a per-instance
    // monotonic counter `task_N` — `ext_id` is a SEPARATE foreign reference, never our id.
    // So the first ingested task gets id `task_1`; `ext_id:'JIRA-42'` is stored alongside.
    const script: MockTurn[] = [
      {
        tool_calls: [
          { id: 'c1', name: 'task.complete', args: { id: 'task_1' } },
          { id: 'c2', name: 'messages.chat', args: { content: '已完成「整理周报」。' } },
        ],
      },
    ];
    const b = boot(script);
    await seed(b);

    // --- step 1: Turn 0 — empty state. consume-refresh pulls 0/0; stats reads {0,0}. ---
    // (We render once before any wake to confirm the empty baseline; the runtime also
    //  runs consume-refresh each turn, but here nothing has happened yet.)
    // task:list has no open task → its builder returns null → the block is absent.
    const turn0 = await renderText(b);
    expect(turn0).not.toContain('整理周报'); // no task yet

    // --- step 2: an external system assigns a task via task.ingest (invoker=app). ---
    // This is the front door the ExternalTaskAdapter drives. It durably records the task,
    // set_state, and ctx.wake → AppRegistry.wakeHook → runtime.on_wake (drives the loop).
    const ingest = await b.ops.invoke_command(
      'task.ingest',
      { title: '整理周报', ext_id: 'JIRA-42' },
      EXT,
    );
    expect(ingest.ok).toBe(true);

    // Drive the turn loop (the boot would wire wakeHook → on_wake; here we call it
    // directly with the task wake so the test owns the timing). `ref` is opaque to the
    // runtime (consume-refresh never branches on it). The single scripted turn runs:
    // consume-refresh (task_count now 1) → render → agent completes + chats.
    await b.runtime.on_wake({ kind: 'app_event', source: 'task', reason: 'task_arrived', ref: 'task_1' });

    // After the wake the agent turn ran: the task was completed (count→0) and a reply was
    // appended (messages count→1). The runtime is back to idle (messages.chat end_turn).
    expect(b.runtime.state.kind).toBe('idle');

    // --- step 5: Turn 2 context. Run ONE more consume-refresh + render to capture the
    //   settled state (task_count=0, msg_count=1). The runtime ran consume-refresh inside
    //   the turn already; we render again here to read the post-turn projection. ---
    // Re-run consume-refresh via a no-op wake so stats re-derives from the now-final
    // provider counts, then render. (A fresh MockProvider turn is empty → one refresh.)
    const b2settle = b; // same boot; drive a second, empty wake to refresh stats post-completion
    (b2settle.runtime as unknown as { provider: MockProvider }).provider = new MockProvider([{}]);
    await b2settle.runtime.on_wake({ kind: 'app_event', source: 'test', reason: 'settle', ref: 'x' });

    // CORE GATE 1 — the STATS contract round-trip really ran end to end:
    //   task.count → 0 (the task is done), messages.count → 1 (the agent's reply).
    const st = statsState(b);
    expect(st.task_count).toBe(0);
    expect(st.msg_count).toBe(1);

    // CORE GATE 2 — render the final prompt and assert the TIER SHRINK + stats refresh.
    const finalText = await renderText(b);
    // task:list build returns null when there is no open task → the block disappears
    // (context auto-shrinks). We assert on the task:list block's own HEADER ('# Open tasks',
    // task.ts TaskListBlockBuilder), NOT the bare task title — the title legitimately
    // re-appears inside the agent's reply ('已完成「整理周报」。'), so a substring check on
    // the title would be a false negative. The header is present iff the block rendered.
    expect(finalText).not.toContain('# Open tasks');
    // stats:summary refreshed: it carries the new counts (0 待办 / 1 条消息). We assert on
    // the numbers, which are the load-bearing contract values (wording is the App's).
    expect(finalText).toMatch(/0[^0-9]*待办/);
    expect(finalText).toMatch(/1[^0-9]*消息/);
    // The agent's reply body is in the conversation projection.
    expect(finalText).toContain('已完成「整理周报」。');
  });

  it('step 3 mid-trace: after ingest, stats sees task_count=1 and task:list shows the task (before completion)', async () => {
    // Same boot but the agent turn does NOTHING (empty script) — so the task stays open and
    // we can assert the turn-1 context (§5 step 3): task_count=1, task:list renders the task.
    const b = boot([{}]);
    await seed(b);

    const ingest = await b.ops.invoke_command(
      'task.ingest',
      { title: '整理周报', ext_id: 'JIRA-42' },
      EXT,
    );
    expect(ingest.ok).toBe(true);

    // One turn: consume-refresh pulls task.count→1; the empty agent turn ends the loop.
    await b.runtime.on_wake({ kind: 'app_event', source: 'task', reason: 'task_arrived', ref: 'task_1' });

    // stats derived task_count=1 from the contract pull (msg_count still 0).
    const st = statsState(b);
    expect(st.task_count).toBe(1);
    expect(st.msg_count).toBe(0);

    // The rendered prompt shows the open task (task:list) and the stats line "1 待办".
    const text = await renderText(b);
    expect(text).toContain('整理周报');
    expect(text).toMatch(/1[^0-9]*待办/);
  });

  it('the task.count / messages.count contract via commands are NOT in the agent tool catalog (DR-F)', async () => {
    // The contract via commands are app-facing readonly (allowed_invokers excludes agent),
    // so they must never appear in the agent's tool catalog. We assert it via the same
    // filter launch.buildToolCatalog uses: a command is agent-visible iff allowed_invokers
    // is unset or includes 'agent'. (commands-only feedback / the agent acting on task:list
    // is how the agent learns the count — never by calling count directly.)
    const b = boot([{}]);
    const agentVisible: string[] = [];
    for (const manifest of b.reg.list()) {
      for (const factory of manifest.commands) {
        const cmd = factory(manifest.initial_state);
        const visible = cmd.allowed_invokers === undefined || cmd.allowed_invokers.includes('agent');
        if (visible) agentVisible.push(`${manifest.id}.${cmd.name}`);
      }
    }
    expect(agentVisible).not.toContain('task.count');
    expect(agentVisible).not.toContain('messages.count');
    expect(agentVisible).not.toContain('task.ingest'); // ingest is ['user','app'] (AI-2/§4.2)
    // sanity: the agent CAN see the action commands it needs (complete, chat).
    expect(agentVisible).toContain('task.complete');
    expect(agentVisible).toContain('messages.chat');
  });
});
