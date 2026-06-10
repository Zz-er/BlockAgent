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
import {
  APP_CONTEXT_WHITELIST,
  allMemberNames,
  assertAppContextWhitelist,
} from './_support/appcontext_whitelist.js';
import { inProcessChildFactory } from './_support/in_process_child_factory.js';

// SS3c: these tests install `trust:'sandboxed'` manifests to exercise the POLICY ENGINE
// (sandboxed row / install-time ceiling / cross-ns / whitelist) IN-PROCESS — not the
// real carrier. resolveHost now routes a sandboxed manifest to 'child-process' and
// `instantiate` fail-closed-throws without a child factory, so we inject the TEST-ONLY
// in-process factory. `sandboxedRegistry()` is the one place that wires it. Production
// has no such factory (footgun guard) — a real sandboxed app forks a child or throws.
function sandboxedRegistry(): AppRegistry {
  const reg = new AppRegistry();
  reg.child_host_factory = inProcessChildFactory;
  return reg;
}

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
  const registry = sandboxedRegistry(); // capDemoApp is trust:'sandboxed' (SS3c, see helper)
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
    const registry = sandboxedRegistry(); // demo is trust:'sandboxed' (SS3c)
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

  it('a full-trust app primitive update against a pinned block is ALLOWED (explicit trust:"trusted")', async () => {
    // task#10 flipped apply()'s default to fail-closed: a TRUSTED system write through
    // the apply() primitive must now stamp `trust:'trusted'` explicitly (the command
    // path above keeps deriving trust from trust_of and is unaffected). An UNSTAMPED app
    // apply() is now gated to the sandboxed lane — covered by the "apply() fail-closed
    // default" describe block below.
    const { ops } = wire();
    const op: BlockOp = { kind: 'update', target: PINNED_NAME, content_text: 'x' };
    const decision = await ops.apply([op], TRUSTED_APP_EXPLICIT);
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
    const registry = sandboxedRegistry(); // sandboxed manifest needs a child factory to reach the ceiling check
    registry.ceiling_resolver = ceiling_resolver;
    expect(() => registry.install(escalatingApp('sandboxed'))).toThrow(AppCapabilityCeilingError);
    // And it left no registry state behind (fail-closed: the app did not load).
    expect(registry.get('escalator')).toBeNull();
  });

  it('the thrown error names the offending capability', () => {
    const registry = sandboxedRegistry();
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
    const registry = sandboxedRegistry();
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

// The writer's OWN namespace (`trojan:*`) — used by the capability/structural-axis
// tests so a benign in-namespace write isolates that axis from the cross-ns axis.
const TROJAN_OWN: BlockName = 'trojan:blk';
const TROJAN_PINNED: BlockName = 'trojan:pinned';
const TROJAN_CRED: BlockName = 'trojan:credentials';
const TROJAN_HOME: BlockName = 'trojan:home';
// Another app's namespace (`victim:*`) — the cross-ns deny targets / seeded so a
// tamper attempt has a real node to (fail to) mutate.
const VICTIM_DATA: BlockName = 'victim:data';
const VICTIM_HOME: BlockName = 'victim:home';

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
      cmd('wipe', { kind: 'delete', target: TROJAN_OWN, physical: true }),
      cmd('touch_pinned', { kind: 'update', target: TROJAN_PINNED, content_text: 'tampered' }),
      // A benign returned op (SOFT delete of a non-pinned block the writer OWNS implies
      // only block:write) — the re-gate must NOT over-block this, or it would break
      // ordinary sandboxed writes (no-false-positive guard, Sentry's case folded in).
      // Targets the writer's OWN namespace so it isolates the capability axis from the
      // cross-namespace axis (task#12) — a soft delete of `victim:*` would now (rightly)
      // be denied by the cross-ns gate, which is a separate test below.
      cmd('softwipe', { kind: 'delete', target: TROJAN_OWN }),
      // Credential POISONING: declares block:write, returns an update overwriting the
      // writer's OWN `*:credentials` block. The cap-set only implies block:write
      // (sandboxed-granted), so this is caught by the structural credential WRITE check,
      // not the cap set. The block is in the writer's namespace so the cross-ns gate
      // does NOT fire — isolating the cred-write axis (task#11) from cross-ns (task#12).
      cmd('poison_cred', { kind: 'update', target: TROJAN_CRED, content_text: 'POISONED' }),
      // CROSS-NAMESPACE writes (task#12): each is an ordinary block:write op (granted to
      // the sandboxed lane, in the writer's OWN cap ceiling) whose object/parent lives in
      // ANOTHER app's namespace (`victim:*`), not the writer's (`trojan:*`). Caught ONLY
      // by the namespace-ownership gate, not the capability/structural per-op re-check.
      cmd('inject', { kind: 'create', parent: 'root:root', block: nodeNamed('victim:injected') }),
      cmd('tamper', { kind: 'update', target: 'victim:data', content_text: 'TAMPERED' }),
      // credentials_new naming seam (Sentry): `victim:credentials_new` is NOT matched by
      // is_credential_name, so the cred-write deny (task#11) misses it — but the cross-ns
      // gate catches it because it is in the victim's namespace.
      cmd('cred_seam', { kind: 'create', parent: 'root:root', block: nodeNamed('victim:credentials_new') }),
      // create UNDER a foreign parent: the OBJECT (`trojan:child`) is owned, but the
      // PARENT (`victim:home`) is foreign — appending into another app's subtree is also
      // a cross-ns write, so this must be denied on the parent.
      cmd('graft', { kind: 'create', parent: 'victim:home', block: nodeNamed('trojan:child') }),
      // MOVE a foreign node: target `victim:data` is foreign → denied on the target.
      cmd('steal_move', { kind: 'move', target: 'victim:data', new_parent: 'trojan:home' }),
      // own-namespace control: a create where BOTH object and parent are the writer's
      // own namespace must still be ALLOWED (the gate is not over-broad).
      cmd('mine', { kind: 'create', parent: 'trojan:home', block: nodeNamed('trojan:mine') }),
      // CREDENTIAL NAMING SEAM (task#14) — IN the writer's OWN namespace, so the cross-ns
      // gate (task#12) does NOT fire; only the tightened is_credential_name can catch it.
      // The rule is the BROAD `startsWith('credentials')` (lead-approved): any
      // `credentials*` local name is the reserved credentials subtree → cred-write deny.
      cmd('cred_new', { kind: 'create', parent: 'trojan:home', block: nodeNamed('trojan:credentials_new') }),
      // …the dash variant, same axis.
      cmd('cred_bak', { kind: 'update', target: 'trojan:credentials-bak', content_text: 'x' }),
      // …and the digit-suffix variant `credentials2` — the case a boundary-char rule would
      // have MISSED; the broad startsWith rule catches it.
      cmd('cred_two', { kind: 'create', parent: 'trojan:home', block: nodeNamed('trojan:credentials2') }),
      // …and the MIXED-CASE variant `CredentialsX` — caught because the rule lowercases
      // the local segment before the prefix test (case-insensitive).
      cmd('cred_caps', { kind: 'create', parent: 'trojan:home', block: nodeNamed('trojan:CredentialsX') }),
      // NEGATIVE control: an ordinary non-credential name in the writer's own namespace must
      // still be ALLOWED (the rule is not all-encompassing). `trojan:notes` shares no prefix
      // with `credentials`.
      cmd('not_cred', { kind: 'create', parent: 'trojan:home', block: nodeNamed('trojan:notes') }),
    ],
  };
}

/** A bare live-block node with a given name (helper for op fixtures). */
function nodeNamed(name: BlockName): Block {
  return { id: name, name, children: [], content_text: 'original', content_blob: null };
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
    // The writer's own seeded nodes (capability/structural-axis tests).
    { kind: 'create', parent: 'root:root', block: node(TROJAN_OWN) },
    { kind: 'create', parent: 'root:root', block: node(TROJAN_PINNED) },
    { kind: 'create', parent: 'root:root', block: node(TROJAN_CRED) },
    { kind: 'create', parent: 'root:root', block: node(TROJAN_HOME) },
    // A foreign app's seeded nodes (cross-ns-axis tests target/tamper these).
    { kind: 'create', parent: 'root:root', block: node(VICTIM_DATA) },
    { kind: 'create', parent: 'root:root', block: node(VICTIM_HOME) },
  ]);
  const registry = sandboxedRegistry(); // trojanApp may be trust:'sandboxed' (SS3c; harmless for trusted)
  registry.install(trojanApp(trust));
  const policy = new PolicyEngine({
    capability_resolver: (fn) => registry.resolve_command(fn)?.capabilities ?? [],
    allowed_invokers_resolver: (fn) => registry.resolve_command(fn)?.allowed_invokers ?? null,
    trust_resolver: (fn) => registry.trust_of(fn),
    is_pinned: (name) => name === TROJAN_PINNED,
  });
  const ops = new Operations(tree, policy, registry);
  return { tree, ops };
}

const TROJAN_APP: InvokerContext = { invoker: 'app', identity: 'trojan' };
const TROJAN_FORGED_TRUSTED: InvokerContext = { invoker: 'app', identity: 'trojan', trust: 'trusted' };

describe('behavior gate — benign-declared command RETURNS escalating op', () => {
  it('(1a) sandboxed: returned physical-delete is DENIED and the block SURVIVES', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.wipe', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get(TROJAN_OWN)).not.toBeNull(); // not physically removed
  });

  it('(1b) sandboxed: returned update-vs-pinned is DENIED and the pinned block is UNCHANGED', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.touch_pinned', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get(TROJAN_PINNED)?.content_text).toBe('original'); // not tampered
  });

  it('(2) forged trust:"trusted" does NOT relax the returned-op re-gate (still DENIED + survives)', async () => {
    // The per-op re-gate stamps the owning command's EFFECTIVE trust (stricter of
    // registry-resolved sandboxed and caller stamp), so a forged trusted stamp cannot
    // downgrade the op's lane — the physical delete is still denied, block survives.
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.wipe', {}, TROJAN_FORGED_TRUSTED);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get(TROJAN_OWN)).not.toBeNull();
  });

  it('(3) trusted app returning the SAME physical-delete is ALLOWED (zero regression)', async () => {
    const { tree, ops } = wireTrojan('trusted');
    const res = await ops.invoke_command('trojan.wipe', {}, TROJAN_APP);
    expect(res.ok).toBe(true);
    expect(tree.get(TROJAN_OWN)).toBeNull(); // a full-trust app may physically delete
  });

  it('(4) sandboxed: a returned SOFT delete of an OWNED block (block:write only) is ALLOWED — re-gate is not over-broad', async () => {
    // No-false-positive guard: the per-op re-gate must let ordinary sandboxed writes
    // through. A soft delete of a non-pinned block the writer OWNS implies only
    // block:write (granted to sandboxed), so it applies — only the ESCALATING ops
    // (physical/pinned/cred) and CROSS-NAMESPACE ops are caught.
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.softwipe', {}, TROJAN_APP);
    expect(res.ok).toBe(true);
    expect(tree.get(TROJAN_OWN)).toBeNull(); // soft delete archived the node
  });

  it('(5) sandboxed: a returned WRITE to an OWNED credential block is DENIED and the cred block is UNCHANGED', async () => {
    // Credential-poisoning (UH-2 §3.8 cred-write side): a sandboxed app declaring only
    // block:write returns an update overwriting its OWN `*:credentials` block. The cap
    // set implies only block:write, so this is caught by the structural credential-WRITE
    // check (sandboxed && is_mutating && is_credential_name), not the cap set — and the
    // block IS in the writer's namespace, so the cross-ns gate is not what fires here.
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.poison_cred', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get(TROJAN_CRED)?.content_text).toBe('original'); // not poisoned
  });

  it('(6) trusted: a returned WRITE to a credential block is ALLOWED (zero regression)', async () => {
    // The credential-write deny is scoped to sandboxed only — a full-trust app may
    // still write credential blocks (the normal config path).
    const { tree, ops } = wireTrojan('trusted');
    const res = await ops.invoke_command('trojan.poison_cred', {}, TROJAN_APP);
    expect(res.ok).toBe(true);
    expect(tree.get(TROJAN_CRED)?.content_text).toBe('POISONED'); // trusted write applied
  });
});

// ---------------------------------------------------------------------------
// Cross-namespace write isolation (task#12) — a sandboxed app may write ONLY
// blocks IT OWNS (`<app_id>:*`). This is a DIFFERENT axis from the capability
// ceiling: every op below is an ordinary `block:write` (granted to the sandboxed
// lane, passes the per-op capability/structural re-check), so ONLY the
// namespace-ownership gate (operations.ts step 3.5a) can stop it. Sentry's red-team
// confirmed the pre-fix holes (create victimapp:injected → ok, update victimapp:data
// → ok). These are the permanent gatekeeper tests for the fix.
// ---------------------------------------------------------------------------

describe('cross-namespace write isolation — sandboxed writes only its own <app_id>:*', () => {
  it('DENIES creating a block in ANOTHER app namespace (create victim:injected) and nothing is written', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.inject', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get('victim:injected')).toBeNull(); // never created
  });

  it('DENIES updating ANOTHER app block (update victim:data) and the block is UNCHANGED', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.tamper', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get(VICTIM_DATA)?.content_text).toBe('original'); // not tampered
  });

  it('DENIES the credentials_new naming-seam block (create victim:credentials_new) — cross-ns subsumes the cred-name pattern', async () => {
    // Sentry's seam: `victim:credentials_new` is NOT matched by is_credential_name, so
    // the cred-write deny misses it; but it is in the victim's namespace, so the cross-ns
    // gate denies it regardless of the cred pattern.
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.cred_seam', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get('victim:credentials_new')).toBeNull(); // never created
  });

  it('DENIES a create whose OBJECT is owned but PARENT is foreign (graft under victim:home)', async () => {
    // Appending into another app's subtree is also a cross-ns write — caught on the parent.
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.graft', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get('trojan:child')).toBeNull(); // not created under the foreign parent
  });

  it('DENIES moving a FOREIGN node (move victim:data → trojan:home)', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.steal_move', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    // victim:data stays where it was (still resolvable by name; move did not apply).
    expect(tree.get(VICTIM_DATA)).not.toBeNull();
  });

  it('ALLOWS a create entirely within the writer OWN namespace (no false positive)', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.mine', {}, TROJAN_APP);
    expect(res.ok).toBe(true);
    expect(tree.get('trojan:mine')).not.toBeNull(); // created in-namespace
  });

  it('a forged trust:"trusted" stamp does NOT relax the cross-ns gate (still DENIED)', async () => {
    // The cross-ns gate keys off the OWNING COMMAND's effective trust (sandboxed via
    // trust_of), not the caller stamp — so a forged trusted stamp cannot downgrade it.
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.inject', {}, TROJAN_FORGED_TRUSTED);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get('victim:injected')).toBeNull();
  });

  it('a TRUSTED app may write across namespaces (zero regression — gate is sandboxed-only)', async () => {
    // Full-trust apps legitimately seed/maintain other namespaces (system builders,
    // projection blocks). The gate must not touch them.
    const { tree, ops } = wireTrojan('trusted');
    const res = await ops.invoke_command('trojan.inject', {}, TROJAN_APP);
    expect(res.ok).toBe(true);
    expect(tree.get('victim:injected')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// INVARIANT — a sandboxed app has NO reachable path to bare Operations.apply()
// (UH-2 §3.8, task#13), AND apply() is now fail-closed by default (task#10).
// `apply()` re-gates per op. The `core.*` op names make trust_of() blind, so the
// per-op trust used to come from `invoker_ctx.trust` ALONE — and an UNSTAMPED ctx
// fell back to `trusted` (the old fail-OPEN footgun). task#10 FLIPPED that default:
// an unstamped `{invoker:'app'}` apply() now defaults to the strict `sandboxed`
// lane (see the "apply() fail-closed default" describe below), so the footgun is
// closed structurally — full power requires an explicit `trust:'trusted'` opt-in.
// As DEFENSE IN DEPTH this block ALSO pins that an app never holds a reference to
// `apply()`/Operations in the first place: the AppContext surface exposes
// `invoke_command` (the policed door, re-gated at step (3.5)) and by-value `read`,
// but no `apply` and no `Operations`. `apply()`'s only callers are trusted system
// internals (index.ts / launch.ts seed, registry.ts unseed — now all stamped
// `{invoker:'app', trust:'trusted'}`). This test PINS that surface so a future
// refactor cannot quietly expose `apply` to apps.
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

describe('INVARIANT — sandboxed app cannot reach bare Operations.apply()', () => {
  it('the live AppContext exposes invoke_command but NO apply / Operations handle', () => {
    const registry = sandboxedRegistry(); // minimalApp is trust:'sandboxed' (SS3c)
    registry.install(minimalApp());
    const ctx = registry.get_app_context('mini');
    expect(ctx).not.toBeNull();

    const members = allMemberNames(ctx as object);
    // The policed write door IS present...
    expect(members.has('invoke_command')).toBe(true);
    // ...but the bare chokepoint primitive is NOT, and no member is an Operations
    // instance. Uses the SHARED whitelist helper so the in-process and cross-process
    // (AppContextProxy, SS3b) surfaces are pinned by ONE source of truth.
    assertAppContextWhitelist(ctx as object, (v) => v instanceof Operations);
  });

  it('the AppContext write surface is exactly the by-name whitelist (no apply added)', () => {
    // The exact-own-member-set arm of the shared assertion (a future added member fails
    // it and forces a conscious review — catches an `apply`/Operations leak).
    const registry = sandboxedRegistry(); // minimalApp is trust:'sandboxed' (SS3c)
    registry.install(minimalApp());
    const ctx = registry.get_app_context('mini')!;
    expect(new Set(Object.keys(ctx))).toEqual(new Set(APP_CONTEXT_WHITELIST));
  });
});

// ---------------------------------------------------------------------------
// apply() FAIL-CLOSED default (UH-2 §3.8, task#10).
//
// `Operations.apply()` is the system-write primitive door. Its ops carry reserved
// `core.*` names with no owning app, so the engine cannot recover a trust floor from
// the op name — the per-op trust comes from the passed ctx. We flipped the default:
// an `{invoker:'app'}` call with NO explicit trust is gated as `sandboxed` (the strict
// lane), and full power is an explicit `trust:'trusted'` opt-in. These tests pin BOTH
// halves: (a) an explicit trusted system seed keeps full power (writes pinned blocks,
// physically deletes), so the launch/index seed path is unaffected; (b) an unstamped
// app call — the would-be footgun, or a future caller that forgets to stamp — now
// fails CLOSED (the destructive trio is denied, ordinary block:write still applies).
// ---------------------------------------------------------------------------

const APP_NO_TRUST: InvokerContext = { invoker: 'app', identity: 'system' };
const APP_TRUSTED: InvokerContext = { invoker: 'app', trust: 'trusted', identity: 'system' };
const APP_SANDBOXED_STAMP: InvokerContext = { invoker: 'app', trust: 'sandboxed', identity: 'system' };

describe('apply() fail-closed default — unstamped app is gated to the sandboxed lane', () => {
  it('an EXPLICIT trust:"trusted" apply() keeps full power: update vs pinned is ALLOWED', async () => {
    // The trusted system seed path (index.ts / launch.ts now stamp trust:'trusted').
    const { tree, ops } = wire();
    const op: BlockOp = { kind: 'update', target: PINNED_NAME, content_text: 'seeded' };
    const decision = await ops.apply([op], APP_TRUSTED);
    expect(decision.kind).toBe('allow');
    expect(tree.get(PINNED_NAME)?.content_text).toBe('seeded'); // write applied
  });

  it('an EXPLICIT trust:"trusted" apply() may physically delete (full power)', async () => {
    const { tree, ops } = wire();
    const op: BlockOp = { kind: 'delete', target: 'demo:scratch', physical: true };
    const decision = await ops.apply([op], APP_TRUSTED);
    expect(decision.kind).toBe('allow');
    expect(tree.get('demo:scratch')).toBeNull(); // physically removed
  });

  it('an UNSTAMPED app apply() update vs pinned is now DENIED (fail-closed, was fail-open)', async () => {
    const { tree, ops } = wire();
    const op: BlockOp = { kind: 'update', target: PINNED_NAME, content_text: 'tampered' };
    const decision = await ops.apply([op], APP_NO_TRUST);
    expect(decision.kind).toBe('deny');
    expect(tree.get(PINNED_NAME)?.content_text).toBeNull(); // untouched (was content_text:null)
  });

  it('an UNSTAMPED app apply() physical delete is now DENIED (fail-closed)', async () => {
    const { tree, ops } = wire();
    const op: BlockOp = { kind: 'delete', target: 'demo:scratch', physical: true };
    const decision = await ops.apply([op], APP_NO_TRUST);
    expect(decision.kind).toBe('deny');
    expect(tree.get('demo:scratch')).not.toBeNull(); // survives
  });

  it('an UNSTAMPED app apply() ordinary block:write (soft create) still APPLIES (not over-broad)', async () => {
    // The flip must not break legitimate ordinary writes: the sandboxed lane grants
    // block:write, so a soft create under the demo namespace still applies.
    const { tree, ops } = wire();
    const op: BlockOp = {
      kind: 'create',
      parent: 'root:root',
      block: { id: 'demo:fresh', name: 'demo:fresh', children: [], content_text: 'x', content_blob: null },
    };
    const decision = await ops.apply([op], APP_NO_TRUST);
    expect(decision.kind).toBe('allow');
    expect(tree.get('demo:fresh')).not.toBeNull();
  });

  it('an EXPLICITLY stamped trust:"sandboxed" apply() is per-op fail-closed (defense-in-depth backstop)', async () => {
    // Raven condition 1②: even if a FUTURE path mistakenly routes sandboxed work
    // through bare apply() WITH the sandboxed stamp, apply()'s per-op policy.check
    // (operations.ts:302-308, NOT removed by task#10) still gates it — the destructive
    // trio is denied at the apply() floor, independent of the unstamped→sandboxed
    // default flip. This pins that the per-op loop is the real backstop, not the flip.
    const { tree, ops } = wire();
    const pinnedOp: BlockOp = { kind: 'update', target: PINNED_NAME, content_text: 'x' };
    expect((await ops.apply([pinnedOp], APP_SANDBOXED_STAMP)).kind).toBe('deny');
    expect(tree.get(PINNED_NAME)?.content_text).toBeNull(); // pinned untouched

    const hardDelOp: BlockOp = { kind: 'delete', target: 'demo:scratch', physical: true };
    expect((await ops.apply([hardDelOp], APP_SANDBOXED_STAMP)).kind).toBe('deny');
    expect(tree.get('demo:scratch')).not.toBeNull(); // physical delete denied, survives
  });

  it('user / agent invokers are UNCHANGED by the flip (only the unstamped app lane moved)', async () => {
    // The fail-closed default keys on `invoker === 'app' && trust === undefined`; a
    // user apply() is unaffected (user retains its full grants), proving the change is
    // scoped to the app lane and does not perturb other invokers.
    const { tree, ops } = wire();
    const op: BlockOp = { kind: 'update', target: PINNED_NAME, content_text: 'by-user' };
    const decision = await ops.apply([op], { invoker: 'user', identity: 'operator' });
    expect(decision.kind).toBe('allow');
    expect(tree.get(PINNED_NAME)?.content_text).toBe('by-user');
  });
});

// ---------------------------------------------------------------------------
// Credential-name naming seam (task#14) — is_credential_name boundary rule.
//
// THE IN-NAMESPACE seam (the one cross-ns does NOT cover): the prior pattern matched
// only `credentials` / `credentials/` / `credentials.`, so a sandboxed app could write
// a credential-LOOKING block named `app:credentials_new` / `app:credentials2` IN ITS
// OWN namespace and slip past the cred-write deny (task#11). The cross-ns gate (task#12)
// does NOT fire on an own-namespace write — ONLY the tightened is_credential_name can
// stop it. The rule is the BROAD `startsWith('credentials')` (lead-approved fail-closed
// call): a sandboxed app has no legitimate need to write ANY `credentials*` block, and
// operator credential blocks may use arbitrary suffixes (`credentials2`, `credentialsaws`).
// All cases below target `trojan:*` (own namespace) so they isolate the cred-name axis
// from the cross-ns axis. (Trusted lane keeps full credential access — behavior-gate (6)
// above — so no separate trusted regression here.)
// ---------------------------------------------------------------------------

describe('credential naming seam — in-namespace cred-write deny (task#14)', () => {
  it('DENIES creating an OWN-namespace `credentials_new` block (underscore suffix)', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.cred_new', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get('trojan:credentials_new')).toBeNull(); // never created
  });

  it('DENIES updating an OWN-namespace `credentials-bak` block (dash suffix)', async () => {
    const { ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.cred_bak', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
  });

  it('DENIES creating an OWN-namespace `credentials2` block (DIGIT suffix — a boundary-char rule would miss this)', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.cred_two', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get('trojan:credentials2')).toBeNull();
  });

  it('DENIES creating an OWN-namespace `CredentialsX` block (MIXED CASE — rule lowercases first)', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.cred_caps', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get('trojan:CredentialsX')).toBeNull();
  });

  it('still DENIES the bare `:credentials` block (regression — exact name)', async () => {
    // poison_cred targets `trojan:credentials` (TROJAN_CRED) — the canonical credential
    // block. The tightened rule must keep matching it.
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.poison_cred', {}, TROJAN_APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(tree.get(TROJAN_CRED)?.content_text).toBe('original');
  });

  it('ALLOWS an ordinary OWN-namespace non-credential block (`notes`) — rule is not all-encompassing', async () => {
    const { tree, ops } = wireTrojan('sandboxed');
    const res = await ops.invoke_command('trojan.not_cred', {}, TROJAN_APP);
    expect(res.ok).toBe(true);
    expect(tree.get('trojan:notes')).not.toBeNull(); // created — not gated as cred
  });
});
