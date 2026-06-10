/**
 * test/consume_refresh.test.ts — render-time consume-refresh hook (impl-runtime).
 *
 * Proves the P3 consume-refresh lifecycle point (§3.5, R-4 / CM-2 / CM-9) on the REAL
 * path: REAL AgentRuntime.runTurn → REAL Operations.invoke_query → REAL AppRegistry
 * (consumers / providers_of / resolve_contract / get_app_context) → REAL Renderer. The
 * unit-level seams are interface-optional, so a test double would make the whole hook a
 * silent no-op — only the real wiring exercises it end-to-end (the "green but the real
 * loop is broken" class projection_e2e guards against, applied here to consume-refresh).
 *
 * Setup mirrors projection_e2e + commands_only: install fixture provider/consumer Apps
 * into a real AppRegistry; wire Operations (PolicyEngine inside) + a Renderer with the
 * live-AppContext seam; drive ONE turn via `runtime.on_wake` with a MockProvider that
 * returns an empty turn (no commands → exactly one `consumeRefresh()` runs before the
 * snapshot, then the loop ends). Each test inspects the consumer's refreshed state
 * (and/or the rendered prompt) afterward.
 *
 * THE THREE DANGEROUS PATHS R-4 must block (each has a dedicated test):
 *   - partial failure → per-consumer atomic degrade (no half-new/half-old state);
 *   - a set_state schema breach must NOT unload the consumer App;
 *   - neither of the above (nor a thrown provider) may crash the turn.
 */

import { describe, expect, it } from 'vitest';

import { BlockTree } from '../src/core/block.js';
import { Operations } from '../src/core/operations.js';
import { Renderer } from '../src/core/renderer.js';
import { AppRegistry } from '../src/app/registry.js';
import { AgentRuntime } from '../src/runtime/agent_runtime.js';
import { MockProvider } from '../src/provider/mock.js';
import type {
  AppContext,
  AppManifest,
  BuildContext,
  BuilderManifest,
  CommandManifest,
  CommandResult,
  JsonSchema,
} from '../src/app/types.js';
import type { ContractDef } from '../src/app/contracts.js';
import type { Block, BlockName, BlockSnapshot, InvokerContext } from '../src/core/types.js';

// A message wake (base-ified, A5) — any event drives one turn; the runtime never
// branches on `reason`, so this stands in for "something happened, run a turn".
const WAKE = { kind: 'app_event', source: 'test', reason: 'tick', ref: 'r1' } as const;

// ============================================================================
// Fixture contracts — distinct from the built-ins so a test owns its combine mode
// ============================================================================

/** A scalar-number count contract, fan-in summed (like message_count/task_count). */
const COUNT_SUM: ContractDef = {
  name: 'test_count',
  version: '1',
  input_schema: {},
  output_schema: { type: 'number' },
  cardinality: 'many',
  combine: 'sum',
};

/**
 * A contract whose provider output PASSES `validateAgainstSchema` ({type:'object'}
 * accepts any non-null non-array object — a Date is `typeof 'object'`) so the value
 * reaches the consumer's set_state, where the App-state JSON-serializable guard
 * (INV #14) REJECTS it (a Date is a class instance, not a plain object) and throws
 * AppStateViolation. Used to prove layer-3: a set_state breach degrades the consumer
 * (keeps prior state) and never unloads the App / crashes the turn.
 */
const OBJECT_FIRST: ContractDef = {
  name: 'test_object',
  version: '1',
  input_schema: {},
  // Lenient: any object (incl. a Date) passes the CONTRACT check; the breach is on the
  // consumer's set_state side (INV #14 rejects the non-serializable class instance).
  output_schema: { type: 'object' },
  cardinality: 'one',
  combine: 'first',
};

// ============================================================================
// Fixture PROVIDER app — a readonly `via` command returning a scalar number
// ============================================================================

const NUMBER_RESULT_SCHEMA: JsonSchema = { type: 'number' };

/**
 * makeCountProvider — an App that provides a count contract. Its `via` command
 * (`<id>.count`) is `readonly` + `allowed_invokers:['app']` (so it never enters the
 * agent tool catalog, DR-F) and returns a SCALAR number in `CommandResult.data`. The
 * number comes from `initial_state.value`, so different providers can report
 * different counts for the fan-in test. `result_schema` matches the contract's
 * `output_schema` (R-1). It produces NO ops (pure read).
 *
 * `bad:true` makes the via return a NON-number ('oops') instead — a schema-invalid
 * datum that `validateAgainstSchema` rejects, driving the partial-failure path.
 */
function makeCountProvider(opts: {
  id: string;
  contract: string;
  value: number;
  bad?: boolean;
}): AppManifest {
  const count: CommandManifest = {
    name: 'count',
    description: 'Return the provider count (contract via, app-facing readonly).',
    readonly: true,
    allowed_invokers: ['app'],
    result_schema: NUMBER_RESULT_SCHEMA,
    capabilities: [],
    async invoke(_args: unknown, ctx: AppContext): Promise<CommandResult> {
      const s = ctx.state as { value: number };
      // `bad` returns a non-number → fails validateAgainstSchema downstream.
      return { ok: true, data: opts.bad ? ('oops' as unknown as number) : s.value };
    },
  };
  return {
    id: opts.id,
    version: '1.0.0',
    depends_on: [],
    provides: [{ contract: opts.contract, via: 'count' }],
    tree_namespace: `/${opts.id}`,
    initial_state: { value: opts.value },
    state_schema: {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'number' } },
    },
    builders: [],
    commands: [() => count],
  };
}

/**
 * makeObjectProvider — provides the OBJECT_FIRST contract: a readonly via returning a
 * Date (a class instance). It passes the contract's lenient `{type:'object'}`
 * output_schema (a Date is `typeof 'object'`), so consume-refresh combines it and
 * reaches the consumer's set_state — where the App-state JSON-serializable guard
 * (INV #14) rejects the non-plain object and throws AppStateViolation, exercising
 * layer-3 of the guardrail.
 */
function makeObjectProvider(opts: { id: string; contract: string }): AppManifest {
  const get: CommandManifest = {
    name: 'get',
    description: 'Return a non-serializable payload (contract via, app-facing readonly).',
    readonly: true,
    allowed_invokers: ['app'],
    result_schema: { type: 'object' },
    capabilities: [],
    async invoke(): Promise<CommandResult> {
      // A Date passes validateAgainstSchema({type:'object'}) but is a class instance →
      // the consumer's set_state JSON-serializable guard (INV #14) throws on it.
      return { ok: true, data: new Date(0) };
    },
  };
  return {
    id: opts.id,
    version: '1.0.0',
    depends_on: [],
    provides: [{ contract: opts.contract, via: 'get' }],
    tree_namespace: `/${opts.id}`,
    initial_state: {},
    state_schema: { type: 'object' },
    builders: [],
    commands: [() => get],
  };
}

// ============================================================================
// Fixture CONSUMER app — consumes a contract `as` a state field + renders it
// ============================================================================

/**
 * makeNumberConsumer — an App that consumes a number contract into `state.total` and
 * renders that number in its block `<id>:view`. The block is what proves the refresh
 * is visible to the agent: after consume-refresh folds the merged count into
 * `state.total`, the Renderer (live-context seam) projects it into the prompt.
 *
 * `state_schema` requires `total` to be a NUMBER. For the number-contract tests the
 * merged value is a number (passes); reused below for the partial-failure test where
 * the seed `total` must survive unchanged when refresh degrades.
 */
const CONSUMER_VIEW = (id: string): BlockName => `${id}:view`;

function makeNumberConsumer(opts: {
  id: string;
  contract: string;
  seed: number;
}): AppManifest {
  const view = CONSUMER_VIEW(opts.id);
  const builder: BuilderManifest = {
    name: `${opts.id}.view`,
    version: '1.0.0',
    owner: 'system',
    app_id: opts.id,
    inputs: [],
    outputs: [view],
    cache_tier: 'volatile',
    async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
      const s = (app_ctx?.state ?? {}) as { total?: unknown };
      if (typeof s.total !== 'number') return null;
      return {
        id: view,
        name: view,
        children: [],
        content_text: `total=${s.total}`,
        content_blob: null,
      };
    },
  };
  return {
    id: opts.id,
    version: '1.0.0',
    depends_on: [],
    consumes: [{ contract: opts.contract, as: 'total' }],
    tree_namespace: `/${opts.id}`,
    initial_state: { total: opts.seed },
    state_schema: {
      type: 'object',
      required: ['total'],
      properties: { total: { type: 'number' } },
    },
    builders: [() => builder],
    commands: [],
  };
}

/**
 * makeStrictObjectConsumer — consumes OBJECT_FIRST `as` `total`. The provider returns a
 * Date; the merged value `{...s, total: <Date>}` passes the registry's shallow
 * required-key check but is rejected by the App-state JSON-serializable guard
 * (INV #14 — a Date is a class instance), so set_state throws AppStateViolation. Layer
 * 3 must catch that so the App is NOT unloaded and the turn does not crash.
 */
function makeStrictObjectConsumer(opts: { id: string; contract: string; seed: number }): AppManifest {
  return {
    id: opts.id,
    version: '1.0.0',
    depends_on: [],
    consumes: [{ contract: opts.contract, as: 'total' }],
    tree_namespace: `/${opts.id}`,
    initial_state: { total: opts.seed },
    state_schema: {
      type: 'object',
      required: ['total'],
      properties: { total: { type: 'number' } },
    },
    builders: [],
    commands: [],
  };
}

// ============================================================================
// Wiring — real Registry + real Operations + real Renderer + real Runtime
// ============================================================================

interface Wired {
  reg: AppRegistry;
  ops: Operations;
  renderer: Renderer;
  runtime: AgentRuntime;
  tree: BlockTree;
}

/**
 * Install the given manifests + register the given contracts, then wire a runtime
 * EXACTLY like the boot: real Operations (PolicyEngine inside), a Renderer with the
 * live-AppContext seam, `commandRouter` so cross-App `invoke_command` re-enters
 * PolicyEngine, and the registry as the runtime's BuilderRegistry handle. The
 * MockProvider returns ONE empty turn so a single `on_wake` runs exactly one
 * `consumeRefresh()` (before the snapshot), then the loop ends.
 */
function wire(manifests: AppManifest[], contracts: ContractDef[]): Wired {
  const reg = new AppRegistry();
  for (const def of contracts) reg.registerContract(def);
  for (const m of manifests) reg.install(m);

  const tree = new BlockTree(); // empty-tree boot (synthetic core:root)
  const ops = Operations.with_default_policy({ tree, registry: reg });
  reg.commandRouter = (fn, a, inv) => ops.invoke_command(fn, a, inv);

  const renderer = new Renderer(reg, { app_context_provider: (id) => reg.get_app_context(id) });
  const runtime = new AgentRuntime({
    operations: ops,
    renderer,
    provider: new MockProvider([{}]),
    registry: reg,
  });
  return { reg, ops, renderer, runtime, tree };
}

/** The consumer App's current `state.total`, read through its live context. */
function totalOf(reg: AppRegistry, id: string): unknown {
  return (reg.get_app_context(id)?.state as { total?: unknown }).total;
}

/**
 * Render the whole prompt (seeding the consumer's view block first) and flatten it.
 * Seeds under `seedProjectionBlocks`' default parent (`core:root`, the empty-tree boot
 * root that `new BlockTree()` builds — NOT the AgentRuntime's `root:root` default).
 */
async function seedAndRenderText(w: Wired): Promise<string> {
  await seedViews(w);
  const r = await w.renderer.render(w.ops.snapshot());
  return r.segments.map((s) => (typeof s.rendered === 'string' ? s.rendered : '')).join('\n');
}

/** Seed all registered builder-output placeholders under the empty-tree root. */
async function seedViews(w: Wired): Promise<void> {
  await w.reg.seedProjectionBlocks(
    (name) => w.ops.has(name),
    (sOps) => w.ops.apply(sOps, { invoker: 'app', trust: 'trusted' }),
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('consume-refresh (real runtime + Operations + registry + renderer)', () => {
  it('① normal round-trip: a provider count refreshes consumer state[as] and renders', async () => {
    const w = wire(
      [
        makeCountProvider({ id: 'prov', contract: COUNT_SUM.name, value: 7 }),
        makeNumberConsumer({ id: 'cons', contract: COUNT_SUM.name, seed: 0 }),
      ],
      [COUNT_SUM],
    );

    await w.runtime.on_wake(WAKE);

    // The merged count landed in the consumer's state.
    expect(totalOf(w.reg, 'cons')).toBe(7);
    // ...and the consumer's block renders the refreshed value (visible to the agent).
    const text = await seedAndRenderText(w);
    expect(text).toContain('total=7');
    expect(w.runtime.state.kind).toBe('idle');
  });

  it('② multi-provider fan-in: two providers SUM into the consumer state', async () => {
    const w = wire(
      [
        makeCountProvider({ id: 'prov_a', contract: COUNT_SUM.name, value: 3 }),
        makeCountProvider({ id: 'prov_b', contract: COUNT_SUM.name, value: 4 }),
        makeNumberConsumer({ id: 'cons', contract: COUNT_SUM.name, seed: 99 }),
      ],
      [COUNT_SUM],
    );

    await w.runtime.on_wake(WAKE);

    // sum(3, 4) = 7 — both providers fanned in and combined (not 99, not 3, not 4).
    expect(totalOf(w.reg, 'cons')).toBe(7);
    const text = await seedAndRenderText(w);
    expect(text).toContain('total=7');
  });

  it('③ partial failure: one bad provider degrades the WHOLE consumer to its prior state', async () => {
    // prov_good returns 3 (valid); prov_bad returns a non-number (fails validate). The
    // entry fails → per-consumer atomic degrade: the consumer keeps its SEED (5), it is
    // NOT set to 3 (no half-new/half-old), and the turn does not crash.
    const w = wire(
      [
        makeCountProvider({ id: 'prov_good', contract: COUNT_SUM.name, value: 3 }),
        makeCountProvider({ id: 'prov_bad', contract: COUNT_SUM.name, value: 0, bad: true }),
        makeNumberConsumer({ id: 'cons', contract: COUNT_SUM.name, seed: 5 }),
      ],
      [COUNT_SUM],
    );

    await w.runtime.on_wake(WAKE); // must not throw

    // Degraded to the previous (seed) value — never the partial 3, never a mix.
    expect(totalOf(w.reg, 'cons')).toBe(5);
    const text = await seedAndRenderText(w);
    expect(text).toContain('total=5');
    expect(w.runtime.state.kind).toBe('idle'); // turn survived
  });

  it('④ set_state schema breach does NOT unload the consumer and does NOT crash the turn', async () => {
    // The object provider returns a Date (passes the lenient contract output_schema),
    // but the consumer's set_state JSON-serializable guard (INV #14) rejects the class
    // instance → throws AppStateViolation. Layer 3 catches it: the App stays installed,
    // keeps its seed, and the turn completes.
    const w = wire(
      [
        makeObjectProvider({ id: 'oprov', contract: OBJECT_FIRST.name }),
        makeStrictObjectConsumer({ id: 'ocons', contract: OBJECT_FIRST.name, seed: 42 }),
      ],
      [OBJECT_FIRST],
    );

    await w.runtime.on_wake(WAKE); // must not throw despite the AppStateViolation

    // The App is STILL installed (not unloaded) and kept its previous state.
    expect(w.reg.get_app_context('ocons')).not.toBeNull();
    expect(totalOf(w.reg, 'ocons')).toBe(42);
    expect(w.runtime.state.kind).toBe('idle'); // turn survived the breach
  });

  it('⑤ refresh happens BEFORE the snapshot: the turn-1 render already sees the refreshed value', async () => {
    // A renderer that captures the snapshot it is handed lets us assert the value the
    // builder saw came from consume-refresh (which ran before snapshot), not from a
    // later manual render. We render INSIDE the runtime's own turn by spying on the
    // provider send: by the time send() is called, snapshot+render already happened with
    // refreshed state. We assert via the consumer block content captured at send time.
    const w = wire(
      [
        makeCountProvider({ id: 'prov', contract: COUNT_SUM.name, value: 11 }),
        makeNumberConsumer({ id: 'cons', contract: COUNT_SUM.name, seed: 0 }),
      ],
      [COUNT_SUM],
    );
    // Seed the consumer's view block FIRST so the runtime's own in-turn render collects
    // it (the runtime renders the live tree each turn). Then the prompt the provider
    // receives must carry total=11 — proving refresh ran before that snapshot.
    await seedViews(w);

    await w.runtime.on_wake(WAKE);

    const provider = (w.runtime as unknown as { provider: MockProvider }).provider;
    const sentPrompt = provider.last_prompt;
    const flat = (sentPrompt?.segments ?? [])
      .map((s) => (typeof s.rendered === 'string' ? s.rendered : ''))
      .join('\n');
    expect(flat).toContain('total=11'); // the refreshed value was in the turn-1 prompt
  });

  it('contract-less boot is a clean no-op (no consumers ⇒ refresh does nothing, turn fine)', async () => {
    // No consumes anywhere → consumeRefresh returns immediately; the turn runs normally.
    const w = wire(
      [makeCountProvider({ id: 'prov', contract: COUNT_SUM.name, value: 1 })],
      [COUNT_SUM],
    );
    await expect(w.runtime.on_wake(WAKE)).resolves.toBeUndefined();
    expect(w.runtime.state.kind).toBe('idle');
  });
});
