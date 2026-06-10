/**
 * app/registry.ts — the App framework runtime (impl-render owned).
 *
 * One class, three faces. `AppRegistry` installs/uninstalls BlockApps and ALSO
 * implements the two decoupling-seam interfaces declared in app/types.ts:
 *   - `CommandRegistry` — Operations routes authorized commands through it.
 *   - `BuilderRegistry` — Renderer resolves a block's owner builder + cache_tier
 *     through it.
 * core never imports this file; it imports the interfaces. This breaks the
 * core↔app cycle (see ARCHITECTURE.md "Dependency rules").
 *
 * Authoritative design: ai_com/block-agent-architecture-v3.1.md
 *   §3.1 BlockName namespace · §5 AppManifest/AppContext · §5.3 bootstrap +
 *   collision · §5b trust split · §7 BuilderRegistry · §16 invariants.
 *
 * House style (§0.5): the extension unit is `BlockApp`; satellites stay short
 * (`AppManifest`/`AppContext`/`AppRegistry`). Block-world nouns get the `Block`
 * prefix; actors get role names.
 */

import type {
  Block,
  BlockName,
  BlockOp,
  BlockView,
  CacheTier,
  InvokerContext,
  WakeEvent,
} from '../core/types.js';
import type {
  AppContext,
  AppEvent,
  AppManifest,
  AppRegistry as AppRegistryContract,
  AppTrust,
  Builder,
  BuilderManifest,
  BuilderRegistry,
  CommandManifest,
  CommandRegistry,
  CommandResult,
  InstallResult,
  JsonSchema,
  SystemAgentHandle,
  TokenBudget,
} from './types.js';
import type { ContractDef } from './contracts.js';
import { effectiveTrust, resolveHost } from './host.js';
import type { AppHost } from './app_host.js';
import { InProcessHost } from './in_process_host.js';
import { current_chain_trust } from '../core/taint.js';

// ============================================================================
// Capability ceiling (INV #19 — O(1) set-membership, injected seam)
// ============================================================================

/**
 * Trust level of an App's authorship — drives the capability ceiling. `'trusted'`
 * is the built-in + audited in-process lane (the ceiling is the full capability
 * set; built-ins all pass). `'agent_authored'` is the untrusted cross-process
 * sandbox lane (UH-2, §5b / §3.8): its ceiling EXCLUDES the escalation caps
 * (cred:read_blob / block:delete_physical / block:modify_pinned), so a sandboxed
 * App that declares one is REJECTED at install (no longer report-only).
 */
export type AppTrustLevel = 'trusted' | 'agent_authored';

/**
 * Map a manifest's `AppTrust` (`'trusted'|'sandboxed'`) to the authorship
 * `AppTrustLevel` (`'trusted'|'agent_authored'`) the ceiling reasons about: a
 * `sandboxed` (untrusted, cross-process) App is `agent_authored`; everything else
 * (including an absent trust) is `trusted`. Centralized so the one place that wires
 * the two trust vocabularies together is auditable (UH-2 §3.8).
 */
function ceilingTrustLevel(trust: AppTrust | undefined): AppTrustLevel {
  return effectiveTrust(trust) === 'sandboxed' ? 'agent_authored' : 'trusted';
}

// ============================================================================
// Errors (§5.2 / DR-25)
// ============================================================================

/**
 * Thrown by `set_state` when a state transition breaches the App's
 * `state_schema`: a non-JSON value (function / class instance / Block ref /
 * credential-shaped field) or a value that does not match the declared schema
 * (INVARIANT #14). The runtime treats this as fatal for the App and unloads it.
 */
export class AppStateViolation extends Error {
  constructor(
    message: string,
    readonly app_id: string,
    readonly path: string,
  ) {
    super(`AppStateViolation[${app_id}] at ${path}: ${message}`);
    this.name = 'AppStateViolation';
  }
}

/** Thrown when an App declares an illegal manifest (e.g. owner='agent', INV #4). */
export class AppManifestError extends Error {
  constructor(message: string, readonly app_id: string) {
    super(`AppManifestError[${app_id}]: ${message}`);
    this.name = 'AppManifestError';
  }
}

/**
 * Thrown by install() when an UNTRUSTED (sandboxed / `agent_authored`) App declares
 * a capability outside its ceiling (UH-2 §3.8 — the ceiling is now REAL, not
 * report-only). A trusted App never trips this (its ceiling is the full set); the
 * destructive trio (cred:read_blob / block:delete_physical / block:modify_pinned)
 * is exactly what the sandboxed ceiling excludes and what makes the install fail
 * closed — an untrusted App that asks for escalation does not load at all.
 */
export class AppCapabilityCeilingError extends Error {
  constructor(
    message: string,
    readonly app_id: string,
    /** The declared capability names that fell outside the ceiling. */
    readonly violations: readonly string[],
  ) {
    super(`AppCapabilityCeilingError[${app_id}]: ${message}`);
    this.name = 'AppCapabilityCeilingError';
  }
}

/** Thrown on a dependency cycle in `depends_on` at bootstrap (§7.3 #3). */
export class AppDependencyCycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`App dependency cycle: ${cycle.join(' -> ')}`);
    this.name = 'AppDependencyCycleError';
  }
}

// ============================================================================
// §5.2 / §16 #14 — App state schema validation (the set_state Proxy guard)
// ============================================================================

/**
 * Validate one App-state value against the JSON-serializable allow-list
 * (INVARIANT #14, DR-25). We reject the whole class of escalation backdoors:
 * functions, class instances (anything with a non-plain prototype, e.g. a Block
 * or a credential holder), symbols, bigint. Only string / number / boolean /
 * null / plain array / plain object are allowed, recursively.
 *
 * `state_schema` shape is opaque to the contract (JsonSchema = Record); we apply
 * a structural type guard plus, when the schema declares a `properties` map,
 * a shallow key/required check. The point is to slam the door on non-JSON
 * payloads — full JSON-Schema keyword coverage is out of scope for v3.0.
 */
function assertJsonSerializable(
  value: unknown,
  app_id: string,
  path: string,
  seen: WeakSet<object>,
): void {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return;
  if (t === 'function')
    throw new AppStateViolation('functions are not allowed in App state', app_id, path);
  if (t === 'symbol')
    throw new AppStateViolation('symbols are not allowed in App state', app_id, path);
  if (t === 'bigint')
    throw new AppStateViolation('bigint is not allowed in App state', app_id, path);
  if (t === 'undefined')
    throw new AppStateViolation('undefined is not allowed in App state', app_id, path);

  // From here `value` is an object.
  const obj = value as object;
  if (seen.has(obj))
    throw new AppStateViolation('circular reference in App state', app_id, path);
  seen.add(obj);

  if (Array.isArray(obj)) {
    obj.forEach((el, i) => assertJsonSerializable(el, app_id, `${path}[${i}]`, seen));
    seen.delete(obj);
    return;
  }

  // A plain object has Object.prototype or a null prototype. Anything else is a
  // class instance (Block, Date, Map, a credential holder, …) → reject.
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null)
    throw new AppStateViolation(
      'class instances (Block ref / Date / Map / credential holder / …) are not allowed in App state',
      app_id,
      path,
    );

  for (const [k, v] of Object.entries(obj)) {
    assertJsonSerializable(v, app_id, path === '' ? k : `${path}.${k}`, seen);
  }
  seen.delete(obj);
}

/**
 * Shallow structural check against a JsonSchema's `properties`/`required`, when
 * present. Deliberately lenient: unknown schema keywords are ignored; the
 * heavy lifting is the JSON-serializable guard above. Throws AppStateViolation
 * on a missing required key.
 */
function assertMatchesSchema(
  value: unknown,
  schema: JsonSchema,
  app_id: string,
): void {
  const required = schema['required'];
  if (
    Array.isArray(required) &&
    (typeof value !== 'object' || value === null || Array.isArray(value))
  ) {
    throw new AppStateViolation('state must be an object to satisfy schema', app_id, '');
  }
  if (Array.isArray(required) && typeof value === 'object' && value !== null) {
    const keys = new Set(Object.keys(value as Record<string, unknown>));
    for (const key of required) {
      if (typeof key === 'string' && !keys.has(key))
        throw new AppStateViolation(`missing required state key '${key}'`, app_id, key);
    }
  }
}

// ============================================================================
// Reserved namespaces (owned by the runtime, never assignable to an App)
// ============================================================================

/**
 * App ids the runtime owns and no installed App may occupy. `core` is reserved
 * for Operations' low-level primitives, which pass through PolicyEngine under
 * reserved full-names `core.find` / `core.read` / `core.create` / `core.update`
 * / `core.delete` / `core.move` (impl-core). Commands use a DOT and block names
 * a COLON, so `core.*` (commands) and `core:*` (any blocks) live in the same
 * reserved id. `runtime` is reserved for the runtime's own system blocks (e.g.
 * `runtime:commands_only_feedback`, §3.1) which the runtime writes straight into
 * the tree via `Operations.apply`; a third-party App with id `runtime` would
 * shadow that system namespace. install() auto-renames any App that asks for a
 * reserved id.
 */
const RESERVED_APP_IDS: ReadonlySet<string> = new Set(['core', 'runtime']);

// ============================================================================
// §3.1 — name helpers (namespace split for O(1) owner resolution)
// ============================================================================
//
// Note on BlockName splitting: the owner-builder index here is keyed by the
// EXACT full block name (O(1), INV #3), so the registry never needs to split a
// `<app_id>:<name>` to find an owner. Where an App id must be derived from a
// block name (e.g. the Renderer's per-App config lookup), the split is on the
// FIRST colon — the same convention as impl-core's exported
// BlockTree.split_block_name, so `mcp:srv:tool` → app=`mcp` on both sides.

/** Split a `<app_id>.<command>` command full name at the FIRST dot. */
function splitCommandName(full_name: string): { app_id: string; command: string } {
  const idx = full_name.indexOf('.');
  return idx < 0
    ? { app_id: full_name, command: '' }
    : { app_id: full_name.slice(0, idx), command: full_name.slice(idx + 1) };
}

// ============================================================================
// Internal install record — one live App instance + its registered surface.
// ============================================================================

interface AppInstance {
  /** Final installed id (may differ from manifest.id after a collision rename). */
  readonly id: string;
  readonly manifest: AppManifest;
  /** Live runtime handle handed to builders/commands/lifecycle hooks. */
  readonly ctx: AppContext;
  /**
   * Carrier abstraction owning this App's AppContext (UH-1 AppHost, impl-spec §3.2).
   * For the in-process carrier `host.current_context()` returns this same `ctx`
   * synchronously — so `get_app_context` (and thus the render path) is unchanged.
   * Holding the host here lets `get_app_context` resolve through the carrier without
   * the registry branching on kind; a future child-process carrier (UH-2/SS3) slots
   * in here unchanged. `ctx` is retained as a direct field because in-process
   * install/uninstall/route paths legitimately reference the live instance directly.
   */
  readonly host: AppHost;
  /** Mutable backing store for `ctx.state`. */
  state: unknown;
  /** Built CommandManifests, keyed by bare command name. */
  readonly commands: Map<string, CommandManifest>;
  /** Built BuilderManifests this App owns. */
  readonly builders: BuilderManifest[];
  /** Event subscriptions registered via ctx.on, keyed by topic. */
  readonly subscriptions: Map<string, Array<(e: AppEvent) => void>>;
}

// ============================================================================
// AppRegistry — installer + CommandRegistry + BuilderRegistry (one class)
// ============================================================================

/**
 * One class, three faces. The wave-2 contract gives the registry interfaces
 * distinct, self-describing method names (`resolve_command` /
 * `resolve_builder` / `list_builders`, vs AppRegistry's `list`), so a single
 * class can `implements AppRegistry, CommandRegistry, BuilderRegistry` directly
 * with no collision. core/operations.ts holds it typed as `CommandRegistry`,
 * core/renderer.ts as `BuilderRegistry` — depending only on the INTERFACES,
 * never on this class (the core↔app decoupling seam, §5.3).
 */
export class AppRegistry
  implements AppRegistryContract, CommandRegistry, BuilderRegistry
{
  /** Installed Apps keyed by final installed id. */
  private readonly apps = new Map<string, AppInstance>();

  /**
   * O(1) owner-builder index: block-name app_id prefix → that App's builders by
   * their declared output name. INVARIANT #3: at most one owner per block name.
   */
  private readonly ownerByBlockName = new Map<BlockName, BuilderManifest>();

  /**
   * System builders that belong to NO installed App (R-5 / B1): the runtime's own
   * bookkeeping builder is registered here via `registerSystemBuilder`. Their outputs
   * also live in `ownerByBlockName` (so `resolve_builder` / `tier_of` /
   * `seedProjectionBlocks` see them); this array exists so `list_builders` can include
   * them too (it otherwise enumerates only installed Apps). Insertion order is
   * preserved and appended deterministically after the App builders.
   */
  private readonly systemBuilders: BuilderManifest[] = [];

  /** Per-App config injected into BuildContext.config in place of process.env. */
  private readonly configs = new Map<string, Readonly<Record<string, string>>>();

  /**
   * Contract registry: contract NAME → its `ContractDef` (§3.2). The boot registers
   * the built-in contracts (app/contracts.ts MESSAGE_COUNT / TASK_COUNT) plus any
   * App-declared ones here, so the assemble-time check (R-1) can resolve a
   * `provides.contract` string to the contract's `output_schema` and compare it
   * against the via command's `result_schema`. Keeping this on the registry (not a
   * boot-side param) keeps the registry the single owner of contract derivation
   * (F3). Empty by default → an App that declares no `provides`/`consumes` runs
   * exactly as before (no new warnings), so existing installs are unaffected.
   */
  private readonly contracts = new Map<string, ContractDef>();

  /**
   * Capability ceiling resolver: given a trust level, return the set of capability
   * NAMES that authorship level is allowed to declare on its commands/builders.
   * install() checks every declared capability against this set; a capability
   * outside the ceiling is reported as a warning in InstallResult.warnings (v1 is
   * report-only — it does NOT reject, since built-in apps all pass; the seam is
   * built so the follow-up agent_authored lane can tighten to reject).
   *
   * Injected (like the other registry seams: commandRouter / wakeHook / blockReader),
   * so the engine stays decoupled and the check is O(1) set-membership (INV #19).
   * Unset (undefined) ⇒ no ceiling check at all (current behavior preserved).
   *
   * Return a set that INCLUDES all caps for 'trusted' (built-ins pass); for
   * 'agent_authored' it MUST exclude the escalation caps (e.g. cred:read_blob,
   * block:delete_physical) per §5b.6 — but that path is follow-up, not wired in v1.
   */
  ceiling_resolver?: (trust: AppTrustLevel) => ReadonlySet<string>;

  /** Optional config supplied at construction, keyed by manifest.id. */
  constructor(opts?: { configs?: Record<string, Record<string, string>> }) {
    if (opts?.configs) {
      for (const [id, cfg] of Object.entries(opts.configs)) {
        this.configs.set(id, Object.freeze({ ...cfg }));
      }
    }
  }

  // --------------------------------------------------------------------------
  // AppRegistry contract
  // --------------------------------------------------------------------------

  install(manifest: AppManifest): InstallResult {
    const warnings: string[] = [];

    // §5.3 #4 — namespace collision: the second App that wants id `chat` becomes
    // `chat_2`, `chat_3`, … and we emit a warning. We key collision on the App
    // id (which is also the block-name prefix, §3.1), so a rename keeps every
    // block name unambiguous. A RESERVED id (e.g. `core`, owned by the runtime's
    // low-level primitives `core.find/read/...` per impl-core) is treated as
    // already-taken: no App may occupy it, so it auto-renames away too.
    let installed_id = manifest.id;
    if (this.isTaken(installed_id)) {
      let n = 2;
      while (this.isTaken(`${manifest.id}_${n}`)) n += 1;
      installed_id = `${manifest.id}_${n}`;
      const why = RESERVED_APP_IDS.has(manifest.id)
        ? `App id '${manifest.id}' is reserved for the runtime core`
        : `App id '${manifest.id}' already installed`;
      warnings.push(`${why}; auto-renamed to '${installed_id}'`);
    }

    const instance = this.instantiate(installed_id, manifest, warnings);

    // Capability ceiling check (INV #19 — UH-2 §3.8 made it REAL). We resolve the
    // ceiling against the manifest's ACTUAL authorship trust (not a hardcoded
    // 'trusted'): a `sandboxed` manifest maps to `agent_authored`, whose ceiling
    // excludes the escalation trio. Enforcement is split by trust:
    //   - trusted     → report-only (warnings). Built-in apps' ceiling is the full
    //                   set, so they never even trip a warning; the channel stays
    //                   for an auditable trusted-app cap surface.
    //   - agent_authored (sandboxed) → REJECT: any out-of-ceiling cap throws
    //                   AppCapabilityCeilingError, so an untrusted App that asks for
    //                   escalation does not load at all (fail-closed, §3.8). The
    //                   throw fires BEFORE apps.set/indexBuilders below, so a
    //                   rejected install leaves zero registry/index state behind.
    // Skipped entirely when ceiling_resolver is not injected (current behavior
    // preserved → existing tests unaffected).
    if (this.ceiling_resolver) {
      const level = ceilingTrustLevel(manifest.trust);
      const allowed = this.ceiling_resolver(level);
      const violations: string[] = [];
      for (const cmd of instance.commands.values()) {
        for (const cap of cmd.capabilities ?? []) {
          if (!allowed.has(cap.name)) {
            violations.push(cap.name);
            warnings.push(
              `App '${installed_id}' command '${cmd.name}' declares capability '${cap.name}' outside the ${level} ceiling`,
            );
          }
        }
      }
      for (const builder of instance.builders) {
        for (const cap of builder.capabilities ?? []) {
          if (!allowed.has(cap.name)) {
            violations.push(cap.name);
            warnings.push(
              `App '${installed_id}' builder '${builder.name}' declares capability '${cap.name}' outside the ${level} ceiling`,
            );
          }
        }
      }
      if (level !== 'trusted' && violations.length > 0) {
        throw new AppCapabilityCeilingError(
          `untrusted app declares capability(ies) outside its ceiling: ${[...new Set(violations)].join(', ')}`,
          installed_id,
          violations,
        );
      }
    }

    // Contract PROVIDES checks (R-1 / R-3 / DR-F — all per-manifest, additive). An
    // App that declares no `provides` adds no warnings here, so contract-less
    // installs are byte-for-byte unchanged. We run this AFTER instance.commands is
    // built so a `provides.via` resolves to its CommandManifest.
    this.checkProvides(installed_id, manifest, instance, warnings);

    this.apps.set(installed_id, instance);
    this.indexBuilders(instance);

    void manifest.on_install?.(instance.ctx);

    return { installed_id, warnings };
  }

  /** An id is unavailable if an App holds it OR it is reserved for the core. */
  private isTaken(app_id: string): boolean {
    return this.apps.has(app_id) || RESERVED_APP_IDS.has(app_id);
  }

  /**
   * Three-in-one teardown (hook + index drop + entry removal), RETAINED for
   * non-host callers and backward compatibility. The HotMutator no longer routes
   * through this — it uses the split path `dispose_app()` (hook, via the carrier) +
   * `forget()` (index drop + delete), so teardown crosses the AppHost (impl-spec
   * §3.2/§4) without `dispose()` ever recursing back into `uninstall`. Kept so any
   * existing direct caller (tests, non-carrier flows) sees an unchanged contract.
   */
  uninstall(app_id: string): void {
    if (!this.apps.has(app_id)) return;
    this.runUninstallHook(app_id);
    this.forget(app_id);
  }

  /**
   * Drop an App's registry footprint ONLY — its builder index entries + the install
   * record — WITHOUT running its `on_uninstall` hook. The index half of teardown,
   * split out so the HotMutator can run the hook through the carrier (`dispose_app`
   * → AppHost.dispose) FIRST, then `forget()` here. Separating the two is what makes
   * the carrier path non-recursive: the hook never re-enters an index-dropping path.
   * Single-writer-clean: touches only in-memory registry state, never the tree
   * (projection nodes are the HotMutator's `unseedProjectionBlocks` job). Idempotent
   * on a missing id.
   */
  forget(app_id: string): void {
    const instance = this.apps.get(app_id);
    if (!instance) return;
    for (const builder of instance.builders) {
      for (const out of builder.outputs) {
        if (this.ownerByBlockName.get(out) === builder) this.ownerByBlockName.delete(out);
      }
    }
    this.apps.delete(app_id);
  }

  /**
   * Run an App's graceful teardown THROUGH ITS CARRIER (AppHost.dispose, impl-spec
   * §3.2/§4): for in-process this runs `on_uninstall` via the host's injected
   * hook-only closure; for a child-process carrier (UH-2/SS3) it will additionally
   * terminate the process + reclaim the channel. The HotMutator calls this BEFORE
   * `forget()` so the hook sees a still-indexed app and the index drop is a separate,
   * later step — no `uninstall→dispose→uninstall` recursion. Async because carrier
   * teardown is async. Idempotent on a missing id (no-op).
   */
  async dispose_app(app_id: string): Promise<void> {
    await this.apps.get(app_id)?.host.dispose();
  }

  /**
   * Run ONLY an App's graceful-teardown hook (`on_uninstall`), nothing else — no
   * index drop, no `apps.delete`. This is the single place the hook fires: called by
   * `uninstall()` and (via the host's injected closure) by `AppHost.dispose()`
   * (impl-spec §3.2/§4 teardown). Keeping it hook-ONLY is the safety boundary Atlas
   * flagged: a carrier `dispose()` must NOT recurse into `uninstall()` / `forget()`,
   * or the HotMutator path that routes teardown through `dispose()` would either loop
   * or double-fire the hook. Registry stays single-writer-clean (the hook itself
   * touches neither tree nor index). Idempotent on a missing id; fire-and-forget
   * (`void`) exactly as the prior inline call was.
   */
  private runUninstallHook(app_id: string): void {
    const instance = this.apps.get(app_id);
    if (!instance) return;
    void instance.manifest.on_uninstall?.(instance.ctx);
  }

  list(): AppManifest[] {
    // Deterministic order (by installed id) so callers never depend on Map
    // insertion order.
    return [...this.apps.keys()].sort().map((id) => this.apps.get(id)!.manifest);
  }

  get(app_id: string): AppManifest | null {
    return this.apps.get(app_id)?.manifest ?? null;
  }

  /**
   * The LIVE AppContext for an installed App (the same instance handed to its
   * commands/lifecycle hooks), or null if no such App is installed.
   *
   * This is the seam state-driven render-builders need: a builder like
   * `messages:recent` / `tools:recent` projects from `app_ctx.state`, and after a
   * command mutates that state the Renderer must read the SAME live context to see
   * the change. The Renderer resolves contexts through this accessor (wired at boot
   * as `app_context_provider`), so a context obtained after install — or after any
   * `set_state` — always reflects current state. Returning the live instance (not a
   * copy) is intentional: `ctx.state` is a read-through getter over the App's mutable
   * cell, so the Renderer always sees the latest committed state (builders only READ
   * it; they never mutate, INV #16).
   *
   * UH-1 (impl-spec §3.2): the lookup now resolves through the App's `AppHost` via
   * its SYNCHRONOUS `current_context()` accessor — NOT the async `activate()` — so
   * the render hot path (`app_context_provider`, index.ts:111 / launch.ts:182) and
   * consume-refresh fold (agent_runtime.ts:454) keep their exact synchronous,
   * byte-deterministic (INV #1) timing. For the in-process carrier this returns the
   * SAME live `ctx` instance as before (zero behavior change); a child-process
   * carrier (UH-2/SS3) returns the live proxy iff already active, else null — and a
   * null then means "read the core-side cell" (impl-spec §3.6 pull-from-cache),
   * never "block the render to fork a process". The external signature and
   * return-timing are unchanged.
   */
  get_app_context(app_id: string): AppContext | null {
    return this.apps.get(app_id)?.host.current_context() ?? null;
  }

  // --------------------------------------------------------------------------
  // §5.3 bootstrap — topo-sort by depends_on, cycle-detect, install in order
  // --------------------------------------------------------------------------

  /**
   * Install a batch of manifests respecting `depends_on`. Returns the
   * InstallResult for each in install (topological) order. Throws
   * AppDependencyCycleError on a cycle or AppManifestError on a missing
   * dependency.
   *
   * Contract satisfiability (A3 / §3.3): after the batch derives its
   * `contract → providers` table, every `consumes` whose contract has ZERO
   * providers gets a WARNING appended to that consumer's InstallResult — the
   * additive replacement for the `depends_on` missing-dep ERROR (a missing
   * contract degrades a consumer, it does not abort the boot). A batch with no
   * `consumes` declarations is unaffected (no new warnings).
   */
  bootstrap(manifests: AppManifest[]): InstallResult[] {
    const ordered = topoSort(manifests);
    const table = this.deriveContractTable(ordered);
    const results = ordered.map((m) => this.install(m));
    ordered.forEach((m, i) => {
      for (const { contract, as } of m.consumes ?? []) {
        if ((table.get(contract)?.length ?? 0) === 0) {
          results[i]!.warnings.push(
            `App '${results[i]!.installed_id}' consumes contract '${contract}' (as '${as}') ` +
              `but no installed App provides it; '${as}' will be unset until a provider is added`,
          );
        }
      }
    });
    return results;
  }

  // --------------------------------------------------------------------------
  // Contract model — registration + derived provider table + assemble checks
  // --------------------------------------------------------------------------

  /**
   * Register a `ContractDef` so the assemble-time check can resolve a
   * `provides.contract` / `consumes.contract` NAME to its `output_schema`. The
   * boot calls this for the built-in contracts (app/contracts.ts MESSAGE_COUNT /
   * TASK_COUNT) before bootstrap; an App may register its own. Last write wins for
   * a duplicate name (a redefinition is a manifest decision, not a registry error).
   */
  registerContract(def: ContractDef): void {
    this.contracts.set(def.name, def);
  }

  /** The `ContractDef` for a contract name, or null if none is registered. */
  resolve_contract(name: string): ContractDef | null {
    return this.contracts.get(name) ?? null;
  }

  /**
   * deriveContractTable — scan every manifest's `provides` and build the
   * `contract → [{app_id, via}]` resolution table (A3, §3.3). Multiple providers
   * of the same contract FAN IN (the consumer's `combine` later merges them). No
   * hand-written route table: the table is purely derived from declarations.
   * Deterministic: contracts are visited in manifest order and providers preserve
   * that order, so a given manifest set always yields the same table. `app_id` is
   * the manifest's declared id (collision-renames happen at install; the table is
   * a pre-install derivation over the batch, A3).
   */
  deriveContractTable(
    manifests: AppManifest[],
  ): Map<string, { app_id: string; via: string }[]> {
    const table = new Map<string, { app_id: string; via: string }[]>();
    for (const m of manifests) {
      for (const { contract, via } of m.provides ?? []) {
        const list = table.get(contract) ?? [];
        list.push({ app_id: m.id, via });
        table.set(contract, list);
      }
    }
    return table;
  }

  /**
   * consumers — enumerate every INSTALLED App that declares `consumes`, as
   * `{app_id, consumes}` pairs (R-4 consume-refresh seam). The runtime's
   * render-time `consumeRefresh()` walks this list: for each consumer it resolves
   * each `{contract, as}` (`resolve_contract` → ContractDef.output_schema/combine),
   * finds the providers (`deriveContractTable` over `list()`), pulls each via
   * `Operations.invoke_query`, validates + combines, and folds the merged value
   * into `state[as]` via `get_app_context(app_id).set_state` (CM-9).
   *
   * `app_id` is the INSTALLED id (post collision-rename), so it is the key
   * `get_app_context` expects — NOT the raw manifest id. Apps with no `consumes`
   * are omitted (an empty result ⇒ consume-refresh is a no-op, so a contract-less
   * boot is unaffected). Deterministic order (by installed id, like `list()`), and
   * each `consumes` array is a fresh copy so a caller can never mutate the live
   * manifest. The registry stays the single owner of contract derivation (F3).
   */
  consumers(): { app_id: string; consumes: { contract: string; as: string }[] }[] {
    const out: { app_id: string; consumes: { contract: string; as: string }[] }[] = [];
    for (const id of [...this.apps.keys()].sort()) {
      const consumes = this.apps.get(id)!.manifest.consumes;
      if (consumes && consumes.length > 0) {
        out.push({ app_id: id, consumes: consumes.map((c) => ({ ...c })) });
      }
    }
    return out;
  }

  /**
   * providers_of — resolve a contract NAME to its `[{app_id, via}]` provider list
   * over the CURRENTLY-INSTALLED Apps (R-4 consume-refresh seam). This is the
   * cohesive twin of `consumers()`: it derives the table from the live install set
   * (`list()`) via `deriveContractTable` and returns the one contract's entry, so a
   * caller never has to assemble the manifest list or hold the whole table. The
   * registry stays the single owner of contract derivation (F3).
   *
   * `app_id` is the INSTALLED id (we read each install record's `id`, NOT the raw
   * `manifest.id` — those differ after a collision rename, and only the installed
   * id is routable). It is exactly the key `resolve_command` / `route` /
   * `invoke_query` (`${app_id}.${via}`) expect; deriving via `list()` +
   * `deriveContractTable` would instead emit the pre-rename `manifest.id` and break
   * a renamed provider. `via` is the provider's bare command name. Deterministic
   * order (by installed id, like `consumers()`). An unprovided contract yields `[]`
   * (consume-refresh then `combine`s an empty fan-in: `sum`→0, `list`→[], `first`→
   * downgrade — the caller decides).
   */
  providers_of(contract: string): { app_id: string; via: string }[] {
    const out: { app_id: string; via: string }[] = [];
    for (const id of [...this.apps.keys()].sort()) {
      for (const { contract: c, via } of this.apps.get(id)!.manifest.provides ?? []) {
        if (c === contract) out.push({ app_id: id, via });
      }
    }
    return out;
  }

  /**
   * Per-manifest `provides` validation (R-1 / R-3 / DR-F). All findings are
   * WARNINGS appended to the install's InstallResult (report-only — a contract
   * declaration problem degrades the binding, it does not abort the install). Three
   * checks per `provides` entry:
   *   - R-3 (readonly mechanism): the `via` command MUST be `readonly === true`
   *     (consume-refresh pulls it via Operations.invoke_query, which never writes;
   *     a non-readonly via is a manifest bug — its body might mutate).
   *   - R-1 (declaration-vs-declaration type check): the contract's `output_schema`
   *     must be shape-compatible with the via command's `result_schema`. Minimal
   *     form per the briefing: their `type` fields must be equal. (We compare the
   *     two SCHEMAS, not a value vs a schema — validateAgainstSchema is value-vs-
   *     schema and is used at RUNTIME by consume-refresh, not here.)
   *   - DR-F (tool_catalog footgun): if the via command is agent-visible
   *     (allowed_invokers absent or includes 'agent'), warn — a contract provider
   *     surfacing in the agent's tool catalog is a footgun (the agent could call a
   *     bookkeeping query directly). We only warn; the real exclusion is the
   *     command's own allowed_invokers, which the runtime honors.
   */
  private checkProvides(
    installed_id: string,
    manifest: AppManifest,
    instance: AppInstance,
    warnings: string[],
  ): void {
    for (const { contract, via } of manifest.provides ?? []) {
      const { command } = splitCommandName(via);
      // `via` is a bare `<command>` within this App; resolve it in this instance.
      const cmd = instance.commands.get(via) ?? instance.commands.get(command);
      if (!cmd) {
        warnings.push(
          `App '${installed_id}' provides contract '${contract}' via unknown command '${via}'`,
        );
        continue;
      }

      // R-3 — the via command must be a pure read (readonly mechanism).
      if (cmd.readonly !== true) {
        warnings.push(
          `App '${installed_id}' provides contract '${contract}' via non-readonly command '${via}' ` +
            `(a contract via command must be readonly so consume-refresh cannot write the tree, R-3)`,
        );
      }

      // R-1 — declaration-vs-declaration type check (output_schema ⊨ result_schema).
      // Needs the contract's ContractDef (registered via registerContract). An
      // UNREGISTERED contract name is a "references an unknown contract" warning —
      // report-only, same severity as missing-provider; the type check is then
      // skipped (no def to compare against), but the reference is still flagged.
      const def = this.contracts.get(contract);
      if (!def) {
        warnings.push(
          `App '${installed_id}' provides unknown contract '${contract}' via '${via}' ` +
            `(no ContractDef registered; the output⊨result type check is skipped, R-1)`,
        );
      } else {
        const outType = schemaType(def.output_schema);
        const resType = schemaType(cmd.result_schema);
        if (cmd.result_schema === undefined) {
          warnings.push(
            `App '${installed_id}' provides contract '${contract}' via '${via}' but that command ` +
              `declares no result_schema (cannot verify it returns the contract's ${describeType(outType)}, R-1)`,
          );
        } else if (outType !== resType) {
          warnings.push(
            `App '${installed_id}' provides contract '${contract}' via '${via}': the contract's ` +
              `output_schema type ${describeType(outType)} != the command's result_schema type ` +
              `${describeType(resType)} (declaration-vs-declaration mismatch, R-1)`,
          );
        }
      }

      // DR-F — tool_catalog footgun: an agent-visible via command.
      const invokers = cmd.allowed_invokers;
      const agentVisible = invokers === undefined || invokers.includes('agent');
      if (agentVisible) {
        warnings.push(
          `App '${installed_id}' provides contract '${contract}' via agent-visible command '${via}' ` +
            `(allowed_invokers ${invokers ? `includes 'agent'` : 'is unset'}); it will appear in the ` +
            `agent tool catalog (DR-F footgun) — restrict allowed_invokers if the agent should not call it`,
        );
      }
    }
  }

  // --------------------------------------------------------------------------
  // Projection-block seeding (namespace-root seeding follow-up — see below)
  // --------------------------------------------------------------------------

  /**
   * Seed each installed App's projection block(s) into the tree so the Renderer
   * renders them from the very first turn.
   *
   * WHY this exists: the Renderer renders a block's owner builder ONLY for block
   * names that already exist as NODES in the tree (it walks `snapshot.root`'s
   * children — see core/renderer.ts `collect`). The standard apps declare their
   * output blocks via `builder.outputs` but never CREATE those nodes themselves, and
   * `AppRegistry` deliberately never touches the tree (single-writer is core/block.ts).
   * So on an empty-tree boot the agent's first prompt is EMPTY — even the pinned
   * `agent_identity:identity` (its identity + operating constraints) does not render
   * until some command happens to create a block. That is a functional gap, not a
   * cosmetic one (the agent has no system context turn 1). This is the
   * "namespace-root seeding" follow-up flagged in ARCHITECTURE.md "Wiring order".
   *
   * MECHANISM (deliberately minimal + invariant-safe): for every registered builder
   * output name (`ownerByBlockName`, the apps' OWN declared outputs) that is not yet
   * in the tree, create a deterministic EMPTY placeholder node under `parent`
   * (default `core:root`, the empty-tree root). The placeholder's content is
   * irrelevant — on each render the owner builder regenerates the block from
   * `app_ctx.state` (the live-AppContext seam), so:
   *   - byte-identical (INV #1) holds: identical state → identical builder output;
   *   - the chokepoint is NOT bypassed: writes go through the injected `apply`, which
   *     the boot wires to `Operations.apply(ops, {invoker:'app'})` — PolicyEngine
   *     still runs (§9.1, no bypass), exactly as the runtime seeds its own
   *     bookkeeping blocks;
   *   - owner stays `system`/`tool`/app-owner (never `agent`, INV #4) — the seed is
   *     install-time infrastructure, not an agent action.
   *
   * Called by the boot AFTER Operations exists (the create must flow through it), so
   * it is a registry method the boot invokes — not done inside `install()` (where no
   * Operations exists yet in the canonical wiring order). `has` lets the boot skip a
   * name already present (idempotent across restarts that recovered blocks).
   *
   * @param has   predicate: is a block with this name already live in the tree?
   * @param apply applies the create ops through the chokepoint (invoker=app).
   * @param parent the node to attach placeholders under (default the empty-tree root).
   * @returns the block names actually seeded (for boot logging / tests).
   */
  async seedProjectionBlocks(
    has: (name: BlockName) => boolean,
    apply: (ops: BlockOp[]) => Promise<unknown>,
    parent: BlockName = 'core:root',
  ): Promise<BlockName[]> {
    // Deterministic order (sorted block name) so seeding is reproducible.
    const names = [...this.ownerByBlockName.keys()].filter((n) => !has(n)).sort();
    const ops: BlockOp[] = names.map((name) => ({
      kind: 'create',
      parent,
      block: {
        // Content-addressed id off the name → deterministic (no random UUID, INV #16).
        id: `seed-${name}`,
        name,
        children: [],
        content_text: null,
        content_blob: null,
      },
    }));
    if (ops.length > 0) await apply(ops);
    return names;
  }

  /**
   * Inverse of seedProjectionBlocks: remove the projection-block tree nodes a
   * given (about-to-be-uninstalled) App owns. The registry stays single-writer-
   * clean — it NEVER touches the tree directly; it computes the block names to
   * delete from the App's builder outputs and emits them through the injected
   * `apply`, exactly as seedProjectionBlocks emits its create ops (so the delete
   * flows through Operations.apply({invoker:'app'}) and re-enters PolicyEngine —
   * no bypass, §9.1).
   *
   * CALL ORDER (hot-uninstall, orchestrated by the CLI HotMutator, §5): call this
   * BEFORE registry.uninstall(app_id) — while the App's builders are still indexed
   * — so the names are resolvable from the registry; then uninstall() drops the
   * index + runs on_uninstall.
   *
   * @param app_id  the App whose owned projection-block names should be removed.
   * @param has     predicate: is a block with this name currently live in the tree?
   *                (skip names not present → idempotent across repeats / partial state).
   * @param apply   applies the delete ops through the chokepoint (invoker=app).
   *                Soft delete (BlockOp.delete WITHOUT physical) — INV #5: the node
   *                is archived, not physically erased; this is install-time infra
   *                teardown, not a destructive purge.
   * @returns the block names actually deleted (for HotMutator logging / tests).
   */
  async unseedProjectionBlocks(
    app_id: string,
    has: (name: BlockName) => boolean,
    apply: (ops: BlockOp[]) => Promise<unknown>,
  ): Promise<BlockName[]> {
    const instance = this.apps.get(app_id);
    if (!instance) return []; // already uninstalled → idempotent, no names

    // Collect all output names owned by this app's builders. Sort for determinism.
    const ownedNames: BlockName[] = [];
    for (const builder of instance.builders) {
      for (const out of builder.outputs) {
        ownedNames.push(out);
      }
    }
    ownedNames.sort();

    // Only emit delete ops for names that are currently live in the tree (idempotent).
    const toDelete = ownedNames.filter((n) => has(n));
    const ops: BlockOp[] = toDelete.map((name) => ({
      kind: 'delete',
      target: name,
      // physical omitted (undefined) → soft delete / archival (INV #5).
    }));
    if (ops.length > 0) await apply(ops);
    return toDelete;
  }

  // --------------------------------------------------------------------------
  // CommandRegistry (the core↔app decoupling seam, §5.3)
  // --------------------------------------------------------------------------

  /**
   * Look up a command's manifest by full name (`<app_id>.<command>`). Returns
   * the manifest so PolicyEngine can read its declared capabilities BEFORE the
   * call is routed; null if unknown.
   */
  resolve_command(full_name: string): CommandManifest | null {
    const { app_id, command } = splitCommandName(full_name);
    return this.apps.get(app_id)?.commands.get(command) ?? null;
  }

  /**
   * Resolve the AUTHORED trust of the App that owns a command (UH-2 §3.8). The
   * PolicyEngine consults this (via the injected `trust_resolver`) so the
   * sandboxed/full-trust lane is keyed off the App's OWN `manifest.trust` — the
   * authoritative floor — rather than off whether a caller remembered to stamp
   * `InvokerContext.trust`. That makes the ceiling fail-closed: an untrusted App is
   * gated even if the stamp is forgotten or forged. Returns the owning App's `trust`
   * (or `undefined` when the App declared none, or the command is unknown — both
   * mean "no sandboxed floor from the registry", and the engine treats undefined as
   * `'trusted'`). Pure + O(1) (a map lookup), keeping the engine IO-free (INV #19).
   */
  trust_of(full_name: string): AppTrust | undefined {
    const { app_id } = splitCommandName(full_name);
    return this.apps.get(app_id)?.manifest.trust;
  }

  /**
   * Execute an already-authorized command. We assume the PolicyEngine inside
   * Operations.invoke_command has already allowed this call — route does NOT
   * re-check policy and does NOT touch the BlockTree. It runs the App's command
   * against its AppContext and returns the CommandResult (ops + data);
   * Operations is the single writer that applies `ops` to the tree.
   */
  async route(
    full_name: string,
    args: unknown,
    invoker: InvokerContext,
  ): Promise<CommandResult> {
    const { app_id, command } = splitCommandName(full_name);
    const instance = this.apps.get(app_id);
    if (!instance)
      return { ok: false, error: `unknown App '${app_id}' for command '${full_name}'` };
    // Carrier-polymorphic (UH-2/SS3b): delegate to the App's AppHost so the registry
    // NEVER branches on host kind. InProcessHost runs `manifest.invoke` locally
    // (byte-identical to the prior inline path); ChildProcessHost frames the command to
    // the child. route stays thin: it does not applyOps and does not re-policy (that is
    // Operations' job, INV#11).
    return instance.host.route_command(command, args, invoker);
  }

  // --------------------------------------------------------------------------
  // BuilderRegistry (consumed by Renderer, §7)
  // --------------------------------------------------------------------------

  /**
   * Resolve the owner builder for a block name. O(1): the name's `<app_id>:`
   * prefix names the owning App (§3.1) and we maintain an exact-name → builder
   * index. null if no builder owns the name.
   */
  resolve_builder(block_name: BlockName): BuilderManifest | null {
    return this.ownerByBlockName.get(block_name) ?? null;
  }

  tier_of(block_name: BlockName): CacheTier | null {
    return this.ownerByBlockName.get(block_name)?.cache_tier ?? null;
  }

  /**
   * All registered builders: installed-App builders (deterministically ordered by
   * app_id then declared order) followed by system builders (R-5 / B1) in
   * registration order. System builders own no App so they cannot be enumerated via
   * `this.apps`; they are appended last so existing App-only ordering is unchanged.
   */
  list_builders(): BuilderManifest[] {
    const all: BuilderManifest[] = [];
    for (const id of [...this.apps.keys()].sort()) {
      all.push(...this.apps.get(id)!.builders);
    }
    all.push(...this.systemBuilders);
    return all;
  }

  /**
   * registerSystemBuilder (R-5 / B1) — register a builder that belongs to NO installed
   * App. The runtime's bookkeeping builder (a closure over its `pending_feedback` /
   * `recent_errors` state) is registered here AFTER the runtime is constructed (CM-5),
   * so that `resolve_builder` / `tier_of` / `list_builders` hit it and
   * `seedProjectionBlocks` (which reads `ownerByBlockName`) seeds its output names.
   *
   * The registry stays the SINGLE owner of `ownerByBlockName` (F3): system builders go
   * through the same INV #4 (owner≠'agent') guard as App builders and the same INV #3
   * (single owner per block name) check. A name already owned by an installed App or a
   * previously registered system builder is a wiring bug → throw. Idempotent only for
   * the exact same builder instance re-registering its own names (no-op), so a boot
   * that runs twice in one process does not falsely trip INV #3.
   */
  registerSystemBuilder(builder: BuilderManifest): void {
    // INV #4 (runtime arm): owner must be system/plugin/tool, never 'agent'. Reuse
    // the same guard App builders pass; 'system:runtime' labels the synthetic owner.
    this.assertLegalBuilder('system:runtime', builder);
    // INV #3: claim each output name; reject a clash with a different owner.
    for (const out of builder.outputs) {
      const existing = this.ownerByBlockName.get(out);
      if (existing && existing !== builder)
        throw new AppManifestError(
          `block name '${out}' already owned by builder '${existing.name}' (INV #3)`,
          'system:runtime',
        );
      this.ownerByBlockName.set(out, builder);
    }
    if (!this.systemBuilders.includes(builder)) this.systemBuilders.push(builder);
  }

  // --------------------------------------------------------------------------
  // Construction helpers
  // --------------------------------------------------------------------------

  private instantiate(
    installed_id: string,
    manifest: AppManifest,
    warnings: string[],
  ): AppInstance {
    const subscriptions = new Map<string, Array<(e: AppEvent) => void>>();
    const commands = new Map<string, CommandManifest>();
    const builders: BuilderManifest[] = [];

    // Mutable state cell, validated once at install (initial_state must pass too).
    assertJsonSerializable(manifest.initial_state, installed_id, '', new WeakSet());
    assertMatchesSchema(manifest.initial_state, manifest.state_schema, installed_id);
    const cell: { state: unknown } = { state: manifest.initial_state };

    const ctx = this.makeContext(installed_id, manifest, cell, commands, builders, subscriptions);

    // Build commands from their factories against the initial state.
    for (const factory of manifest.commands) {
      const cmd = factory(cell.state);
      if (commands.has(cmd.name))
        warnings.push(`App '${installed_id}' declares duplicate command '${cmd.name}'`);
      commands.set(cmd.name, cmd);
    }

    // Build builders; enforce INV #4 (owner='agent' illegal) at runtime, and the
    // single-owner-per-name invariant (#3) is enforced later in indexBuilders.
    for (const factory of manifest.builders) {
      const builder = factory(cell.state);
      this.assertLegalBuilder(installed_id, builder);
      builders.push(builder);
    }

    // UH-1 carrier (impl-spec §3.2): wrap the live ctx in an in-process AppHost. The
    // dispose hook is the HOOK-ONLY runner (never `uninstall`) so a future teardown
    // path through `host.dispose()` cannot recurse into `uninstall`. The closures
    // capture the id and resolve the instance lazily, so there is no construction-order
    // dependency on the not-yet-returned instance.
    //
    // run_command is the in-process `route_command` body — the SAME `manifest.invoke`
    // path `route` used inline before (byte-identical): look up the command, run its
    // handler against this app's live ctx, wrap thrown errors. `route` now delegates
    // here polymorphically (no host-kind branch).
    const run_command = async (
      command: string,
      args: unknown,
      invoker: InvokerContext,
    ): Promise<CommandResult> => {
      const cmd = commands.get(command);
      if (!cmd) return { ok: false, error: `unknown command '${installed_id}.${command}'` };
      try {
        return await cmd.invoke(args, ctx, invoker);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };
    // UH-2/SS3c carrier SELECTION (impl-spec §3.1/§3.2): resolveHost derives the carrier
    // from the manifest's trust/host (host.ts enforces the security invariant — a
    // sandboxed app can never resolve in-process). trusted → InProcessHost (above);
    // child-process → the injected child_host_factory builds a ChildProcessHost with the
    // real HostDeps. The factory is late-injected by the launcher (it holds Operations /
    // taint / the cell writer — registry must NOT, to keep core↔app decoupled).
    //
    // FAIL-CLOSED (security invariant): if a child-process app is installed but no
    // factory was injected, we THROW — never silently fall back to in-process (that
    // would run untrusted code in the trusted domain, defeating resolveHost). A boot
    // that installs a sandboxed app MUST wire the factory.
    const kind = resolveHost(manifest);
    let host: AppHost;
    if (kind === 'in-process') {
      host = new InProcessHost(
        installed_id,
        ctx,
        () => this.runUninstallHook(installed_id),
        run_command,
      );
    } else {
      if (!this.child_host_factory) {
        throw new AppManifestError(
          `app '${installed_id}' resolves to host '${kind}' but no child_host_factory is ` +
            `injected — cannot host an untrusted app in-process (fail-closed). Wire ` +
            `registry.child_host_factory at boot before installing sandboxed apps.`,
          installed_id,
        );
      }
      // The factory builds the carrier AppHost. PRODUCTION (launch boot) builds a real
      // ChildProcessHost (ignoring `in_process_parts`). A TEST factory (test/_support)
      // builds an InProcessHost from `in_process_parts` to exercise the policy/taint
      // ENGINE against a sandboxed manifest in-process — TEST-ONLY (no production path
      // assigns such a factory). The factory is NEVER reachable from app code.
      host = this.child_host_factory(installed_id, manifest, {
        ctx,
        run_uninstall: () => this.runUninstallHook(installed_id),
        run_command,
      });
    }

    return {
      id: installed_id,
      manifest,
      ctx,
      host,
      state: cell.state,
      commands,
      builders,
      subscriptions,
    };
  }

  /**
   * INVARIANT #4 (runtime arm): owner='agent' is illegal even though the type
   * union already forbids it — a third-party manifest crossing an untyped
   * boundary could still carry it, so we reject at runtime too.
   */
  private assertLegalBuilder(app_id: string, builder: Builder): void {
    const owner = builder.owner as string;
    if (owner === 'agent')
      throw new AppManifestError(
        `builder '${builder.name}' has illegal owner 'agent' (INV #4)`,
        app_id,
      );
    if (owner !== 'system' && owner !== 'plugin' && owner !== 'tool')
      throw new AppManifestError(
        `builder '${builder.name}' has unknown owner '${owner}'`,
        app_id,
      );
  }

  /**
   * Index this App's builders by their declared output block names, enforcing
   * INVARIANT #3 (at most one owner builder per name). A clash across two Apps
   * is impossible by namespace (§3.1); a clash WITHIN an App's outputs is a
   * manifest bug → throw.
   */
  private indexBuilders(instance: AppInstance): void {
    for (const builder of instance.builders) {
      for (const out of builder.outputs) {
        const existing = this.ownerByBlockName.get(out);
        if (existing && existing !== builder)
          throw new AppManifestError(
            `block name '${out}' already owned by builder '${existing.name}' (INV #3)`,
            instance.id,
          );
        this.ownerByBlockName.set(out, builder);
      }
    }
  }

  /**
   * Build the AppContext handed to commands/builders/lifecycle hooks. `state`
   * is read-through to the mutable cell; `set_state` runs the updater, validates
   * the result against state_schema via the JSON-serializable guard (INV #14),
   * and only then commits. It does NOT pass PolicyEngine (INV #10).
   */
  private makeContext(
    app_id: string,
    manifest: AppManifest,
    cell: { state: unknown },
    commands: Map<string, CommandManifest>,
    builders: BuilderManifest[],
    subscriptions: Map<string, Array<(e: AppEvent) => void>>,
  ): AppContext {
    const registry = this;
    return {
      app_id,

      get state() {
        return cell.state;
      },

      set_state(updater: (s: unknown) => unknown): void {
        const next = updater(cell.state);
        // INV #14: validate BEFORE commit so a rejected transition leaves state
        // untouched. We deep-check JSON-serializability (no fn/cred/Block/class)
        // plus a shallow schema required-key check.
        assertJsonSerializable(next, app_id, '', new WeakSet());
        assertMatchesSchema(next, manifest.state_schema, app_id);
        cell.state = next;
      },

      list_commands(): CommandManifest[] {
        return [...commands.values()];
      },
      list_builders(): BuilderManifest[] {
        return [...builders];
      },
      list_blocks(): Block[] {
        // v3.0: AppRegistry does not hold the BlockTree (single-writer lives in
        // core/block.ts). The runtime wires a tree reader in when it constructs
        // the registry; until then this is an empty projection.
        return registry.blockReader ? registry.blockReader(app_id) : [];
      },

      async invoke_command(full_name: string, args: unknown): Promise<CommandResult> {
        // Cross-App call re-enters the command path. In v3.0 the registry routes
        // directly; the runtime swaps in an Operations-backed router (which adds
        // PolicyEngine, INV #11) by setting `commandRouter`.
        //
        // Sandbox-taint propagation (SS3): inherit the CURRENT CHAIN trust and stamp it
        // onto the nested call's ctx. If this app (or any ancestor in the chain) is
        // sandboxed, the chain trust is `sandboxed`, so the engine's `effective_trust`
        // takes the stricter of the target's resolved trust and this inherited floor —
        // a nested call to a TRUSTED app still runs under the sandboxed ceiling, closing
        // the "trusted intermediary launders the taint" hole (registry.ts call site).
        //
        // DETACH-FAIL-CLOSED (team-lead ruling A: ALS + fail-closed, scope = app lane):
        // a chain store is absent when this call is dispatched from OUTSIDE the ALS
        // context — a genuine top-level entry with no enclosing `run_in_chain` (e.g. a
        // system-agent / wake path), or (defense-in-depth) a hypothetical context
        // escape. Treating absence as trusted would let a sandboxed-chain intermediary
        // launder the taint, so a NO-CHAIN call here is stamped `sandboxed` (strictest).
        //   Scope is exactly the APP lane: this site is unconditionally `invoker:'app'`,
        // so the fail-closed default never touches a top-level `agent`/`user` call (those
        // are chain roots and resolve normally — they don't route through here at all).
        //   tighten-only holds: the engine takes the STRICTER of target trust and this
        // stamp, so even a forged `trusted` cannot relax it. Accepted cost (team-lead):
        // a trusted handler that wants a privileged nested call must `await` it (stay in
        // the ALS chain = normal trusted); a DETACHED privileged call is a code smell and
        // is correctly fail-closed — so the "trusted-chain zero-regression" guarantee is
        // specifically for AWAITED chains. (VERIFIED: ALS propagates across
        // setTimeout/microtask/Promise.then — those do NOT escape; absence is real
        // top-level only.) Consume-refresh `via` reached chain-less also fail-closes to
        // sandboxed but is harmless: `via` is asserted readonly + pulled via invoke_query
        // (ops dropped), so no op / no dangerous cap → the sandboxed ceiling never bites.
        const ctx: InvokerContext = {
          invoker: 'app',
          identity: app_id,
          trust: current_chain_trust() ?? 'sandboxed',
        };
        if (registry.commandRouter) return registry.commandRouter(full_name, args, ctx);
        return registry.route(full_name, args, ctx);
      },

      async read(_blockname: BlockName): Promise<Block[] | BlockView[]> {
        // INV #22: read returns COPIES across an App boundary. Wired by the
        // runtime alongside the BlockTree; empty until then.
        return registry.blockReadCopies ? registry.blockReadCopies(_blockname) : [];
      },

      on(event: string, handler: (e: AppEvent) => void): void {
        const list = subscriptions.get(event) ?? [];
        list.push(handler);
        subscriptions.set(event, list);
      },
      emit(event: string, payload: unknown): void {
        // INV #22: emit is fire-and-forget; handlers must not add blocking gates.
        registry.dispatchEvent(event, { topic: event, payload });
      },

      spawn_system_agent(_spec: {
        goal: string;
        trigger: 'post_turn' | 'on_idle' | 'on_event';
        budget: TokenBudget;
      }): SystemAgentHandle {
        // v3.0 stub: no concrete App needs a background agent yet (framework
        // only — see ARCHITECTURE.md scope). Returns an inert handle so call
        // sites compile and a future runtime can swap in a real spawner.
        return {
          id: `${app_id}:system_agent:${manifest.id}`,
          stop() {
            /* no-op in v3.0 */
          },
        };
      },

      wake(event: WakeEvent): void {
        // §8.2 messages-wake seam. The runtime injects `wakeHook` at boot; until
        // then this is inert (an App installed without a running runtime — e.g. a
        // builder-only test — does not throw). The App calls this AFTER it has
        // durably recorded the triggering fact (e.g. appended to inbox.jsonl).
        registry.wakeHook?.(event);
      },
    };
  }

  /** Deliver an emitted event to every App that subscribed to its topic. */
  private dispatchEvent(topic: string, event: AppEvent): void {
    for (const id of [...this.apps.keys()].sort()) {
      const handlers = this.apps.get(id)!.subscriptions.get(topic);
      if (!handlers) continue;
      for (const h of handlers) {
        try {
          h(event);
        } catch {
          /* fire-and-forget: a faulty subscriber never blocks the emitter */
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Runtime wiring seams (set by the runtime; optional in v3.0)
  // --------------------------------------------------------------------------

  /** Routes cross-App invoke_command through Operations (adds PolicyEngine). */
  commandRouter?: (
    full_name: string,
    args: unknown,
    invoker: InvokerContext,
  ) => Promise<CommandResult>;

  /** Returns the blocks under an App's namespace (read from the BlockTree). */
  blockReader?: (app_id: string) => Block[];

  /** Returns COPIES of blocks for a name (INV #22), for cross-App read. */
  blockReadCopies?: (blockname: BlockName) => Block[];

  /**
   * Wakes the AgentRuntime (§8.2). The runtime sets this to a thunk over its own
   * `on_wake` at boot; backs `AppContext.wake`. Until set, `ctx.wake` is inert.
   */
  wakeHook?: (event: WakeEvent) => void;

  /**
   * Builds the carrier AppHost for a child-process (resolveHost-derived) app (UH-2/SS3c).
   * Late-injected (same pattern as commandRouter/wakeHook); `instantiate` calls it when
   * `resolveHost` yields `'child-process'`, FAIL-CLOSED throwing if it is absent.
   *
   * Two — and ONLY two — assigners (footgun guard, team-lead / Raven SS3c hard-gate):
   *   - PRODUCTION launch boot → builds a REAL `ChildProcessHost` with the live
   *     `HostDeps` (Operations / taint / authoritative cell writer); it IGNORES
   *     `in_process_parts`. This is the only production path for a sandboxed app.
   *   - TEST `test/_support/inProcessChildFactory` → builds an `InProcessHost` FROM
   *     `in_process_parts`, so an engine test (policy row / taint chain) can run a
   *     sandboxed MANIFEST in-process without forking. TEST-ONLY.
   * The two are NEVER mixed, and this field is NEVER reachable from app code (apps hold
   * an AppContext, not the registry) — so "sandboxed runs in-process" is possible ONLY
   * via an explicitly-injected test factory, never in production.
   *
   * `in_process_parts` carries the registry-built pieces an InProcessHost needs (live
   * ctx + hook-only uninstall + local command runner) so a TEST factory can build one;
   * a production ChildProcessHost factory ignores them.
   */
  child_host_factory?: (
    app_id: string,
    manifest: AppManifest,
    in_process_parts: {
      ctx: AppContext;
      run_uninstall: () => void;
      run_command: (
        command: string,
        args: unknown,
        invoker: InvokerContext,
      ) => Promise<CommandResult>;
    },
  ) => AppHost;
}

// ============================================================================
// Contract schema-shape helpers (R-1 declaration-vs-declaration comparison)
// ============================================================================

/**
 * The `type` keyword of a JsonSchema, or undefined when absent / not a string.
 * Used by the assemble-time check to compare a contract's `output_schema` with a
 * via command's `result_schema` at the minimal "same scalar/kind" granularity the
 * briefing allows (full schema-vs-schema subsumption is out of scope here).
 */
function schemaType(schema: JsonSchema | undefined): string | undefined {
  const t = schema?.['type'];
  return typeof t === 'string' ? t : undefined;
}

/** A readable label for a schema type in a warning (handles the typeless case). */
function describeType(t: string | undefined): string {
  return t === undefined ? '(none)' : `'${t}'`;
}

// ============================================================================
// §5.3 — topological sort over depends_on (Kahn's algorithm + cycle report)
// ============================================================================

function topoSort(manifests: AppManifest[]): AppManifest[] {
  const byId = new Map<string, AppManifest>();
  for (const m of manifests) byId.set(m.id, m);

  // Deterministic node order so a given input set always installs identically.
  const ids = [...byId.keys()].sort();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const id of ids) {
    for (const dep of byId.get(id)!.depends_on) {
      if (!byId.has(dep))
        throw new AppManifestError(`missing dependency '${dep}'`, id);
      indegree.set(id, indegree.get(id)! + 1);
      dependents.get(dep)!.push(id);
    }
  }

  // Ready queue kept sorted for determinism.
  const ready = ids.filter((id) => indegree.get(id) === 0).sort();
  const ordered: AppManifest[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const dep of dependents.get(id)!.sort()) {
      indegree.set(dep, indegree.get(dep)! - 1);
      if (indegree.get(dep) === 0) {
        ready.push(dep);
        ready.sort();
      }
    }
  }

  if (ordered.length !== ids.length) {
    // Recover a representative cycle for the error message.
    const remaining = ids.filter((id) => indegree.get(id)! > 0);
    throw new AppDependencyCycleError(traceCycle(remaining, byId));
  }
  return ordered;
}

/** Walk depends_on edges among the still-blocked nodes to surface a cycle. */
function traceCycle(remaining: string[], byId: Map<string, AppManifest>): string[] {
  const inSet = new Set(remaining);
  const start = remaining.slice().sort()[0];
  if (start === undefined) return [];
  const path: string[] = [];
  const onPath = new Set<string>();
  let cursor: string | undefined = start;
  while (cursor !== undefined && !onPath.has(cursor)) {
    path.push(cursor);
    onPath.add(cursor);
    cursor = byId.get(cursor)!.depends_on.filter((d) => inSet.has(d)).sort()[0];
  }
  if (cursor !== undefined) path.push(cursor); // close the loop
  return path;
}
