/**
 * app/types.ts — CONTRACT FILE (owned by architect; import-only for everyone else)
 *
 * The App framework: how a BlockApp declares itself (AppManifest), what handle it
 * holds at runtime (AppContext), how its blocks get rendered (Builder /
 * BuilderManifest), and how its commands are declared (CommandManifest) and routed
 * (CommandRegistry).
 *
 * Authoritative design: ai_com/block-agent-architecture-v3.1.md
 *   §4 commands-only · §5 AppRegistry/BlockApp · §5b trust split · §7 BuilderRegistry · §16 invariants
 *
 * House style (§0.5): the headline extension type is `BlockApp`; its satellite
 * types deliberately keep SHORT names — `AppManifest` / `AppContext` / `AppRegistry`
 * (NOT BlockAppContext). This "head prefixed, satellites bare" is an intentional
 * trade-off to avoid the very common `AppContext` becoming a long name. Do not
 * "fix" it.
 *
 * DECOUPLING (key to avoiding the core↔app import cycle): core/operations.ts must
 * route a command to its owning App by `full_name`, but core must NOT depend on a
 * concrete app or even on AppRegistry. So Operations depends on the `CommandRegistry`
 * INTERFACE declared here; AppRegistry (impl) implements it. core imports this
 * contract; it never imports app/registry.ts.
 */

import type {
  Block,
  BlockName,
  BlockNamePattern,
  BlockView,
  BlockSnapshot,
  CacheTier,
  InvokerContext,
  WakeEvent,
} from '../core/types.js';
// Type-only import; erased at compile time, so the contracts.ts↔types.ts cycle is
// purely structural (no runtime dependency edge, core's runtime closure unchanged).
import type { ContractDef } from './contracts.js';

// ============================================================================
// §9 Capabilities (referenced by manifests; full ACL model lives in policy.ts)
// ============================================================================

/**
 * Capability — a permission token a command/builder requires. The PolicyEngine
 * checks the invoker's granted capabilities against these. Kept structural here;
 * the concrete capability vocabulary and ceiling rules live with the policy impl.
 */
export interface Capability {
  /** e.g. `block:write`, `net:http`, `cred:read_blob`, `block:delete_physical`. */
  name: string;
  /** Optional scope, e.g. an allowed host for `net:http`. */
  scope?: string;
}

// ============================================================================
// §5 / §7 JSON schema (App state + builder output validation)
// ============================================================================

/**
 * JsonSchema — opaque-to-the-contract schema object used for:
 *   - AppManifest.state_schema (INVARIANT #14: set_state is Proxy-validated)
 *   - BuilderManifest.output_schema (optional)
 * The runtime supplies the validator; the contract only requires the shape exist.
 */
export type JsonSchema = Record<string, unknown>;

/** Token budget for background system agents (§5.2 spawn_system_agent). */
export interface TokenBudget {
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_calls?: number;
}

// ============================================================================
// §7 Builder (behavior lives OUTSIDE blocks)
// ============================================================================

/**
 * BuildContext — the deterministic sandbox a render-builder's `build` runs in.
 *
 * INVARIANT #16: non-deterministic APIs (Date.now / Math.random /
 * crypto.randomUUID / process.env / new Date / performance.now) are FORBIDDEN
 * inside build, because rendering must be byte-identical (INVARIANT #1). Use the
 * deterministic substitutes below instead.
 */
export interface BuildContext {
  /** The frozen tree this build reads from. */
  snapshot: BlockSnapshot;
  /** Read an input block (by name) from the snapshot. */
  read(name: BlockName): Readonly<Block> | null;

  // Deterministic substitutes for the banned APIs (§7.2).
  deterministic_clock(): number;
  deterministic_random(seed: string): number;
  content_addressed_id(content: string): string;
  /** Config injected via the App SDK in place of process.env. */
  config: Readonly<Record<string, string>>;
}

/**
 * BuilderManifest — the runtime's record for one builder (§7.1): what it
 * subscribes to, what it produces, its cache tier, and who owns it.
 *
 * INVARIANT #4: `owner: 'agent'` is illegal (compile-time union + runtime reject).
 *   render-builders may only be authored by system / plugin / tool (trusted).
 *   action-scripts (side-effecting) may be agent/third-party authored, but run
 *   out-of-process/sandboxed and never on the render hot path (§5b).
 */
export interface BuilderManifest {
  name: string;
  version: string;
  /** Trusted authorship only. 'agent' is intentionally NOT a member. */
  owner: 'system' | 'plugin' | 'tool';
  /** Owning App id; may be absent for system-level builders. */
  app_id?: string;

  /** Name patterns this builder subscribes to (namespaced, e.g. `memory:*`). */
  inputs: BlockNamePattern[];
  /** Block names this builder produces (exactly owns). */
  outputs: BlockName[];
  output_schema?: JsonSchema;

  cache_tier: CacheTier;
  /**
   * INVARIANT #6: when true, a minor version bump may not change cache_tier
   * (keeps byte-identical rendering stable across versions).
   */
  cache_tier_pinned?: boolean;

  throttle_ms?: number;
  /** INVARIANT #7: > 1000 forces off-tree compute + atomic swap (§8.5). */
  latency_p95_ms?: number;

  capabilities?: Capability[];

  /**
   * Render this builder's block from the snapshot. Pure + deterministic.
   * Returns null to render nothing this turn. `app_ctx` is provided for
   * App-owned builders that need their App state.
   */
  build(ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null>;
}

/**
 * Builder — a registered, ready-to-run builder instance. The registry stores its
 * manifest alongside the live `build` function. (BuilderManifest already carries
 * `build`, so a Builder is largely its manifest; this alias documents intent at
 * call sites where a runnable builder, not just its declaration, is meant.)
 */
export type Builder = BuilderManifest;

/** Factory the manifest uses to construct builders once App state type is known. */
export type BuilderManifestFactory<TState = unknown> = (
  state: TState,
) => BuilderManifest;

// ============================================================================
// §4 Commands (the only mutation path; shared by user and agent)
// ============================================================================

/**
 * CommandResult — the outcome of invoking a command. `ops` are the tree
 * mutations the command wants applied; Operations applies them after the
 * PolicyEngine allowed the call. `data` is an optional structured payload
 * returned to the caller (e.g. search hits). `error` reports command failure.
 */
export interface CommandResult {
  ok: boolean;
  /** Tree mutations to apply (already authorized by the time these run). */
  ops?: import('../core/types.js').BlockOp[];
  /** Structured return payload for the caller. */
  data?: unknown;
  /** Set when ok === false. */
  error?: string;
  /**
   * Signals the runtime that, with this command, the agent has FINISHED responding for
   * this wake — the turn loop should stop and return to idle (await the next event)
   * rather than running another turn. A reply-to-the-user command (e.g. `messages.reply`)
   * sets this: without it the loop keeps spinning (a reply "progressed", so another turn
   * runs) and the agent re-replies. Commands that produce results the agent should react
   * to (tool calls) leave it unset so multi-step tool use still loops. Absent ⇒ false.
   */
  end_turn?: boolean;
}

/**
 * CommandManifest — declares one command exposed by an App (§4). The SAME command
 * is available to every invoker (user / agent / app); there is no separate
 * agent-only channel. Per-invoker strictness is decided by PolicyEngine, not here.
 */
export interface CommandManifest<TState = unknown> {
  /** Bare command name within the App, e.g. `reply`. Full name is `<app_id>.<name>`. */
  name: string;
  /** Human-facing description; surfaces in the commands list builder. */
  description: string;
  /** Optional input schema for args validation. */
  args_schema?: JsonSchema;
  /**
   * The shape this command's `CommandResult.data` returns (R-1, C-API-1). A
   * command used as a contract provider's `via` declares it here; the
   * AssembleTime type check is then DECLARATION-vs-DECLARATION — the contract's
   * `output_schema` is checked against THIS `result_schema` (not by running the
   * command and inspecting its data, which would be a hallucinated guarantee).
   * Optional + additive: commands that never back a contract leave it unset.
   * Validated at runtime by R-3's checker as a backstop. See app/contracts.ts
   * `validateAgainstSchema`.
   */
  result_schema?: JsonSchema;
  /**
   * Marks a command as a pure READ — it returns `CommandResult.data` and applies
   * NO tree mutations (R-3, C-API-9 / CM-1). This is MECHANISM, not convention:
   * a contract `provides.via` command MUST be `readonly` (the registry asserts
   * it at assemble time), and consume-refresh pulls a provider via
   * `Operations.invoke_query` (resolve → check → route → return only `data`,
   * never applyOps). That keeps the render-time refresh from writing the tree, so
   * byte-identical rendering (INVARIANT #1) holds by construction. Absent ⇒ the
   * command may mutate (current behavior — no command is read-only unless it says so).
   */
  readonly?: boolean;
  /** Capabilities required to invoke; PolicyEngine checks these per invoker. */
  capabilities?: Capability[];
  /**
   * Restrict WHICH invokers may run this command. Absent ⇒ all invokers allowed
   * (current behavior — no restriction). When present, PolicyEngine DENIES any
   * invoker not in the list, BEFORE capability checks. This is the reusable
   * "who, not what" gate: e.g. `agent_identity.set` declares `['user']` so the
   * agent can never rewrite its own identity/constraints (anti-jailbreak), and
   * `memory.pin` could likewise be user-only. It is orthogonal to `capabilities`
   * (what permission tokens the call needs) — this is purely about the invoker
   * role. PolicyEngine reads it via an injected resolver, so the engine stays
   * decoupled from this manifest and O(1) (INV #19).
   */
  allowed_invokers?: InvokerContext['invoker'][];
  /**
   * Execute the command. Receives validated args, the App's runtime handle, and
   * the invoker context (so a command may behave differently for user vs agent
   * within policy bounds). Returns ops to apply + optional data.
   */
  invoke(args: unknown, ctx: AppContext<TState>, invoker: InvokerContext): Promise<CommandResult>;
}

export type CommandManifestFactory<TState = unknown> = (
  state: TState,
) => CommandManifest<TState>;

// ============================================================================
// §5.1 AppManifest (static declaration — "the packing list")
// ============================================================================

/**
 * AppTrust — a BlockApp's trust level (§ unified-host UH-1). `'trusted'` is the
 * default when a manifest omits it (every first-party App today): runs in-process,
 * full capability ceiling. `'sandboxed'` is untrusted code (third-party / agent-
 * authored): runs isolated and under a tightened ceiling. Kept a bare union (not
 * branded) so a manifest field stays cheap to set. See app/host.ts `resolveHost`.
 */
export type AppTrust = 'trusted' | 'sandboxed';

/**
 * AppHostKind — where a BlockApp's command/state code runs (§ unified-host UH-1).
 * `'in-process'` = a direct reference inside the runtime (today's behavior, zero
 * overhead). `'child-process'` = an isolated OS process bridged by an RPC-proxied
 * AppContext (the carrier for sandboxed Apps; wired in UH-2). The AppContext
 * interface is identical for both — "interface orthogonal to carrier".
 */
export type AppHostKind = 'in-process' | 'child-process';

/**
 * AppManifest — what the runtime reads when installing a BlockApp (§5.1).
 * Declares identity, the subtree it occupies, dependencies, its builders and
 * commands, its initial state, and (INVARIANT #14) the schema that constrains
 * its state.
 */
export interface AppManifest<TState = unknown> {
  id: string;
  version: string;
  /**
   * Other App ids this App depends on (topologically sorted at bootstrap).
   *
   * @deprecated Do NOT use this to express a DATA dependency — that is what
   * contracts (`consumes` / `provides`) are for (§3.3a / E1). `depends_on` names
   * a concrete app-id, which is exactly the identity coupling contracts remove:
   * if a consumer keeps `depends_on: ['messages']`, swapping MessageApp →
   * wechatLikeApp leaves `consumes` intact but breaks `depends_on`, defeating the
   * decoupling. Availability ("a provider must exist") is now the contract
   * "satisfiability" check (§3.4); install ordering evaporates (consume happens at
   * render time; a provider may install later and the next consume-refresh picks
   * it up). Kept for backward-compat bootstrap topo-sort; the registry emits a
   * deprecation warning when a non-empty `depends_on` is installed. New contract
   * apps declare `depends_on: []`. May be removed / renamed to `install_after?`
   * in a later phase (P3).
   */
  depends_on: string[];

  /**
   * Contracts this App SATISFIES: each entry says "command `via` satisfies
   * contract `contract`" (§3.3). The registry derives a `contract → [{app_id,
   * via}]` resolution table from every installed manifest's `provides` (no
   * hand-written route table) and, at assemble time, checks the contract's
   * `output_schema` against the via command's `result_schema` (declaration vs
   * declaration, R-1). All fields are `string` (NOT a literal/branded type) so a
   * third-party `contract` name never has to be widened (C-API-4). Optional +
   * additive: an App that provides nothing leaves it unset.
   */
  provides?: { contract: string; via: string }[];
  /**
   * Contracts this App CONSUMES: each entry says "I consume contract `contract`;
   * fold the merged result into `state[as]`" (§3.3). The consumer NEVER names a
   * provider app-id (no identity coupling) — the registry resolves providers from
   * the table and `combine`s their outputs (sum / list / first). The registry's
   * satisfiability check warns when a consumed contract has zero providers
   * (replacing the `depends_on` missing-dep error — a warning, not a throw). All
   * fields `string` (C-API-4). Optional + additive.
   */
  consumes?: { contract: string; as: string }[];

  /**
   * Trust level (§ unified-host UH-1). Decides the default host carrier and the
   * capability ceiling applied to this App's commands. Optional + additive:
   * absent ⇒ `'trusted'` (every built-in / first-party App today), so existing
   * manifests are unchanged. `'sandboxed'` marks untrusted code (third-party /
   * agent-authored) that must run isolated (see `host` below + app/host.ts
   * `resolveHost`). See ai_com/design/blockapp-unified-host-architecture.md §4.1.
   */
  trust?: AppTrust;
  /**
   * Host carrier (§ unified-host UH-1). Where this App runs. Optional: absent ⇒
   * derived from `trust` (`'trusted'`→`'in-process'`, `'sandboxed'`→`'child-process'`)
   * via `resolveHost`. An operator may override within the legal range, but a
   * `trust:'sandboxed'` App may NOT be downgraded to `'in-process'` (security
   * invariant — `resolveHost` throws). "Interface is orthogonal to carrier": the
   * AppContext signature is identical either way (direct ref vs RPC proxy). Only
   * `'in-process'` is wired today (UH-1); `'child-process'` lands in UH-2.
   */
  host?: AppHostKind;

  /** Subtree root this App owns, e.g. `/memory` (block names use the bare id prefix). */
  tree_namespace: string;
  initial_state: TState;
  /**
   * INVARIANT #14: state MUST declare a schema. set_state is Proxy-validated
   * against it; functions / credentials / Block refs are rejected.
   */
  state_schema: JsonSchema;

  builders: BuilderManifestFactory<TState>[];
  commands: CommandManifestFactory<TState>[];

  // Lifecycle hooks.
  /**
   * Run once when the App is installed (after register, before/around the
   * runtime's install wiring). Currently fire-and-forget at the AppRegistry
   * (`void on_install`), so an App needing async setup must not assume it has
   * finished before its first command runs (memory_letta's lazy `ensureAgentId`
   * is the canonical workaround). Use it to warm state, not as a barrier.
   */
  on_install?(ctx: AppContext<TState>): Promise<void>;
  /**
   * Run once when the App is uninstalled. SCOPE IS DELIBERATELY NARROW: do ONLY
   * graceful teardown — flush in-memory buffers, close external connections
   * (HTTP/Letta clients, DB handles), release advisory locks. It MUST NOT delete
   * the App's durable data (its `.block-agent/apps/<id>/*.jsonl`, or external
   * store records). Uninstall is "stop participating", not "destroy":
   * INVARIANT #5 (删除即归档) — an uninstalled App's data is ARCHIVED in place and
   * a later re-install of the same id continues to read it. Physical deletion is
   * a SEPARATE, explicit, capability-gated path (the CLI `/app purge`,
   * `block:delete_physical`, with confirmation), never this hook. The runtime's
   * hot-uninstall orchestration removes the projection-block tree nodes and the
   * registry index around this hook (see the lifecycle design / impl-split spec);
   * `on_uninstall` itself touches neither the tree nor stored data.
   */
  on_uninstall?(ctx: AppContext<TState>): Promise<void>;
}

// ============================================================================
// §5.2 AppContext (runtime handle — "the remote control")
// ============================================================================

/** An event delivered over the App pub/sub channel (§5.2 on/emit). */
export interface AppEvent {
  topic: string;
  payload: unknown;
}

/** Handle to a background system agent spawned by an App (§5.2). */
export interface SystemAgentHandle {
  id: string;
  stop(): void;
}

/**
 * AppContext — the operating handle an App holds at runtime (§5.2). Through it an
 * App reads/writes its own state, calls other Apps, reads their public blocks,
 * subscribes to events, and spawns background system agents.
 *
 * Trust boundary (INVARIANT #11): AppContext is the App's INTERNAL trusted domain.
 * Cross-App interaction goes through the three channels below — and invoke_command
 * crosses back through PolicyEngine.
 *
 * by-value rules (INVARIANT #18, §5.2): cross UNTRUSTED boundary → deep copy
 * (blobs as `blob://` handles); trusted in-process ↔ trusted in-process → BlockView
 * (read-only, zero-copy, non-transferable); inside one App → plain references.
 */
export interface AppContext<TState = unknown> {
  readonly app_id: string;

  /** Current App state (readable). */
  readonly state: TState;
  /**
   * Transition App state. Does NOT pass through PolicyEngine (INVARIANT #10:
   * App-internal state machine, not an agent-initiated command), but DOES pass
   * through a Proxy that validates against state_schema (INVARIANT #14). Throws
   * AppStateViolation on schema breach.
   */
  set_state(updater: (s: TState) => TState): void;

  // Reflection over what this App registered.
  list_commands(): CommandManifest[];
  list_builders(): BuilderManifest[];
  /** All blocks under this App's namespace. */
  list_blocks(): Block[];

  // === Cross-App interaction: three channels (all cross-boundary, all by-value) ===

  /** (1) Call — request/response; re-enters PolicyEngine. */
  invoke_command(full_name: string, args: unknown): Promise<CommandResult>;

  /**
   * (2) Read — pull another App's blocks exposed as public. Returns COPIES (not
   * live references) across an App boundary; a BlockView (zero-copy) only between
   * two trusted in-process Apps. INVARIANT #22: read returns copies.
   */
  read(blockname: BlockName): Promise<Block[] | BlockView[]>;

  /**
   * (3a) Subscribe — notification only, fire-and-forget. INVARIANT #22: handlers
   * must NOT add blocking gates (a write gate / PII scrub must go through
   * invoke_command or the entry membrane, never emit).
   */
  on(event: string, handler: (e: AppEvent) => void): void;
  /** (3b) Emit — fire an event to subscribers; fire-and-forget. */
  emit(event: string, payload: unknown): void;

  /**
   * Spawn an App-internal background system agent (e.g. memory's archivist).
   * I/O-bound async on a background lane; does NOT count toward MAX_SPAWN_DEPTH;
   * governed by a per-App budget + the global LLM semaphore (§5.2 / §8.1).
   */
  spawn_system_agent(spec: {
    goal: string;
    trigger: 'post_turn' | 'on_idle' | 'on_event';
    budget: TokenBudget;
  }): SystemAgentHandle;

  /**
   * Wake the AgentRuntime (§8.2). The seam an App uses to move the runtime out of
   * idle after it has durably recorded the triggering fact — e.g. the messages App
   * appends to `inbox.jsonl`, then calls `ctx.wake({kind:'async_message_arrived',
   * msg_id})`. Fire-and-forget from the App's perspective: it returns immediately;
   * the runtime schedules/runs the turn loop itself. NOT routed through PolicyEngine
   * (it carries no tree mutation — it is a scheduling signal, not a command).
   *
   * The runtime injects the concrete hook at boot (late-injection, like the other
   * cross-App seams); until then it is a no-op. An App MUST tolerate `wake` being
   * absent/inert (guard with `ctx.wake?.(...)`), so installing an App without a
   * running runtime (e.g. in a builder-only test) does not throw.
   */
  wake?(event: WakeEvent): void;
}

// ============================================================================
// §5.3 AppRegistry + the CommandRegistry decoupling interface
// ============================================================================

/** Result of installing an App; `installed_id` may differ on a namespace clash. */
export interface InstallResult {
  /** Final id; may be auto-renamed (e.g. `chat` → `chat_2`) on conflict. */
  installed_id: string;
  warnings: string[];
}

/**
 * AppRegistry — installs/uninstalls Apps, topo-sorts by depends_on, resolves
 * namespace collisions (§5.3). The concrete impl (app/registry.ts) also
 * IMPLEMENTS CommandRegistry and BuilderRegistry so that core can route through
 * the interfaces without importing the registry class.
 *
 * Because the registry method names are now distinct across the three interfaces
 * (`list` here vs `list_builders`; `resolve_command` vs `resolve_builder`), a
 * single class can `implements AppRegistry, CommandRegistry, BuilderRegistry`
 * directly — no adapter accessors needed. core/operations.ts receives it typed as
 * CommandRegistry; core/renderer.ts receives it typed as BuilderRegistry.
 */
export interface AppRegistry {
  install(manifest: AppManifest): InstallResult;
  uninstall(app_id: string): void;
  list(): AppManifest[];
  get(app_id: string): AppManifest | null;
}

/**
 * CommandRegistry — THE decoupling seam between core and app.
 *
 * core/operations.ts depends ONLY on this interface to route an authorized
 * command to its owning App (by `full_name = <app_id>.<command>`). AppRegistry
 * implements it. This breaks the core↔app cycle: core never imports app/registry.ts.
 *
 * `resolve_command` returns the command's declared capabilities/manifest so the
 * PolicyEngine (also in core) can make its decision BEFORE `route` executes the
 * command — keeping the security check inside invoke_command with no bypass
 * (INVARIANT: §9.1 defense-in-depth).
 *
 * NAMING (wave 2): the lookup method is `resolve_command` — NOT a bare `resolve`
 * — so that a SINGLE class (AppRegistry) can `implements CommandRegistry,
 * BuilderRegistry, AppRegistry` directly. A bare `resolve` on both registries
 * collides (same name, incompatible return types); distinct, self-describing
 * names are the right design anyway. See BuilderRegistry below.
 */
export interface CommandRegistry {
  /** Look up a command's manifest by full name; null if unknown. */
  resolve_command(full_name: string): CommandManifest | null;
  /**
   * Resolve the AUTHORED trust of the App that owns a command (`<app_id>.<cmd>`),
   * straight from its `AppManifest.trust` (UH-2 §3.8). The PolicyEngine consults
   * this so the sandboxed/full-trust lane decision is keyed off the App's OWN
   * declaration — not off whether a caller remembered to stamp
   * `InvokerContext.trust` — making the capability ceiling fail-closed. Returns the
   * owning App's `trust` (or `undefined`/`'trusted'` when the App declared none, or
   * when the command is unknown — the default). Pure + O(1) (a map lookup), so the
   * engine stays IO-free (INV #19) and core never imports the registry class.
   */
  trust_of(full_name: string): AppTrust | undefined;
  /**
   * Execute an already-authorized command, dispatching to its owning App's
   * AppContext. Returns the command's result (ops + data). Implementations must
   * assume the PolicyEngine has already allowed this call.
   */
  route(full_name: string, args: unknown, invoker: InvokerContext): Promise<CommandResult>;
}

/**
 * BuilderRegistry — resolves a block name to its owner builder (O(1) via the
 * namespace prefix, §3.1) and exposes a block's cache_tier to the Renderer (§7).
 * Implemented by app/registry.ts; consumed by core/renderer.ts through this
 * interface (core does not import the registry class).
 *
 * NAMING (wave 2): `resolve_builder` / `list_builders` are deliberately distinct
 * from CommandRegistry.resolve_command and AppRegistry.list so one class can
 * implement all three interfaces without method-name/return-type collisions.
 */
export interface BuilderRegistry {
  /** Resolve the owner builder for a block name; null if none registered. */
  resolve_builder(block_name: BlockName): BuilderManifest | null;
  /** The cache tier declared for a block name; null if unknown. */
  tier_of(block_name: BlockName): CacheTier | null;
  /** All registered builders (e.g. for topo sort / cycle check at bootstrap). */
  list_builders(): BuilderManifest[];
  /**
   * Register a SYSTEM builder that belongs to no installed App (R-5 / B1). The
   * runtime constructs a system builder (a closure over its own bookkeeping state)
   * and registers it here AFTER construction (CM-5), so that `resolve_builder` /
   * `tier_of` / `list_builders` and `seedProjectionBlocks` all see its outputs. The
   * registry stays the single owner of `ownerByBlockName` (F3): core mutates builder
   * ownership ONLY through this seam, never by touching the index directly. The
   * builder's owner must be `system` (INV #4 — never `agent`); its output names must
   * not already be owned by an installed App (INV #3).
   */
  registerSystemBuilder(builder: BuilderManifest): void;

  // --------------------------------------------------------------------------
  // Consume-refresh seam (R-4 / CM-2 / CM-9) — OPTIONAL on the interface.
  // --------------------------------------------------------------------------
  //
  // The runtime holds the registry as `BuilderRegistry` and runs a render-time
  // `consumeRefresh()` over these four accessors (AppRegistry implements all of
  // them). They are OPTIONAL so test doubles that don't model the contract layer
  // (e.g. TestBuilderRegistry in test/fixtures.ts) still satisfy the interface —
  // adding them as REQUIRED would break every `implements BuilderRegistry` double
  // and turn the baseline red. The runtime guards each call (and wraps the whole
  // refresh in try/catch, R-4 layer 3), so an undefined member ⇒ refresh is a
  // no-op for that registry, which is exactly right for a contract-less double.

  /**
   * Every INSTALLED App that declares `consumes`, as `{app_id, consumes}` pairs.
   * `app_id` is the installed id (the key `get_app_context` expects). Apps with no
   * `consumes` are omitted, so an empty result ⇒ consume-refresh is a no-op.
   */
  consumers?(): { app_id: string; consumes: { contract: string; as: string }[] }[];

  /**
   * The providers of a contract over the currently-installed Apps, as
   * `[{app_id, via}]`. `app_id` is the installed id; the runtime calls each via
   * `invoke_query(`${app_id}.${via}`, …)`. An unprovided contract yields `[]`.
   */
  providers_of?(contract: string): { app_id: string; via: string }[];

  /** The `ContractDef` for a contract name (its `output_schema` / `combine`), or null. */
  resolve_contract?(name: string): ContractDef | null;

  /**
   * The LIVE AppContext for an installed App (the `set_state` seam consume-refresh
   * folds merged results through), or null if no such App is installed.
   */
  get_app_context?(app_id: string): AppContext | null;
}
