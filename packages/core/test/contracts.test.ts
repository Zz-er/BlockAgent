/**
 * test/contracts.test.ts — the P1 contract-model runtime (impl-registry owned).
 *
 * Exercises the three pieces impl-registry added on the locked contract:
 *   - app/contracts.ts  `validateAgainstSchema` (R-2): the REAL scalar/object
 *     validator (returns a {ok} union, never throws).
 *   - app/registry.ts   `deriveContractTable` (A3) + the assemble-time `provides`
 *     checks (R-1 type, R-3 readonly, DR-F footgun) + the bootstrap satisfiability
 *     warning (consumes with no provider).
 *   - core/operations.ts `invoke_query` (R-3): resolve → check → route → return
 *     ONLY data, NEVER applyOps (the tree is byte-identical before and after).
 *
 * Everything here uses ONE-OFF FIXTURE manifests (mirroring render_registry.test.ts);
 * no standard app, no real `.block-agent`. The `invoke_query` tests drive the REAL
 * Operations class (core/operations.ts) over the REAL BlockTree + PolicyEngine + a
 * REAL AppRegistry, so the "never writes the tree" guarantee is proven end-to-end.
 */

import { describe, expect, it } from 'vitest';

import { AppRegistry } from '../src/app/registry.js';
import {
  MESSAGE_COUNT,
  TASK_COUNT,
  validateAgainstSchema,
  type ContractDef,
} from '../src/app/contracts.js';
import { Operations } from '../src/core/operations.js';
import { BlockTree } from '../src/core/block.js';
import { PolicyEngine } from '../src/core/policy.js';
import type { Block, InvokerContext } from '../src/core/types.js';
import type {
  AppManifest,
  CommandManifest,
  CommandResult,
} from '../src/app/types.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A minimal manifest builder (mirrors render_registry.test.ts `manifest`). */
function manifest(opts: {
  id: string;
  commands?: CommandManifest[];
  provides?: { contract: string; via: string }[];
  consumes?: { contract: string; as: string }[];
  initial_state?: unknown;
}): AppManifest {
  return {
    id: opts.id,
    version: '1.0.0',
    depends_on: [],
    tree_namespace: `/${opts.id}`,
    initial_state: opts.initial_state ?? {},
    state_schema: {},
    builders: [],
    commands: (opts.commands ?? []).map((c) => () => c),
    ...(opts.provides ? { provides: opts.provides } : {}),
    ...(opts.consumes ? { consumes: opts.consumes } : {}),
  };
}

/**
 * A read-only count command: returns a scalar number in `CommandResult.data`,
 * declares `result_schema {type:'number'}`, `readonly:true`, and (by default)
 * restricts itself to non-agent invokers so it is NOT a tool_catalog footgun.
 * `value` is the scalar it returns; `overrides` tweaks the declaration for the
 * negative-path tests (drop readonly / drop result_schema / open to agent).
 */
function countCommand(
  name: string,
  value: number,
  overrides: Partial<CommandManifest> = {},
): CommandManifest {
  return {
    name,
    description: `count fixture returning ${value}`,
    result_schema: { type: 'number' },
    readonly: true,
    allowed_invokers: ['user', 'app'],
    capabilities: [],
    invoke: async () => ({ ok: true, data: value }),
    ...overrides,
  };
}

/**
 * Like `countCommand` but OMITS a key entirely (rather than setting it to
 * `undefined`, which `exactOptionalPropertyTypes` forbids). Used by the
 * "no result_schema" / "allowed_invokers unset" negative-path tests.
 */
function countCommandOmitting(
  name: string,
  value: number,
  omit: 'result_schema' | 'allowed_invokers',
): CommandManifest {
  const cmd = countCommand(name, value);
  delete (cmd as unknown as Record<string, unknown>)[omit];
  return cmd;
}

const AS_APP: InvokerContext = { invoker: 'app', identity: 'test' };

// ===========================================================================
// validateAgainstSchema (R-2) — scalar / object / array / failure paths
// ===========================================================================

describe('validateAgainstSchema (R-2)', () => {
  it('accepts a finite number and rejects NaN / Infinity / non-number', () => {
    expect(validateAgainstSchema(42, { type: 'number' }).ok).toBe(true);
    expect(validateAgainstSchema(0, { type: 'number' }).ok).toBe(true);
    expect(validateAgainstSchema(Number.NaN, { type: 'number' }).ok).toBe(false);
    expect(validateAgainstSchema(Number.POSITIVE_INFINITY, { type: 'number' }).ok).toBe(false);
    expect(validateAgainstSchema('5', { type: 'number' }).ok).toBe(false);
  });

  it('enforces integer-ness for type:integer', () => {
    expect(validateAgainstSchema(7, { type: 'integer' }).ok).toBe(true);
    const r = validateAgainstSchema(7.5, { type: 'integer' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/integer/);
  });

  it('checks string and boolean scalars', () => {
    expect(validateAgainstSchema('hi', { type: 'string' }).ok).toBe(true);
    expect(validateAgainstSchema(1, { type: 'string' }).ok).toBe(false);
    expect(validateAgainstSchema(true, { type: 'boolean' }).ok).toBe(true);
    expect(validateAgainstSchema('true', { type: 'boolean' }).ok).toBe(false);
  });

  it('validates an object: required keys present + present properties recurse', () => {
    const schema = {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'number' }, label: { type: 'string' } },
    };
    expect(validateAgainstSchema({ count: 3 }, schema).ok).toBe(true);
    expect(validateAgainstSchema({ count: 3, label: 'x' }, schema).ok).toBe(true);

    const missing = validateAgainstSchema({ label: 'x' }, schema);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/missing required key 'count'/);

    // A present property of the wrong type fails (the recursion bites).
    const badProp = validateAgainstSchema({ count: 'nope' }, schema);
    expect(badProp.ok).toBe(false);
    if (!badProp.ok) expect(badProp.error).toMatch(/count/);
  });

  it('rejects an array / null as an object', () => {
    expect(validateAgainstSchema([], { type: 'object' }).ok).toBe(false);
    expect(validateAgainstSchema(null, { type: 'object' }).ok).toBe(false);
  });

  it('validates array items recursively', () => {
    const schema = { type: 'array', items: { type: 'number' } };
    expect(validateAgainstSchema([1, 2, 3], schema).ok).toBe(true);
    expect(validateAgainstSchema([1, 'two'], schema).ok).toBe(false);
    expect(validateAgainstSchema('notarray', schema).ok).toBe(false);
  });

  it('treats a typeless schema as no-constraint (empty input_schema)', () => {
    expect(validateAgainstSchema(123, {}).ok).toBe(true);
    expect(validateAgainstSchema({ anything: true }, {}).ok).toBe(true);
    // The built-in count contracts use {} for input_schema (no-arg).
    expect(validateAgainstSchema(undefined, MESSAGE_COUNT.input_schema).ok).toBe(true);
  });

  it('is pure: same input → same result, and never throws', () => {
    const r1 = validateAgainstSchema(5, MESSAGE_COUNT.output_schema);
    const r2 = validateAgainstSchema(5, MESSAGE_COUNT.output_schema);
    expect(r1).toEqual(r2);
    expect(r1.ok).toBe(true);
    expect(() => validateAgainstSchema(Symbol('x'), { type: 'number' })).not.toThrow();
  });
});

// ===========================================================================
// deriveContractTable (A3) — fan-in + derivation
// ===========================================================================

describe('deriveContractTable (A3)', () => {
  it('fans multiple providers of the same contract into one entry', () => {
    const reg = new AppRegistry();
    const a = manifest({
      id: 'messages',
      commands: [countCommand('count', 3)],
      provides: [{ contract: 'message_count', via: 'count' }],
    });
    const b = manifest({
      id: 'wechat',
      commands: [countCommand('count', 5)],
      provides: [{ contract: 'message_count', via: 'count' }],
    });
    const table = reg.deriveContractTable([a, b]);
    expect(table.get('message_count')).toEqual([
      { app_id: 'messages', via: 'count' },
      { app_id: 'wechat', via: 'count' },
    ]);
  });

  it('is deterministic and empty for manifests that declare no provides', () => {
    const reg = new AppRegistry();
    const m = manifest({ id: 'plain' });
    expect(reg.deriveContractTable([m]).size).toBe(0);
  });

  it('keys multiple distinct contracts independently', () => {
    const reg = new AppRegistry();
    const stats = manifest({
      id: 'multi',
      commands: [countCommand('mc', 1), countCommand('tc', 2)],
      provides: [
        { contract: 'message_count', via: 'mc' },
        { contract: 'task_count', via: 'tc' },
      ],
    });
    const table = reg.deriveContractTable([stats]);
    expect(table.get('message_count')).toEqual([{ app_id: 'multi', via: 'mc' }]);
    expect(table.get('task_count')).toEqual([{ app_id: 'multi', via: 'tc' }]);
  });
});

// ===========================================================================
// bootstrap satisfiability (A3 / §3.3) — consumes with no provider → warning
// ===========================================================================

describe('contract satisfiability (bootstrap)', () => {
  it('warns when a consumed contract has zero providers (no throw)', () => {
    const reg = new AppRegistry();
    const consumer = manifest({
      id: 'stats',
      consumes: [{ contract: 'message_count', as: 'messages' }],
    });
    const [res] = reg.bootstrap([consumer]);
    expect(res!.warnings.join(' ')).toMatch(
      /consumes contract 'message_count'.*no installed App provides it/,
    );
  });

  it('does NOT warn when a provider is present in the same batch', () => {
    const reg = new AppRegistry();
    reg.registerContract(MESSAGE_COUNT);
    const provider = manifest({
      id: 'messages',
      commands: [countCommand('count', 3)],
      provides: [{ contract: 'message_count', via: 'count' }],
    });
    const consumer = manifest({
      id: 'stats',
      consumes: [{ contract: 'message_count', as: 'messages' }],
    });
    const results = reg.bootstrap([provider, consumer]);
    const statsRes = results.find((r) => r.installed_id === 'stats')!;
    expect(statsRes.warnings.join(' ')).not.toMatch(/no installed App provides/);
  });

  it('a contract-less batch installs with no new warnings (additive)', () => {
    const reg = new AppRegistry();
    const results = reg.bootstrap([manifest({ id: 'a' }), manifest({ id: 'b' })]);
    expect(results.every((r) => r.warnings.length === 0)).toBe(true);
  });
});

// ===========================================================================
// assemble-time provides checks (R-1 type, R-3 readonly, DR-F footgun)
// ===========================================================================

describe('assemble-time provides checks', () => {
  it('passes a well-formed provider with no warnings (output ⊨ result)', () => {
    const reg = new AppRegistry();
    reg.registerContract(MESSAGE_COUNT);
    const res = reg.install(
      manifest({
        id: 'messages',
        commands: [countCommand('count', 3)], // readonly, {type:number}, non-agent
        provides: [{ contract: 'message_count', via: 'count' }],
      }),
    );
    expect(res.warnings).toEqual([]);
  });

  it('R-1: warns on an output_schema/result_schema type mismatch', () => {
    const reg = new AppRegistry();
    reg.registerContract(MESSAGE_COUNT); // output_schema {type:'number'}
    const res = reg.install(
      manifest({
        id: 'messages',
        // via command declares a STRING result — mismatches the number contract.
        commands: [countCommand('count', 3, { result_schema: { type: 'string' } })],
        provides: [{ contract: 'message_count', via: 'count' }],
      }),
    );
    expect(res.warnings.join(' ')).toMatch(/output_schema type 'number' != .* 'string'/);
  });

  it('R-1: warns when the via command declares no result_schema', () => {
    const reg = new AppRegistry();
    reg.registerContract(MESSAGE_COUNT);
    const res = reg.install(
      manifest({
        id: 'messages',
        commands: [countCommandOmitting('count', 3, 'result_schema')],
        provides: [{ contract: 'message_count', via: 'count' }],
      }),
    );
    expect(res.warnings.join(' ')).toMatch(/declares no result_schema/);
  });

  it('R-3: warns when the via command is not readonly', () => {
    const reg = new AppRegistry();
    reg.registerContract(MESSAGE_COUNT);
    const res = reg.install(
      manifest({
        id: 'messages',
        commands: [countCommand('count', 3, { readonly: false })],
        provides: [{ contract: 'message_count', via: 'count' }],
      }),
    );
    expect(res.warnings.join(' ')).toMatch(/non-readonly command 'count'/);
  });

  it('DR-F: warns when the via command is agent-visible (allowed_invokers unset)', () => {
    const reg = new AppRegistry();
    reg.registerContract(MESSAGE_COUNT);
    const res = reg.install(
      manifest({
        id: 'messages',
        commands: [countCommandOmitting('count', 3, 'allowed_invokers')],
        provides: [{ contract: 'message_count', via: 'count' }],
      }),
    );
    expect(res.warnings.join(' ')).toMatch(/agent-visible command 'count'.*is unset/);
  });

  it("DR-F: warns when allowed_invokers explicitly includes 'agent'", () => {
    const reg = new AppRegistry();
    reg.registerContract(MESSAGE_COUNT);
    const res = reg.install(
      manifest({
        id: 'messages',
        commands: [countCommand('count', 3, { allowed_invokers: ['agent', 'user'] })],
        provides: [{ contract: 'message_count', via: 'count' }],
      }),
    );
    expect(res.warnings.join(' ')).toMatch(/agent-visible command 'count'.*includes 'agent'/);
  });

  it('warns when provides names an unknown via command', () => {
    const reg = new AppRegistry();
    reg.registerContract(MESSAGE_COUNT);
    const res = reg.install(
      manifest({
        id: 'messages',
        commands: [countCommand('count', 3)],
        provides: [{ contract: 'message_count', via: 'ghost' }],
      }),
    );
    expect(res.warnings.join(' ')).toMatch(/via unknown command 'ghost'/);
  });

  it('warns "unknown contract" and skips the type check when the contract is not registered', () => {
    // Without registerContract, the registry cannot resolve output_schema. The
    // reference is flagged (unknown contract, report-only) and the output⊨result
    // type check is skipped — but the readonly/footgun checks (which need only the
    // command manifest) still run. Here the command is otherwise clean, so the ONLY
    // warning is the unknown-contract one.
    const reg = new AppRegistry();
    const res = reg.install(
      manifest({
        id: 'messages',
        commands: [countCommand('count', 3)],
        provides: [{ contract: 'unregistered', via: 'count' }],
      }),
    );
    expect(res.warnings.join(' ')).toMatch(/provides unknown contract 'unregistered'/);
    // No type-mismatch / readonly / footgun warning (the command is clean + readonly + non-agent).
    expect(res.warnings).toHaveLength(1);
  });
});

// ===========================================================================
// invoke_query (R-3) — returns data, NEVER writes the tree
// ===========================================================================

/** A bare empty-tree root (matches fixtures.makeEmptyTree). */
function emptyTree(): BlockTree {
  const root: Block = {
    id: 'root',
    name: 'root:root',
    children: [],
    content_text: null,
    content_blob: null,
  };
  return new BlockTree(root);
}

/**
 * A command that BOTH returns data AND emits a create op. invoke_command would
 * apply the op (write the tree); invoke_query must return the data and DROP the op
 * (leave the tree byte-identical). `readonly`/result_schema are declared so it is a
 * legitimate provider shape, but the op is here precisely to prove the drop.
 */
function countWithStrayOp(name: string, value: number): CommandManifest {
  return {
    name,
    description: 'returns data and (mischievously) a create op',
    result_schema: { type: 'number' },
    readonly: true,
    capabilities: [{ name: 'block:write' }],
    invoke: async (): Promise<CommandResult> => ({
      ok: true,
      data: value,
      ops: [
        {
          kind: 'create',
          parent: 'root:root',
          block: {
            id: 'stray',
            name: 'messages:stray',
            children: [],
            content_text: 'SHOULD_NOT_BE_WRITTEN',
            content_blob: null,
          },
        },
      ],
    }),
  };
}

function wireOps(registry: AppRegistry, tree: BlockTree): Operations {
  const policy = new PolicyEngine({
    capability_resolver: (full_name) =>
      registry.resolve_command(full_name)?.capabilities ?? [],
    allowed_invokers_resolver: (full_name) =>
      registry.resolve_command(full_name)?.allowed_invokers ?? null,
  });
  return new Operations(tree, policy, registry);
}

describe('invoke_query (R-3)', () => {
  it('returns CommandResult.data and leaves the tree byte-identical (no applyOps)', async () => {
    const reg = new AppRegistry();
    reg.install(
      manifest({ id: 'messages', commands: [countWithStrayOp('count', 7)] }),
    );
    const tree = emptyTree();
    const ops = wireOps(reg, tree);

    const before = tree.snapshot().hash;
    const result = await ops.invoke_query('messages.count', {}, AS_APP);

    expect(result.ok).toBe(true);
    expect(result.data).toBe(7);
    // The stray create op was DROPPED — the block was never written...
    expect(tree.get('messages:stray')).toBeNull();
    // ...and the snapshot hash is unchanged (byte-identical, INV #1).
    expect(tree.snapshot().hash).toBe(before);
  });

  it('contrast: invoke_command WOULD apply the same op (proves the drop is real)', async () => {
    const reg = new AppRegistry();
    reg.install(
      manifest({ id: 'messages', commands: [countWithStrayOp('count', 7)] }),
    );
    const tree = emptyTree();
    const ops = wireOps(reg, tree);

    await ops.invoke_command('messages.count', {}, AS_APP);
    // Through the WRITE door the op is applied — the block now exists.
    expect(tree.get('messages:stray')?.content_text).toBe('SHOULD_NOT_BE_WRITTEN');
  });

  it('runs PolicyEngine.check FIRST: a denied invoker gets ok:false and no data', async () => {
    const reg = new AppRegistry();
    reg.install(
      manifest({
        id: 'messages',
        // user-only: the agent invoker is DENIED before routing (the "who" gate).
        commands: [countCommand('count', 9, { allowed_invokers: ['user'] })],
      }),
    );
    const tree = emptyTree();
    const ops = wireOps(reg, tree);

    const denied = await ops.invoke_query('messages.count', {}, { invoker: 'agent' });
    expect(denied.ok).toBe(false);
    expect((denied.data as { policy?: string } | undefined)?.policy).toBe('deny');

    // A permitted invoker gets the scalar.
    const allowed = await ops.invoke_query('messages.count', {}, { invoker: 'user' });
    expect(allowed).toEqual({ ok: true, data: 9 });
  });

  it('errors cleanly on an unknown command (no throw)', async () => {
    const reg = new AppRegistry();
    const tree = emptyTree();
    const ops = wireOps(reg, tree);
    const res = await ops.invoke_query('nope.missing', {}, AS_APP);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no such command: nope\.missing/);
  });
});

// ===========================================================================
// built-in contracts (sanity: shape is what registry/runtime expects)
// ===========================================================================

describe('built-in contracts', () => {
  it('MESSAGE_COUNT / TASK_COUNT are scalar-number, many, sum', () => {
    for (const def of [MESSAGE_COUNT, TASK_COUNT] as ContractDef[]) {
      expect(def.output_schema).toEqual({ type: 'number' });
      expect(def.cardinality).toBe('many');
      expect(def.combine).toBe('sum');
      // A scalar number satisfies the output_schema; an object does not.
      expect(validateAgainstSchema(5, def.output_schema).ok).toBe(true);
      expect(validateAgainstSchema({ count: 5 }, def.output_schema).ok).toBe(false);
    }
  });
});
