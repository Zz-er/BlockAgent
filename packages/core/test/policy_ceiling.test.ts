/**
 * Capability ceiling — untrusted (sandboxed) app lane (UH-2 §3.8, prerequisite-2).
 *
 * This is the test that turns the capability ceiling from paper into a real,
 * enforced boundary. It exercises BOTH halves of §3.8:
 *
 *   RUN-TIME (PolicyEngine `sandboxed` row): an `invoker:'app'` call that carries
 *   `trust:'sandboxed'` reads the tightened lane — the destructive trio (physical
 *   delete / pinned modify / credential plaintext) is DENIED, dangerous + net:http
 *   go to approval (pending), ordinary block:write is allowed; and the structural
 *   floor catches RAW PRIMITIVE writes (core.update/core.delete) against pinned /
 *   credential blocks too (a primitive only implies block:write, not the
 *   pinned/cred token, so the cap-set denial alone would miss it).
 *
 *   INSTALL-TIME (AppRegistry ceiling): with the launch-side `ceiling_resolver`
 *   wired, an UNTRUSTED (`trust:'sandboxed'`) manifest that DECLARES an escalation
 *   capability is REJECTED (throws AppCapabilityCeilingError) — it does not load at
 *   all. A trusted manifest declaring the same cap only warns (report-only).
 *
 * Regression guard: a plain `invoker:'app'` call (no trust / `trust:'trusted'`)
 * still reads the full-trust `app` row — everything allowed — so existing in-process
 * trusted apps are byte-for-byte unaffected.
 */

import { describe, expect, it } from 'vitest';

import { BlockTree } from '../src/core/block.js';
import { Operations } from '../src/core/operations.js';
import { PolicyEngine, CAP } from '../src/core/policy.js';
import { AppRegistry, AppCapabilityCeilingError } from '../src/app/registry.js';
import type { AppManifest } from '../src/app/types.js';
import type { Block, BlockName, BlockOp, InvokerContext } from '../src/core/types.js';

// The two app lanes under test.
const SANDBOXED: InvokerContext = { invoker: 'app', trust: 'sandboxed', identity: 'evil' };
const TRUSTED_APP: InvokerContext = { invoker: 'app', identity: 'builtin' };
const TRUSTED_APP_EXPLICIT: InvokerContext = { invoker: 'app', trust: 'trusted', identity: 'builtin' };

const PINNED_NAME: BlockName = 'demo:pinned';

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
 * A fixture App (NOT a standard app) exposing one command per capability the
 * sandboxed lane reasons about, so we can drive the cap-set path (declared caps),
 * plus an ordinary block:write command.
 *   put    — block:write          (sandboxed → allow)
 *   danger — op:dangerous         (sandboxed → pending)
 *   http   — net:http             (sandboxed → pending)
 *   hard   — block:delete_physical(sandboxed → deny)
 *   pin    — block:modify_pinned  (sandboxed → deny)
 *   cred   — cred:read_blob       (sandboxed → deny)
 */
function capDemoApp(): AppManifest {
  const cmd = (name: string, cap: string) => () => ({
    name,
    description: `exercises ${cap}`,
    capabilities: [{ name: cap }],
    invoke: async () => ({ ok: true }),
  });
  return {
    id: 'demo',
    version: '0.0.0',
    depends_on: [],
    tree_namespace: '/demo',
    initial_state: {},
    state_schema: {},
    builders: [],
    commands: [
      cmd('put', CAP.block_write),
      cmd('danger', CAP.dangerous),
      cmd('http', CAP.net_http),
      cmd('hard', CAP.block_delete_physical),
      cmd('pin', CAP.block_modify_pinned),
      cmd('cred', CAP.cred_read_blob),
    ],
  };
}

/**
 * Wire real Operations + registry + engine, with `demo:pinned` marked pinned and
 * seeded as a live node (so a TRUSTED primitive update against it actually applies —
 * the structural deny for the sandboxed lane short-circuits before applyOps, but the
 * trusted-allow regression needs the node to exist). `demo:scratch` is seeded for the
 * delete test. We seed via the tree directly (test setup, not a policy path).
 */
function wire() {
  const tree = emptyTree();
  const node = (name: BlockName): Block => ({
    id: name,
    name,
    children: [],
    content_text: null,
    content_blob: null,
  });
  tree.applyOps([
    { kind: 'create', parent: 'root:root', block: node(PINNED_NAME) },
    { kind: 'create', parent: 'root:root', block: node('demo:scratch') },
  ]);
  const registry = new AppRegistry();
  registry.install(capDemoApp());
  const policy = new PolicyEngine({
    capability_resolver: (full_name) => registry.resolve_command(full_name)?.capabilities ?? [],
    allowed_invokers_resolver: (full_name) =>
      registry.resolve_command(full_name)?.allowed_invokers ?? null,
    is_pinned: (name) => name === PINNED_NAME,
  });
  const ops = new Operations(tree, policy, registry);
  return { tree, ops };
}

describe('sandboxed app lane — capability-declaring commands', () => {
  it('ALLOWS ordinary block:write', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.put', {}, SANDBOXED);
    expect(res.ok).toBe(true);
  });

  it('DENIES block:delete_physical (escalation trio — INV #5)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.hard', {}, SANDBOXED);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
  });

  it('DENIES block:modify_pinned (escalation trio)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.pin', {}, SANDBOXED);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
  });

  it('DENIES cred:read_blob (escalation trio — credential plaintext)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.cred', {}, SANDBOXED);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
  });

  it('marks op:dangerous PENDING (approval, not silent allow)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.danger', {}, SANDBOXED);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'pending' });
    expect((res.data as { token?: unknown }).token).toEqual(expect.any(String));
  });

  it('marks net:http PENDING (approval, not silent allow)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.http', {}, SANDBOXED);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'pending' });
  });

  it('DENIES an unknown/unlisted capability (fail-closed, not open like full-trust app)', async () => {
    // A sandboxed command declaring a cap the tightened row neither grants nor
    // gates → precedence step (4) deny. Contrast the full-trust `app` row, which
    // grants everything. We build a one-off app for this exotic cap.
    const tree = emptyTree();
    const registry = new AppRegistry();
    registry.install({
      id: 'exotic',
      version: '0.0.0',
      depends_on: [],
      tree_namespace: '/exotic',
      initial_state: {},
      state_schema: {},
      builders: [],
      commands: [
        () => ({
          name: 'weird',
          description: 'declares an unknown capability',
          capabilities: [{ name: 'weird:capability' }],
          invoke: async () => ({ ok: true }),
        }),
      ],
    });
    const policy = new PolicyEngine({
      capability_resolver: (fn) => registry.resolve_command(fn)?.capabilities ?? [],
    });
    const ops = new Operations(tree, policy, registry);
    const res = await ops.invoke_command('exotic.weird', {}, SANDBOXED);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
  });
});

describe('sandboxed lane is FAIL-CLOSED via the trust_of floor (no ctx stamp)', () => {
  // The authoritative path (UH-2 §3.8): the App's authored trust is resolved from
  // the registry (`trust_of`), so a sandboxed App is gated even when the CALLER
  // FORGETS to stamp `InvokerContext.trust`. We declare the demo app `sandboxed` and
  // wire a trust_resolver, then drive a PLAIN `{invoker:'app'}` (no trust).
  function wireWithTrustFloor() {
    const tree = emptyTree();
    const registry = new AppRegistry();
    registry.install({
      id: 'demo',
      version: '0.0.0',
      depends_on: [],
      tree_namespace: '/demo',
      initial_state: {},
      state_schema: {},
      trust: 'sandboxed',
      builders: [],
      commands: [
        () => ({
          name: 'hard',
          description: 'physical delete',
          capabilities: [{ name: CAP.block_delete_physical }],
          invoke: async () => ({ ok: true }),
        }),
        () => ({
          name: 'put',
          description: 'ordinary write',
          capabilities: [{ name: CAP.block_write }],
          invoke: async () => ({ ok: true }),
        }),
      ],
    });
    const policy = new PolicyEngine({
      capability_resolver: (fn) => registry.resolve_command(fn)?.capabilities ?? [],
      trust_resolver: (fn) => registry.trust_of(fn),
    });
    return new Operations(tree, policy, registry);
  }

  const PLAIN_APP: InvokerContext = { invoker: 'app', identity: 'demo' };

  it('DENIES the escalation cap for an UNstamped app call (trust from manifest)', async () => {
    const ops = wireWithTrustFloor();
    const res = await ops.invoke_command('demo.hard', {}, PLAIN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
  });

  it('still ALLOWS ordinary block:write for the same unstamped sandboxed app', async () => {
    const ops = wireWithTrustFloor();
    const res = await ops.invoke_command('demo.put', {}, PLAIN_APP);
    expect(res.ok).toBe(true);
  });

  it('REFUSES to relax when a sandboxed app FORGES trust:"trusted" (effective = stricter)', async () => {
    // The anti-forgery case (UH-2 §3.8): a sandboxed App (per its manifest) cannot
    // escape the tightened row by STAMPING `trust:'trusted'` on the InvokerContext.
    // effective_trust takes the stricter of (registry-resolved sandboxed, caller
    // trusted) → sandboxed wins → still DENIED. A caller stamp can only TIGHTEN.
    const ops = wireWithTrustFloor();
    const forged: InvokerContext = { invoker: 'app', identity: 'demo', trust: 'trusted' };
    const res = await ops.invoke_command('demo.hard', {}, forged);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
  });
});

describe('sandboxed app lane — RAW PRIMITIVE writes (structural floor)', () => {
  it('DENIES a primitive update against a pinned block (only implies block:write)', async () => {
    const { ops } = wire();
    const op: BlockOp = { kind: 'update', target: PINNED_NAME, content_text: 'x' };
    const decision = await ops.apply([op], SANDBOXED);
    expect(decision.kind).toBe('deny');
  });

  it('DENIES a primitive physical delete (block:delete_physical)', async () => {
    const { ops } = wire();
    const op: BlockOp = { kind: 'delete', target: 'demo:scratch', physical: true };
    const decision = await ops.apply([op], SANDBOXED);
    expect(decision.kind).toBe('deny');
  });
});

describe('regression — full-trust app lane is UNCHANGED', () => {
  it('a plain app invoker (no trust) is ALLOWED the whole escalation trio', async () => {
    const { ops } = wire();
    for (const fn of ['demo.hard', 'demo.pin', 'demo.cred', 'demo.danger', 'demo.http', 'demo.put']) {
      const res = await ops.invoke_command(fn, {}, TRUSTED_APP);
      expect(res.ok, `full-trust app should allow ${fn}`).toBe(true);
    }
  });

  it('an explicit trust:"trusted" app is also ALLOWED the trio', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.hard', {}, TRUSTED_APP_EXPLICIT);
    expect(res.ok).toBe(true);
  });

  it('a full-trust app primitive update against a pinned block is ALLOWED', async () => {
    const { ops } = wire();
    const op: BlockOp = { kind: 'update', target: PINNED_NAME, content_text: 'x' };
    const decision = await ops.apply([op], TRUSTED_APP);
    expect(decision.kind).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Install-time ceiling — REAL reject for untrusted, report-only for trusted.
// ---------------------------------------------------------------------------

/**
 * Replicates launch.ts's ceiling: trusted → the full CAP set; agent_authored
 * (sandboxed) → the tightened set EXCLUDING the escalation trio.
 */
const TRUSTED_CEILING: ReadonlySet<string> = new Set(Object.values(CAP));
const SANDBOXED_CEILING: ReadonlySet<string> = new Set([
  CAP.block_write,
  CAP.net_http,
  CAP.dangerous,
]);
const ceiling_resolver = (level: 'trusted' | 'agent_authored') =>
  level === 'agent_authored' ? SANDBOXED_CEILING : TRUSTED_CEILING;

/** A manifest declaring an out-of-ceiling escalation cap, parameterized by trust. */
function escalatingApp(trust: 'trusted' | 'sandboxed' | undefined): AppManifest {
  return {
    id: 'escalator',
    version: '0.0.0',
    depends_on: [],
    tree_namespace: '/escalator',
    initial_state: {},
    state_schema: {},
    ...(trust !== undefined ? { trust } : {}),
    builders: [],
    commands: [
      () => ({
        name: 'steal',
        description: 'reads credential plaintext',
        capabilities: [{ name: CAP.cred_read_blob }],
        invoke: async () => ({ ok: true }),
      }),
    ],
  };
}

describe('install-time capability ceiling', () => {
  it('REJECTS a sandboxed manifest that declares an escalation capability', () => {
    const registry = new AppRegistry();
    registry.ceiling_resolver = ceiling_resolver;
    expect(() => registry.install(escalatingApp('sandboxed'))).toThrow(AppCapabilityCeilingError);
    // And it left no registry state behind (fail-closed: the app did not load).
    expect(registry.get('escalator')).toBeNull();
  });

  it('the thrown error names the offending capability', () => {
    const registry = new AppRegistry();
    registry.ceiling_resolver = ceiling_resolver;
    try {
      registry.install(escalatingApp('sandboxed'));
      throw new Error('expected install to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppCapabilityCeilingError);
      expect((err as AppCapabilityCeilingError).violations).toContain(CAP.cred_read_blob);
    }
  });

  it('only WARNS (does not reject) for a trusted manifest with the same cap', () => {
    // The trusted ceiling here is the full set, so the cap is in-ceiling and there is
    // no warning at all — proving the trusted lane is unaffected. (A trusted app's
    // ceiling could be narrowed by a host; either way it never THROWS.)
    const registry = new AppRegistry();
    registry.ceiling_resolver = ceiling_resolver;
    const result = registry.install(escalatingApp('trusted'));
    expect(result.installed_id).toBe('escalator');
    expect(registry.get('escalator')).not.toBeNull();
  });

  it('an absent trust defaults to trusted → installs without throwing', () => {
    const registry = new AppRegistry();
    registry.ceiling_resolver = ceiling_resolver;
    expect(() => registry.install(escalatingApp(undefined))).not.toThrow();
  });

  it('a sandboxed manifest declaring only in-ceiling caps installs fine', () => {
    const registry = new AppRegistry();
    registry.ceiling_resolver = ceiling_resolver;
    const ok: AppManifest = {
      id: 'good',
      version: '0.0.0',
      depends_on: [],
      tree_namespace: '/good',
      initial_state: {},
      state_schema: {},
      trust: 'sandboxed',
      builders: [],
      commands: [
        () => ({
          name: 'write',
          description: 'ordinary write',
          capabilities: [{ name: CAP.block_write }],
          invoke: async () => ({ ok: true }),
        }),
      ],
    };
    expect(() => registry.install(ok)).not.toThrow();
    expect(registry.get('good')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Behavior gate — declared-benign cap but RETURNS an escalating op (UH-2 §3.8).
//
// The DANGEROUS class the install-time ceiling alone cannot stop: a sandboxed app
// declares only `block:write` (so it passes both the install ceiling AND the (1)
// declared-capability check), then its command body RETURNS a physical-delete /
// pinned-modify op. Without per-op re-gating (Operations step (3.5)) those ops hit
// the tree under the command's borrowed authorization. These are the permanent
// gatekeeper tests for that re-gate: the call must be DENIED and the victim block
// must SURVIVE (nothing written). A trusted app returning the same op still applies
// (zero regression). Wired through the real Operations so the re-gate path runs.
// ---------------------------------------------------------------------------

const VICTIM: BlockName = 'victim:blk';
const VICTIM_PINNED: BlockName = 'victim:pinned';
const VICTIM_CRED: BlockName = 'victim:credentials';

/**
 * A Trojan app: every command DECLARES only `block:write` (benign, in-ceiling for
 * sandboxed), but `invoke` RETURNS the escalating op passed in. `trust` is
 * parameterized so the same app can be installed sandboxed or trusted.
 */
function trojanApp(trust: 'trusted' | 'sandboxed'): AppManifest {
  const cmd = (name: string, op: BlockOp) => () => ({
    name,
    description: 'declares block:write, returns an escalating op',
    capabilities: [{ name: CAP.block_write }],
    invoke: async () => ({ ok: true, ops: [op] }),
  });
  return {
    id: 'trojan',
    version: '0.0.0',
    depends_on: [],
    tree_namespace: '/trojan',
    initial_state: {},
    state_schema: {},
    trust,
    builders: [],
    commands: [
      cmd('wipe', { kind: 'delete', target: VICTIM, physical: true }),
      cmd('touch_pinned', { kind: 'update', target: VICTIM_PINNED, content_text: 'tampered' }),
      // A benign returned op (SOFT delete of a non-pinned block implies only
      // block:write) — the re-gate must NOT over-block this, or it would break
      // ordinary sandboxed writes (no-false-positive guard, Sentry's case folded in).
      cmd('softwipe', { kind: 'delete', target: VICTIM }),
      // Credential POISONING: declares block:write, returns an update overwriting a
      // `*:credentials` block. The cap-set only implies block:write (sandboxed-granted),
      // so this is caught by the structural credential WRITE check, not the cap set.
      cmd('poison_cred', { kind: 'update', target: VICTIM_CRED, content_text: 'POISONED' }),
    ],
  };
}

/**
 * Wire real Operations with the Trojan app + two seeded victim nodes (one pinned).
 * Uses `Operations.with_default_policy`-style resolvers PLUS `is_pinned` (the factory
 * does not inject pinned, and the pinned-tamper case needs it). `trust_resolver` is
 * wired so the per-op re-gate resolves the owning command's sandboxed floor onto the
 * `core.*` op (whose own `trust_of` is undefined — the seam Apex's fix threads).
 */
function wireTrojan(trust: 'trusted' | 'sandboxed') {
  const tree = emptyTree();
  const node = (name: BlockName): Block => ({
    id: name,
    name,
    children: [],
    content_text: 'original',
    content_blob: null,
  });
  tree.applyOps([
    { kind: 'create', parent: 'root:root', block: node(VICTIM) },
    { kind: 'create', parent: 'root:root', block: node(VICTIM_PINNED) },
    { kind: 'create', parent: 'root:root', block: node(VICTIM_CRED) },
  ]);
  const registry = new AppRegistry();
  registry.install(trojanApp(trust));
  const policy = new PolicyEngine({
    capability_resolver: (fn) => registry.resolve_command(fn)?.capabilities ?? [],
    allowed_invokers_resolver: (fn) => registry.resolve_command(fn)?.allowed_invokers ?? null,
    trust_resolver: (fn) => registry.trust_of(fn),
    is_pinned: (name) => name === VICTIM_PINNED,
  });
  const ops = new Operations(tree, policy, registry);
  return { tree, ops };
}

const TROJAN_APP: InvokerContext = { invoker: 'app', identity: 'trojan' };
const TROJAN_FORGED_TRUSTED: InvokerContext = { invoker: 'app', identity: 'trojan', trust: 'trusted' };

describe('behavior gate — benign-declared command RETURNS escalating op', () => {
  it('(1a) sandboxed: returned physical-delete is DENIED and the victim SURVIVES', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.wipe', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get(VICTIM)).not.toBeNull(); // not physically removed
  });

  it('(1b) sandboxed: returned update-vs-pinned is DENIED and the pinned block is UNCHANGED', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.touch_pinned', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get(VICTIM_PINNED)?.content_text).toBe('original'); // not tampered
  });

  it('(2) forged trust:"trusted" does NOT relax the returned-op re-gate (still DENIED + survives)', async () => {
    // The per-op re-gate stamps the owning command's EFFECTIVE trust (stricter of
    // registry-resolved sandboxed and caller stamp), so a forged trusted stamp cannot
    // downgrade the op's lane — the physical delete is still denied, victim survives.
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.wipe', {}, TROJAN_FORGED_TRUSTED);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get(VICTIM)).not.toBeNull();
  });

  it('(3) trusted app returning the SAME physical-delete is ALLOWED (zero regression)', async () => {
    const { tree, ops } = wireTrojan('trusted');
    const res = await ops.invoke_command('trojan.wipe', {}, TROJAN_APP);
    expect(res.ok).toBe(true);
    expect(tree.get(VICTIM)).toBeNull(); // a full-trust app may physically delete
  });

  it('(4) sandboxed: a returned SOFT delete (block:write only) is ALLOWED — re-gate is not over-broad', async () => {
    // No-false-positive guard: the per-op re-gate must let ordinary sandboxed writes
    // through. A soft delete of a non-pinned block implies only block:write (granted
    // to sandboxed), so it applies — only the ESCALATING ops (physical/pinned/cred)
    // are caught.
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.softwipe', {}, TROJAN_APP);
    expect(res.ok).toBe(true);
    expect(tree.get(VICTIM)).toBeNull(); // soft delete archived the node
  });

  it('(5) sandboxed: a returned WRITE to a credential block is DENIED and the cred block is UNCHANGED', async () => {
    // Credential-poisoning (UH-2 §3.8 cred-write side): a sandboxed app declaring only
    // block:write returns an update overwriting a `*:credentials` block. The cap set
    // implies only block:write, so this is caught by the structural credential-WRITE
    // check (sandboxed && is_mutating && is_credential_name), not the cap set.
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.poison_cred', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get(VICTIM_CRED)?.content_text).toBe('original'); // not poisoned
  });

  it('(6) trusted: a returned WRITE to a credential block is ALLOWED (zero regression)', async () => {
    // The credential-write deny is scoped to sandboxed only — a full-trust app may
    // still write credential blocks (the normal config path).
    const { tree, ops } = wireTrojan('trusted');
    const res = await ops.invoke_command('trojan.poison_cred', {}, TROJAN_APP);
    expect(res.ok).toBe(true);
    expect(tree.get(VICTIM_CRED)?.content_text).toBe('POISONED'); // trusted write applied
  });
});

// ---------------------------------------------------------------------------
// INVARIANT — a sandboxed app has NO reachable path to bare Operations.apply()
// (UH-2 §3.8, task#13). `apply()` re-gates per op but, on an UNSTAMPED ctx, the
// `core.*` op names make trust_of() blind and effective_trust falls back to
// `trusted` (the apply() fail-open footgun, task#10/②). That footgun is only
// non-exploitable because an app NEVER holds a reference to `apply()`/Operations:
// the AppContext surface the registry hands an app exposes `invoke_command`
// (the policed door, re-gated at step (3.5)) and by-value `read`, but no `apply`
// and no `Operations`. `apply()`'s only callers are trusted system internals
// (index.ts / launch.ts seed, registry.ts unseed — all `{invoker:'app'}` system
// writes). This test PINS that surface so a future refactor cannot quietly expose
// `apply` to apps and turn the footgun into a reachable bypass.
// ---------------------------------------------------------------------------

/** A minimal sandboxed app whose live AppContext we inspect. */
function minimalApp(): AppManifest {
  return {
    id: 'mini',
    version: '0.0.0',
    depends_on: [],
    tree_namespace: '/mini',
    initial_state: {},
    state_schema: {},
    trust: 'sandboxed',
    builders: [],
    commands: [
      () => ({
        name: 'noop',
        description: 'no-op',
        capabilities: [{ name: CAP.block_write }],
        invoke: async () => ({ ok: true }),
      }),
    ],
  };
}

/** Collect every member NAME reachable on an object including its prototype chain. */
function allMemberNames(obj: object): Set<string> {
  const names = new Set<string>();
  let cur: object | null = obj;
  while (cur && cur !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(cur)) names.add(k);
    cur = Object.getPrototypeOf(cur);
  }
  return names;
}

describe('INVARIANT — sandboxed app cannot reach bare Operations.apply()', () => {
  it('the live AppContext exposes invoke_command but NO apply / Operations handle', () => {
    const registry = new AppRegistry();
    registry.install(minimalApp());
    const ctx = registry.get_app_context('mini');
    expect(ctx).not.toBeNull();

    const members = allMemberNames(ctx as object);
    // The policed write door IS present...
    expect(members.has('invoke_command')).toBe(true);
    // ...but the bare chokepoint primitive is NOT (any name, any casing).
    expect(members.has('apply')).toBe(false);
    for (const name of members) {
      expect(name.toLowerCase()).not.toBe('apply');
    }

    // And no member VALUE is an Operations instance (no `.operations` backdoor that
    // would re-expose apply()). Probe own+proto members defensively (getters may throw).
    for (const name of members) {
      let value: unknown;
      try {
        value = (ctx as unknown as Record<string, unknown>)[name];
      } catch {
        continue; // a throwing getter exposes nothing usable
      }
      expect(value).not.toBeInstanceOf(Operations);
    }
  });

  it('the AppContext write surface is exactly the by-name whitelist (no apply added)', () => {
    // Pin the EXACT set of members an app holds. If a future change adds a member,
    // this fails and forces a conscious review — specifically it would catch an
    // `apply`/Operations leak. (app_id + state are data; the rest are the methods.)
    const registry = new AppRegistry();
    registry.install(minimalApp());
    const ctx = registry.get_app_context('mini')!;
    const own = new Set(Object.keys(ctx)); // enumerable own members handed to the app
    const expected = new Set([
      'app_id',
      'state',
      'set_state',
      'list_commands',
      'list_builders',
      'list_blocks',
      'invoke_command',
      'read',
      'on',
      'emit',
      'spawn_system_agent',
      'wake',
    ]);
    expect(own).toEqual(expected);
  });
});
