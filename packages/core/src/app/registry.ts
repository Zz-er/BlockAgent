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

// ============================================================================
// Capability ceiling (INV #19 — O(1) set-membership, injected seam)
// ============================================================================

/**
 * Trust level of an App's authorship — drives the capability ceiling. v1 only
 * ever produces 'trusted' (built-in + audited npm packages installed in-process,
 * the only form v1 supports). 'agent_authored' is reserved for the follow-up
 * out-of-process sandbox lane (§5b) and never appears in v1.
 */
export type AppTrustLevel = 'trusted' | 'agent_authored';

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

  /** Per-App config injected into BuildContext.config in place of process.env. */
  private readonly configs = new Map<string, Readonly<Record<string, string>>>();

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

    // Capability ceiling check (INV #19 — report-only in v1; seam built for future
    // agent_authored lane to tighten to reject). Skipped when ceiling_resolver is
    // not injected, so all existing tests are unaffected.
    if (this.ceiling_resolver) {
      const allowed = this.ceiling_resolver('trusted'); // v1: all apps are 'trusted'
      for (const cmd of instance.commands.values()) {
        for (const cap of cmd.capabilities ?? []) {
          if (!allowed.has(cap.name)) {
            warnings.push(
              `App '${installed_id}' command '${cmd.name}' declares capability '${cap.name}' outside the ceiling (report-only)`,
            );
          }
        }
      }
      for (const builder of instance.builders) {
        for (const cap of builder.capabilities ?? []) {
          if (!allowed.has(cap.name)) {
            warnings.push(
              `App '${installed_id}' builder '${builder.name}' declares capability '${cap.name}' outside the ceiling (report-only)`,
            );
          }
        }
      }
    }

    this.apps.set(installed_id, instance);
    this.indexBuilders(instance);

    void manifest.on_install?.(instance.ctx);

    return { installed_id, warnings };
  }

  /** An id is unavailable if an App holds it OR it is reserved for the core. */
  private isTaken(app_id: string): boolean {
    return this.apps.has(app_id) || RESERVED_APP_IDS.has(app_id);
  }

  uninstall(app_id: string): void {
    const instance = this.apps.get(app_id);
    if (!instance) return;
    void instance.manifest.on_uninstall?.(instance.ctx);
    for (const builder of instance.builders) {
      for (const out of builder.outputs) {
        if (this.ownerByBlockName.get(out) === builder) this.ownerByBlockName.delete(out);
      }
    }
    this.apps.delete(app_id);
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
   */
  get_app_context(app_id: string): AppContext | null {
    return this.apps.get(app_id)?.ctx ?? null;
  }

  // --------------------------------------------------------------------------
  // §5.3 bootstrap — topo-sort by depends_on, cycle-detect, install in order
  // --------------------------------------------------------------------------

  /**
   * Install a batch of manifests respecting `depends_on`. Returns the
   * InstallResult for each in install (topological) order. Throws
   * AppDependencyCycleError on a cycle or AppManifestError on a missing
   * dependency.
   */
  bootstrap(manifests: AppManifest[]): InstallResult[] {
    const ordered = topoSort(manifests);
    return ordered.map((m) => this.install(m));
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
    const manifest = instance.commands.get(command);
    if (!manifest) return { ok: false, error: `unknown command '${full_name}'` };
    try {
      return await manifest.invoke(args, instance.ctx, invoker);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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

  /** All registered builders, deterministically ordered by app_id then name. */
  list_builders(): BuilderManifest[] {
    const all: BuilderManifest[] = [];
    for (const id of [...this.apps.keys()].sort()) {
      all.push(...this.apps.get(id)!.builders);
    }
    return all;
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

    return {
      id: installed_id,
      manifest,
      ctx,
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
        if (registry.commandRouter)
          return registry.commandRouter(full_name, args, { invoker: 'app', identity: app_id });
        return registry.route(full_name, args, { invoker: 'app', identity: app_id });
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
