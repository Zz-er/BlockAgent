/**
 * cli/launch.ts — config-driven boot, the generalized index.ts (impl-cli-logic owned).
 *
 * Design: ai_com/block-agent-cli-design.md §1 (launcher), §7 (real Provider), §10
 * (the boot graph is exactly index.ts's wiring, generalized). Build the SAME object
 * graph index.ts builds, but driven by LauncherConfig:
 *   BlockTree → AppRegistry → PolicyEngine → Operations → Renderer → Provider →
 *   AgentRuntime, with the three standard apps (per config.apps) and a REAL provider
 *   (anthropic / openai-compat, or mock for --dry-run). Wire wakeHook + the live
 *   app_context_provider exactly as index.ts does.
 *
 * Pure: no Ink/React, no console. Returns the LaunchedAgent handle. On a missing
 * provider key, throw a tagged error (`MissingProviderKeyError`) so main.tsx can print
 * the graceful guidance and exit BEFORE mounting the UI (design §7) — the key check is
 * front-loaded so the first turn never crashes mid-conversation.
 *
 * The API key is read straight from env here (never from config, never logged), then
 * handed to the provider constructor (anthropic.ts:74 / openai_compat.ts:68).
 */

import { join } from 'node:path';

import { BlockTree } from '@block-agent/core/core/block.js';
import { Operations } from '@block-agent/core/core/operations.js';
import { PolicyEngine, CAP } from '@block-agent/core/core/policy.js';
import { Renderer } from '@block-agent/core/core/renderer.js';
import { AppRegistry, type AppTrustLevel } from '@block-agent/core/app/registry.js';
import { ChildProcessHost, type HostDeps } from '@block-agent/core/app/child_process_host.js';
import { forkChildApp } from '@block-agent/core/app/child/fork.js';
import { run_in_chain } from '@block-agent/core/core/taint.js';
import { MESSAGE_COUNT, TASK_COUNT } from '@block-agent/core/app/contracts.js';
import { AgentRuntime, type ToolCatalog } from '@block-agent/core/runtime/agent_runtime.js';
import { AnthropicProvider } from '@block-agent/core/provider/anthropic.js';
import { OpenAiCompatibleProvider } from '@block-agent/core/provider/openai_compat.js';
import { MockProvider } from '@block-agent/core/provider/mock.js';
import { ImEchoMockProvider } from '@block-agent/core/provider/im_echo_mock.js';
import { TaskCreateMockProvider } from '@block-agent/core/provider/task_create_mock.js';
import { OaResolveMockProvider } from '@block-agent/core/provider/oa_resolve_mock.js';
import { makeAgentIdentityApp } from '@block-agent/app-agent_identity/manifest.js';
import { MessagesApp } from '@block-agent/app-messages/manifest.js';
import { ToolsApp } from '@block-agent/app-tools/manifest.js';
import { MemoryApp } from '@block-agent/app-memory/manifest.js';
import { ActionsApp } from '@block-agent/app-actions/manifest.js';
import { TaskApp } from '@block-agent/app-task/manifest.js';
import { StatsApp } from '@block-agent/app-stats/manifest.js';
import { MemoryLettaApp } from '@block-agent/app-memory_letta/memory_letta_app.js';
import { TurnLogApp } from '@block-agent/app-turn_log/manifest.js';
import { FocusApp } from '@block-agent/app-focus/manifest.js';
// Phase C platform-service proxies (default-off). ORG_DIRECTORY is the org_directory
// ContractDef OWNED BY oa_proxy (a platform-domain contract — deliberately NOT in core,
// which must hold no app-domain knowledge); launch registers it so the im/task proxies'
// `consumes` bind resolves.
import { ImProxyApp } from '@block-agent/app-im_proxy/manifest.js';
import { OaProxyApp, ORG_DIRECTORY } from '@block-agent/app-oa_proxy/manifest.js';
import { TaskProxyApp } from '@block-agent/app-task_proxy/manifest.js';

import type { BlockName } from '@block-agent/core/core/types.js';
import type { ModelProvider } from '@block-agent/core/provider/types.js';
import type { IdentityState } from '@block-agent/app-agent_identity/manifest.js';
import type { LauncherConfig, LaunchedAgent, ProviderKind, HotUninstallResult } from './types.js';
import { MISSING_PROVIDER_KEY_CODE } from './types.js';

/** The empty-tree root name (core/block.ts:128 `core:root`); apps fill the tree on use. */
const ROOT_NAME: BlockName = 'core:root';

/**
 * Turn-barrier registry, keyed by AgentRuntime. The §8.2 wake seam (`ctx.wake` →
 * `AppRegistry.wakeHook` → `on_wake`) is fire-and-forget from the App's perspective —
 * `messages.ingest` returns BEFORE the turn loop finishes (app/types.ts: "Fire-and-forget
 * … it returns immediately; the runtime schedules/runs the turn loop"). The CLI, however,
 * wants `CliChannel.submit` to RESOLVE only after the agent has finished responding (so
 * replies have been delivered, design §4 "AWAIT 它"). So `launch` chains every wake into a
 * serialized tail promise and registers a getter here; `cli_channel.submit` awaits it after
 * ingest. This keeps the App-facing wake fire-and-forget (unchanged contract) while giving
 * the CLI a precise "turn settled" signal — without widening the LaunchedAgent type.
 */
const turnBarriers = new WeakMap<AgentRuntime, () => Promise<void>>();

/** The "all queued turns settled" promise for a runtime, or a resolved promise if none. */
export function awaitTurnsSettled(runtime: AgentRuntime): Promise<void> {
  return turnBarriers.get(runtime)?.() ?? Promise.resolve();
}

/** `.block-agent/apps` under the storage base (apps/_app_config.ts APPS_DIR convention). */
function appsBaseDir(config: LauncherConfig): string {
  const base = config.storage_dir ?? process.cwd();
  return join(base, '.block-agent', 'apps');
}

/**
 * MissingProviderKeyError — thrown by `launch` BEFORE building the runtime when the
 * selected provider needs an API key the env does not supply (design §7 graceful path).
 * main.tsx recognizes it (by `name`) to print which env var to set + the `--dry-run`
 * escape hatch, then exits non-zero without mounting the UI. Carries the env var name
 * so the message is actionable; NEVER carries a key value.
 */
export class MissingProviderKeyError extends Error {
  override readonly name = 'MissingProviderKeyError';
  /** Stable tag main.tsx narrows on (the `MissingProviderKeyError` contract, types.ts). */
  readonly code = MISSING_PROVIDER_KEY_CODE;
  constructor(
    readonly provider_kind: ProviderKind,
    readonly env_var: string,
  ) {
    super(
      `Provider '${provider_kind}' needs an API key, but ${env_var} is not set.\n` +
        `Set it in your environment, e.g.\n` +
        `  $env:${env_var} = "<your key>"   (PowerShell)\n` +
        `  export ${env_var}=<your key>     (bash)\n` +
        `Or run offline with a scripted mock provider: --provider mock  (a.k.a. --dry-run).`,
    );
  }
}

/**
 * launch — construct and wire the core graph from a resolved config.
 *
 * Wiring order mirrors index.ts (ARCHITECTURE.md "Wiring order & AppRegistry
 * construction"): empty BlockTree → AppRegistry (install the enabled standard apps) →
 * PolicyEngine (resolvers read the registry) → Operations → Renderer (live
 * app_context_provider) → Provider → AgentRuntime → wakeHook. Cross-app invoke_command
 * is routed through Operations (so it re-enters PolicyEngine, INV #11).
 */
export async function launch(config: LauncherConfig): Promise<LaunchedAgent> {
  // 0) Front-load the no-key check so we fail before mounting the UI (design §7).
  //    Throws MissingProviderKeyError if a needed key is absent.
  const provider = buildProviderOrThrow(config);

  // 1) Empty tree (synthetic `core:root`; apps fill it via commands at runtime).
  const tree = new BlockTree();

  // 2) AppRegistry + install the enabled standard apps via the shared id→manifest
  //    factory. installEnabledApps keeps the MessagesApp handle so the CLI can
  //    subscribe to onReply (reply=Option B, §6). The boot path and any future hot
  //    install share this ONE mapping (no second wiring path to drift, design §6.3).
  const registry = new AppRegistry();

  // 2-ceiling) Inject the REAL capability ceiling (UH-2 §3.8 — prerequisite-2). The
  //   resolver maps an authorship trust LEVEL to the capability NAMES that level may
  //   declare; install() checks every declared cap against it and, for an untrusted
  //   (agent_authored / sandboxed) app, REJECTS an out-of-ceiling cap (throws). This
  //   MUST be set before installEnabledApps below so the boot's own installs are
  //   checked too. Built-in (trusted) apps get the FULL set → zero regression; the
  //   sandboxed ceiling excludes the escalation trio (cred:read_blob /
  //   block:delete_physical / block:modify_pinned), matching the PolicyEngine
  //   `sandboxed` row's denied set (policy.ts) so install-time and run-time agree.
  registry.ceiling_resolver = capabilityCeilingFor;

  // 2a) Register the built-in scalar-count contracts (R-6) BEFORE installing any app,
  //     so the assemble-time provides/consumes check can resolve each contract NAME to
  //     its ContractDef (output_schema ⊨ via.result_schema, R-1) the moment a provider
  //     (messages→message_count, task→task_count) or consumer (stats) installs. Register
  //     before install or the check sees an unknown contract and the binding is silently
  //     dropped. App-defined contracts (none built-in beyond these two) would register here too.
  registry.registerContract(MESSAGE_COUNT);
  registry.registerContract(TASK_COUNT);
  // org_directory (Phase C): provided by oa_proxy, consumed by im_proxy + task_proxy. Registered
  // UNCONDITIONALLY (like the two above) so a consumer resolves the name even if oa_proxy is off
  // — with no provider the consume-refresh yields an empty directory and each proxy falls back to
  // the sanitized principal_id label (graceful, never throws).
  registry.registerContract(ORG_DIRECTORY);

  const base = appsBaseDir(config);
  const { messages } = installEnabledApps(config, registry, base);

  // 2b) turn_log — the persistent per-turn telemetry ledger (D1 §4). A presence-only app
  //     (no agent commands, no render builders — two-cadence rule §2.5): it exists so the
  //     launcher has a place to hang the `onTurn` subscription that appends each TurnRecord
  //     to `runtime_log.jsonl`. The actual ledger write is wired below (step 5b), AFTER the
  //     runtime is built; we construct + install the app here so it shares the standard
  //     install path and storage-dir convention. Always on (default_enabled): it is the
  //     durable source of truth that budget/inspector/runtime_stats READ.
  const turnLog = new TurnLogApp({ dir: join(base, 'turn_log') });
  registry.install(turnLog.manifest());

  // 2c) focus — the agent's working-state / trajectory app (D5 P1.5a). Owns ③ goal +
  //     ④ recent-action window + ⑤ working-state blocks. Installed here (before the
  //     PolicyEngine + seedProjectionBlocks below) so its commands route and its
  //     `focus:*` projection blocks are seeded from turn 1. The DETERMINISTIC distiller
  //     (`focus.record`, app-only) is fired per turn from `runtime.onTurn` (step 5c,
  //     after the runtime is built); `focus.set_goal` (agent/user, NOT app — the
  //     anti-injection gate) enters the agent tool catalog. The app reads its focus
  //     jsonl at construction (restart-restore, D5 §6); it never throws at boot.
  const focus = new FocusApp({ dir: join(base, 'focus') });
  registry.install(focus.manifest());

  // 3) PolicyEngine wired to the command capabilities + allowed_invokers + the
  //    AUTHORED trust of the owning App, then Operations (the single mutation
  //    chokepoint, with the engine inside).
  //    trust_resolver is the RUN-TIME half of the UH-2 ceiling (§3.8): it resolves a
  //    command's owning-App trust from the registry (`trust_of`), so a sandboxed App
  //    is gated by the tightened policy row even when the in-process router does NOT
  //    stamp `InvokerContext.trust` (fail-closed). Without it the boot path would
  //    enforce the ceiling only at INSTALL time and leave the run-time sandboxed lane
  //    keyed solely off a caller stamp — exactly the escape this prerequisite closes.
  //    Mirrors Operations.with_default_policy (operations.ts) so boot + that factory agree.
  const policy = new PolicyEngine({
    capability_resolver: (full_name) => registry.resolve_command(full_name)?.capabilities ?? [],
    allowed_invokers_resolver: (full_name) =>
      registry.resolve_command(full_name)?.allowed_invokers ?? null,
    trust_resolver: (full_name) => registry.trust_of(full_name),
  });
  const operations = new Operations(tree, policy, registry);

  // Route cross-app invoke_command through Operations so it re-enters PolicyEngine
  // (INV #11), exactly as a full boot wires it. The `invoker` arrives already stamped
  // by the calling AppContext (registry.makeContext → `{invoker:'app', identity:app_id}`);
  // Operations re-checks policy on it, so we pass it through untouched.
  //
  // UH-2 trust seam: when a sandboxed (cross-process) app's command crosses the
  // boundary, its InvokerContext must carry `trust:'sandboxed'` so PolicyEngine.row()
  // selects the tightened lane (policy.ts). In THIS slice every app is in-process
  // trusted, so the stamp is correctly absent (⇒ full-trust `app` row, zero
  // regression). The `trust` stamp will be applied by the ChildProcessHost when it
  // turns a child-process command frame into an invoke_command — NOT here: this
  // in-process router must never fabricate a `sandboxed` tag (that would wrongly
  // tighten a trusted in-process app). Left as a documented seam (UH-2 §3.8 / §3.9).
  registry.commandRouter = (full_name, args, invoker) =>
    operations.invoke_command(full_name, args, invoker);

  // UH-2/SS3c: inject the PRODUCTION child-host factory — the registry calls it when a
  // manifest resolves to 'child-process' (sandboxed). It builds a REAL ChildProcessHost
  // (forking a tsx child) with HostDeps wired to the trusted main-side capabilities. The
  // registry stays decoupled (it never imports Operations/taint); this is the ONE
  // production assigner of `child_host_factory` (the only other is the TEST-ONLY
  // in-process factory in test/_support — never both). `in_process_parts` is IGNORED
  // here (that is only for the test factory). FAIL-CLOSED: if this is NOT injected, the
  // registry throws on a sandboxed install (it never degrades to in-process).
  const childHostDeps: HostDeps = {
    // The child's framed cross-app invoke_command re-enters the chokepoint (INV#11). The
    // ChildProcessHost wraps THIS call in run_in_chain('sandboxed') itself (the cross-
    // process taint splice), so we just forward to Operations here.
    invoke_command: (full_name, args, ctx) => operations.invoke_command(full_name, args, ctx),
    // Authoritative cell write (补强①): registry re-validates schema (child is untrusted).
    write_cell: (app_id, next) => registry.write_app_cell(app_id, next),
    // Cross-app read → deep COPIES (INV#22/#18). structuredClone bounds it to data.
    read_blocks: (blockname) => operations.find(blockname).map((b) => structuredClone(b)),
    // emit doorbell (§3.5) — dispatch through the registry's event bus, no render data.
    dispatch_event: (_app_id, event, payload) => registry.dispatch_app_event(event, payload),
    // wake — scheduling signal (not policy-gated).
    wake: (event) => registry.wakeHook?.(event),
    // report_input — input telemetry (actions §2.1; not policy-gated, like wake).
    report_input: (d) => registry.inputHook?.(d),
    // The cross-process taint chain start point: ALS does not cross the fork, so the
    // host re-establishes 'sandboxed' around the child's framed callbacks (澄清#5).
    run_sandboxed: (fn) => run_in_chain('sandboxed', fn),
  };
  registry.child_host_factory = (app_id, _manifest) =>
    new ChildProcessHost({
      app_id,
      // pkg_path: production resolution of an installed sandboxed app's package dir is
      // UH-3 hot-install (§9, task#23) — no sandboxed app installs at boot today, so a
      // conventional <appsBase>/<app_id> path is the placeholder. e2e injects a fixture.
      pkg_path: join(base, app_id),
      deps: childHostDeps,
      spawn: forkChildApp,
    });

  // 4) Renderer over the live App-context provider so state-driven projection builders
  //    (messages:recent / tools:recent) read post-mutation state each render.
  const renderer = new Renderer(registry, {
    app_context_provider: (app_id) => registry.get_app_context(app_id),
  });

  // 5) Runtime. root_name = the empty-tree root so its bookkeeping blocks attach.
  //    tool_catalog advertises the agent-invokable commands to the provider each turn
  //    (native tool dispatch) — without it a real model only ever emits plain text,
  //    which fails commands-only, so it could never act. User-only commands are
  //    excluded (PolicyEngine would deny them to the agent anyway).
  //    tool_catalog is a MUTABLE reference behind the runtime's thunk: hot-uninstall
  //    rebuilds it so the agent stops seeing a removed app's commands the very next
  //    turn. The runtime contract is unchanged (still `() => ToolCatalog`); only the
  //    value the thunk closes over can change (agent_runtime already anticipates a
  //    dynamic command set, launch.ts §5).
  let currentToolCatalog = buildToolCatalog(registry);
  const runtime = new AgentRuntime({
    operations,
    renderer,
    provider,
    // R-5/F1: hand the runtime the registry so it can register its own bookkeeping
    // `system` builders (registry.registerSystemBuilder, B1 — done inside the ctor) and
    // resolve get_app_context for the consume-refresh pass (P3). We never call
    // registerSystemBuilder here; the runtime OWNS that. The two count contracts
    // registered above are already live, so the consume-refresh hook (runtime-native,
    // P3) activates as soon as a consumer (stats) is installed — no extra wiring.
    registry,
    ...(config.max_turns_per_wake !== undefined
      ? { max_turns_per_wake: config.max_turns_per_wake }
      : {}),
    root_name: ROOT_NAME,
    tool_catalog: () => currentToolCatalog,
  });

  // 5b) turn_log ledger subscription (D1 §4 / §2.5). Stamp the wall-clock `ts` HERE, at the
  //     boot/app layer, and append each TurnRecord to `runtime_log.jsonl`. `Date.now()` is
  //     LEGAL here — INV #16 only forbids the clock inside a builder's `build`, not on the
  //     out-of-core telemetry seam. This is the ONE place the wall-clock is stamped (core's
  //     TurnRecord is clock-free). Error-isolated by the runtime's emitTurn (a throwing
  //     subscriber never breaks the turn loop), so the store call needs no extra guard. The
  //     returned thunk is left to GC with the runtime — the process owns it for its lifetime.
  runtime.onTurn((record) => turnLog.store.append({ ...record, ts: Date.now() }));

  // 5c) focus distiller subscription (D5 §3.3 / §8). Each turn's TurnRecord is folded
  //     into the working-state block via the app-only `focus.record` command, routed
  //     through Operations so it re-enters the chokepoint + PolicyEngine (no bypass, INV
  //     #11). The TurnRecord carries `wake_event`, so this ONE call sets focus + wake
  //     reason + outcome together — no separate wake hook needed. invoker:'app' is the
  //     deterministic, runtime-fired distiller lane (the `set_goal` gate bars 'app' for
  //     intent, but `record` is app-only by design). Fire-and-forget with a `.catch`:
  //     D5's A1 explicitly allows ⑤ to be ≥1 turn stale (hence the staleness cue +
  //     degrade in the working-state block), so a dropped/failed distill never breaks the
  //     turn loop — the verbatim recent window stays the correctness floor (§3.2). NOT
  //     wired in core: core must never name an app command (it stays app-agnostic).
  runtime.onTurn((record) => {
    void operations
      .invoke_command('focus.record', { turn_record: record }, { invoker: 'app' })
      .catch(() => undefined);
  });

  // 5d) actions ledger subscriptions (actions-app §2.2 / §9). Two telemetry channels feed
  //     the unified action/observation ledger, both routed through the app-only
  //     `actions.record` command so they re-enter Operations + PolicyEngine (no bypass, INV
  //     #11) — the focus-distiller pattern. The ledger is a dumb sink; the agent cannot forge
  //     it (`record` is invoker:'app' only).
  //
  //     RECURSION-FREE (hard constraint, §2.2): `onCommand` fires ONLY inside the runtime's
  //     private invokeCommand (the agent lane). `actions.record` (invoker:'app') reaches the
  //     system via Operations.invoke_command DIRECTLY, which never traverses invokeCommand →
  //     never emits onCommand → no loop. (A no-recursion test guards this.)
  //
  //     `inputHook`: connect the registry's generic `report_input` seam (an app's
  //     `ctx.report_input(d)`) to the runtime's `onInput` emit. Until this is set, an app's
  //     report_input is inert — so this is the wiring that turns messages.ingest's report into
  //     an onInput event. Mirrors the wakeHook late-injection, but drives a pure telemetry emit.
  registry.inputHook = (d) => runtime.emitInput(d);

  //     onCommand → actions.record(kind:'command'). Stamp the wall-clock `ts` HERE at the
  //     subscription boundary as an ISO string (the clock is legal on the out-of-core
  //     telemetry seam — INV #16 only forbids it inside a builder's build; matches the
  //     string `ts` the record command + ActionLogRecord expect, and the messages ingest
  //     `ts` format, so command + input rows share one timestamp shape). Fire-and-forget +
  //     `.catch` so a record failure never breaks the turn loop.
  runtime.onCommand((e) => {
    void operations
      .invoke_command(
        'actions.record',
        { kind: 'command', ...e, ts: new Date().toISOString() },
        { invoker: 'app' },
      )
      .catch(() => undefined);
  });

  //     onInput → actions.record(kind:'input'). The InputDescriptor already carries its `ts`
  //     (stamped at the ingest handler, §3.3) — do NOT re-stamp here. Fire-and-forget + `.catch`.
  runtime.onInput((d) => {
    void operations
      .invoke_command('actions.record', { kind: 'input', ...d }, { invoker: 'app' })
      .catch(() => undefined);
  });

  // 6) Wake seam: a messages.ingest → ctx.wake → on_wake runs the turn loop. We chain
  //    each wake into a serialized tail so the CLI can await "all turns settled" after a
  //    submit (the wake itself stays fire-and-forget for the App, §8.2). on_wake's own
  //    re-entrancy guard already ignores a wake that arrives mid-loop; chaining here makes
  //    the COMPLETION observable to CliChannel.submit (awaitTurnsSettled).
  //    A `mutating` flag lets a hot-uninstall hold the safe window: while it is set,
  //    incoming wakes are PARKED in `parkedWakes` (not dropped, not run concurrently)
  //    and replayed once the mutation completes — so no turn starts mid-registry-edit
  //    (INV #1: never change the builder index / tree while a render is in flight).
  let turnTail: Promise<void> = Promise.resolve();
  let mutating = false;
  const parkedWakes: import('@block-agent/core/core/types.js').WakeEvent[] = [];
  registry.wakeHook = (event) => {
    if (mutating) {
      parkedWakes.push(event);
      return;
    }
    turnTail = turnTail.then(() => runtime.on_wake(event)).catch(() => undefined);
  };
  turnBarriers.set(runtime, () => turnTail);

  // 7) Seed each app's projection blocks into the tree so they render from turn 1.
  //    The Renderer only renders block-name nodes present in the tree, and the apps
  //    never create their builder-output nodes themselves; without this the agent's
  //    FIRST prompt is empty — even its pinned agent_identity:identity (its identity +
  //    operating constraints). We apply the placeholders through Operations.apply(
  //    invoker=app, trust=trusted), so the chokepoint + PolicyEngine still run (no
  //    bypass, §9.1); each builder overwrites its block from state on every render.
  //    Parent = ROOT_NAME (the empty-tree root core:root). The explicit `trust:'trusted'`
  //    is required by apply()'s fail-closed default (task#10): this is the TRUSTED system
  //    seed (it may write pinned system blocks like agent_identity:identity), so it opts
  //    into full trust explicitly — an unstamped app call now falls to the sandboxed lane.
  await registry.seedProjectionBlocks(
    (name) => operations.has(name),
    (ops) => operations.apply(ops, { invoker: 'app', trust: 'trusted' }),
    // CM-4: seed under the runtime's ACTUAL tree root (not seedProjectionBlocks's
    // `core:root` default), so the runtime's bookkeeping blocks — registered during the
    // AgentRuntime ctor above — attach to the live root and actually render. Here
    // runtime.root === ROOT_NAME (the empty-tree `core:root`), but reading it off the
    // runtime keeps seed correct if the root ever diverges (matches index.ts:141).
    runtime.root,
  );

  // 8) Apply the launcher's non-file app-config overrides through the chokepoint as
  //    invoker=user (the only sanctioned runtime retune path; design §3). A failure
  //    here is non-fatal — the file seed / defaults still hold.
  await applyAppConfigOverrides(operations, config);

  // 9) HotMutator (v1: hot-UNINSTALL only; hot-install is phase 2). Removes an app at
  //    runtime without a restart, inside a safe window so an in-flight turn never sees
  //    the registry / tree change mid-render (lifecycle design §5). Sequence:
  //      a) await all queued turns settle, then assert runtime is idle (else 'busy');
  //      b) set `mutating` so wakeHook parks new wakes for the duration;
  //      c) unseedProjectionBlocks → soft-delete the app's projection nodes through
  //         Operations (chokepoint, invoker=app — no bypass, INV #5 archival delete);
  //      d) dispose_app → run on_uninstall THROUGH the AppHost carrier (graceful
  //         teardown only; never deletes durable data, INV #5), THEN forget → drop
  //         the builder index + install record. Split so the hook runs via the
  //         carrier and the index drop is a separate step — no uninstall→dispose→
  //         uninstall recursion (UH-1 AppHost, impl-spec §3.2/§4);
  //      e) rebuild currentToolCatalog so the agent stops seeing the app's commands;
  //      f) clear `mutating` and replay any parked wakes.
  const hotUninstall = async (app_id: string): Promise<HotUninstallResult> => {
    if (registry.get(app_id) === null) return { ok: false, reason: 'not_installed' };
    // (a) safe window: let queued turns finish, then require idle.
    await awaitTurnsSettled(runtime);
    if (runtime.state.kind !== 'idle') return { ok: false, reason: 'busy' };

    mutating = true;
    try {
      // (c) remove projection-block nodes through the chokepoint (BEFORE uninstall, so
      //     the app's builders are still indexed and their output names resolvable).
      const removed = await registry.unseedProjectionBlocks(
        app_id,
        (name) => operations.has(name),
        // trust:'trusted' — trusted system unseed (soft-delete of projection nodes
        // through the chokepoint); required by apply()'s fail-closed default (task#10).
        (ops) => operations.apply(ops, { invoker: 'app', trust: 'trusted' }),
      );
      // (d) run on_uninstall through the carrier (AppHost.dispose), THEN drop the
      //     registry index + record. Two steps, never registry.uninstall, so the
      //     carrier teardown cannot recurse into an index-dropping path.
      await registry.dispose_app(app_id);
      registry.forget(app_id);
      // (e) rebuild the advertised command catalog (app's commands now gone).
      currentToolCatalog = buildToolCatalog(registry);
      return { ok: true, removed_blocks: removed };
    } catch (err) {
      return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
    } finally {
      // (f) reopen the wake gate and replay anything parked during the mutation.
      mutating = false;
      const replay = parkedWakes.splice(0, parkedWakes.length);
      for (const event of replay) {
        turnTail = turnTail.then(() => runtime.on_wake(event)).catch(() => undefined);
      }
    }
  };

  return {
    operations,
    renderer,
    runtime,
    registry,
    messages,
    provider,
    provider_id: provider.id,
    hotUninstall,
    ...(config.config_path !== undefined ? { config_path: config.config_path } : {}),
    ...(config.storage_dir !== undefined ? { storage_dir: config.storage_dir } : {}),
    ...(config.allow_purge !== undefined ? { allow_purge: config.allow_purge } : {}),
    // welcome is always defined after loadConfig (DEFAULTS.welcome = { cube: true });
    // fall back to the default if for any reason config.welcome is absent.
    welcome: config.welcome ?? { cube: true },
  };
}

/**
 * installEnabledApps — the single id→manifest install mapping shared by boot (here)
 * and any future hot-install path (lifecycle design §6.3 / DR-L2). For each app the
 * config enables, construct its manifest and `registry.install` it. Returns the
 * MessagesApp handle (or null when messages is disabled) so the caller can wire
 * `onReply` (reply=Option B, §6) — it is the one app whose live instance the CLI needs.
 *
 * Keeping this as ONE function (not 5 inline `if`s in launch + a second copy in a hot
 * installer) means the boot order, the storage-dir convention, and the memory_letta
 * widening cast all live in exactly one place. `base` is the apps storage root
 * (`.block-agent/apps`).
 */
function installEnabledApps(
  config: LauncherConfig,
  registry: AppRegistry,
  base: string,
): { messages: MessagesApp | null } {
  let messages: MessagesApp | null = null;

  if (config.apps.agent_identity.enabled) {
    registry.install(makeAgentIdentityApp(identityState(config)));
  }
  if (config.apps.messages.enabled) {
    messages = new MessagesApp({ dir: join(base, 'messages'), configBase: base });
    registry.install(messages.manifest());
  }
  if (config.apps.tools.enabled) {
    registry.install(new ToolsApp(base).manifest());
  }
  // Built-in memory (core; zero dependency). State-driven projection like tools, so
  // seedProjectionBlocks covers its `memory:*` blocks. Char limits / recall limit are
  // seeded into the app's config (file seed + launcher overrides).
  if (config.apps.memory.enabled) {
    registry.install(new MemoryApp({ dir: join(base, 'memory'), configBase: base }).manifest());
  }
  // actions (built-in; core, zero dependency). The unified action/observation ledger
  // (actions-app §3): a bounded `actions:recent` projection + a full off-tree jsonl audit
  // under `<base>/actions/`. Default-ON like memory/tools — it takes over the display role
  // of tools:recent + runtime:command_error. The two telemetry feeds (onCommand / onInput)
  // are subscribed near the runtime construction (below); runtime uninstall is guarded (F1,
  // commands.ts). `base` is the APPS_DIR root (the ActionsApp ctor appends `actions/`).
  if (config.apps.actions.enabled) {
    registry.install(new ActionsApp(base).manifest());
  }
  // memory_letta (external Letta backend; default-disabled). Its SDK lives ONLY in
  // @block-agent/app-memory_letta — core never imports it (DR-M4). base_url comes from
  // config; the API key is read from LETTA_API_KEY env inside the store, never here.
  if (config.apps.memory_letta.enabled) {
    const lettaOpts =
      config.apps.memory_letta.base_url !== undefined
        ? { baseUrl: config.apps.memory_letta.base_url }
        : {};
    registry.install(
      new MemoryLettaApp(lettaOpts).manifest() as Parameters<typeof registry.install>[0],
    );
  }
  // task (built-in; core, zero dependency). Local jsonl store like memory, so
  // seedProjectionBlocks covers its `task:*` block. It PROVIDES the `task_count`
  // contract (manifest `provides`, via `count`) — registered above so the bind resolves.
  if (config.apps.task.enabled) {
    registry.install(new TaskApp({ dir: join(base, 'task'), configBase: base }).manifest());
  }
  // stats (built-in; core, default-disabled). A pure CONSUMER (no store): its manifest
  // `consumes` message_count + task_count; the runtime's consume-refresh pass folds the
  // merged counts into its state each render. Install order is irrelevant for binding
  // (the registry derives the provider table over all installed manifests), but it
  // installs LAST so the providers it consumes are already present at first refresh.
  if (config.apps.stats.enabled) {
    registry.install(new StatsApp({ configBase: base }).manifest());
  }
  // Phase C platform-service proxies (im/oa/task). DEFAULT-OFF: each projects a BlockAI-team
  // service over the network and must not connect on a default boot. Their fetch/ws clients are
  // isolated inside the app workspaces (cli runtime dep, core devDep) — core's runtime closure
  // stays empty (DR-M4, same as memory_letta). Each reads its endpoint + token from ENV inside
  // its own client (IM/OA/TASK_SERVICE_URL + _SERVICE_TOKEN; token env-only) — launch passes no
  // credential. Unconfigured → an empty projection, never a throw. oa_proxy PROVIDES org_directory
  // (registered above); im_proxy + task_proxy CONSUME it (assignee/from → name) — install order is
  // irrelevant (the registry derives the provider table over all installed manifests).
  if (config.apps.im_proxy.enabled) {
    // `dir` under storage_dir (D2d) — the durable per-conv backfill cursor (cursors.jsonl)
    // lives at `<base>/im_proxy/`, like every sibling durable app (messages/memory/task).
    // Without it the cursor would land at cwd-relative `.block-agent/...` (leaking into the
    // repo) AND two co-located fleet instances would share ONE cursor file → cross-instance
    // cursor bleed. The endpoint/token still come from ENV inside the app's client.
    registry.install(
      new ImProxyApp({ dir: join(base, 'im_proxy') }).manifest() as Parameters<
        typeof registry.install
      >[0],
    );
  }
  if (config.apps.oa_proxy.enabled) {
    registry.install(new OaProxyApp({ configBase: base }).manifest() as Parameters<typeof registry.install>[0]);
  }
  if (config.apps.task_proxy.enabled) {
    registry.install(new TaskProxyApp().manifest() as Parameters<typeof registry.install>[0]);
  }

  return { messages };
}

/**
 * The full capability set a TRUSTED app may declare — the built-in capability
 * vocabulary (policy.ts `CAP`). Trusted (built-in / audited in-process) apps face
 * no real ceiling, so this is the whole set and they never trip an install warning.
 */
const TRUSTED_CEILING: ReadonlySet<string> = new Set(Object.values(CAP));

/**
 * The capability set an UNTRUSTED (agent_authored / sandboxed, cross-process) app
 * may declare (UH-2 §3.8 / §5b.6). It EXCLUDES the escalation trio — credential
 * plaintext, physical delete, pinned modify — so a sandboxed app that declares one
 * is rejected at install. The included caps mirror the PolicyEngine `sandboxed`
 * row's granted ∪ needs_approval (block:write granted; dangerous + net:http to
 * approval), so the install-time ceiling and the run-time policy agree exactly: an
 * untrusted app can only ever DECLARE caps it could also exercise (gated).
 */
const SANDBOXED_CEILING: ReadonlySet<string> = new Set([
  CAP.block_write,
  CAP.net_http,
  CAP.dangerous,
]);

/**
 * capabilityCeilingFor — the `AppRegistry.ceiling_resolver` (UH-2 §3.8). Maps an
 * authorship trust LEVEL to its allowed capability NAME set. Pure + O(1) (returns a
 * prebuilt Set), so it preserves INV #19. `agent_authored` is the untrusted lane;
 * any other level (`trusted`) gets the full set.
 */
function capabilityCeilingFor(level: AppTrustLevel): ReadonlySet<string> {
  return level === 'agent_authored' ? SANDBOXED_CEILING : TRUSTED_CEILING;
}

/**
 * buildToolCatalog — enumerate the agent-invokable commands across all installed apps
 * as the `SendOpts.tools` the runtime advertises to the provider each turn (native
 * tool dispatch, §11.1). This mirrors context_view.appsView's command enumeration:
 * each command factory is called with its manifest's initial_state to read the
 * CommandManifest's name/description/args_schema.
 *
 * USER-ONLY commands — those whose `allowed_invokers` is set and excludes `'agent'`
 * (e.g. agent_identity.set, messages.set_config, tools.set_config) — are filtered OUT:
 * the PolicyEngine denies them to the agent at step 0 regardless, so advertising them
 * would only invite refused calls and waste a turn. Commands are static per install in
 * v3.0, so this is computed once at launch (the runtime holds it behind a thunk so a
 * future dynamic command set still works).
 */
function buildToolCatalog(registry: AppRegistry): ToolCatalog {
  const tools: ToolCatalog = [];
  for (const manifest of registry.list()) {
    for (const factory of manifest.commands) {
      const cmd = factory(manifest.initial_state);
      const agentAllowed =
        cmd.allowed_invokers === undefined || cmd.allowed_invokers.includes('agent');
      if (!agentAllowed) continue;
      tools.push({
        name: `${manifest.id}.${cmd.name}`,
        description: cmd.description,
        ...(cmd.args_schema !== undefined ? { args_schema: cmd.args_schema } : {}),
      });
    }
  }
  return tools;
}

/**
 * identityState — fold the launcher's agent_identity config into the app's
 * initial_state. Any of role/persona/instructions the operator omits falls back to the
 * app's own DEFAULT_IDENTITY (makeAgentIdentityApp's default arg), so we only override
 * the keys actually supplied. All three keys are required by the app schema, so when
 * ANY is supplied we must fill the rest from the app defaults — we let
 * makeAgentIdentityApp default when none is set, and supply a complete triple otherwise.
 */
function identityState(config: LauncherConfig): IdentityState {
  const { role, persona, instructions } = config.apps.agent_identity;
  if (role === undefined && persona === undefined && instructions === undefined) {
    return DEFAULT_IDENTITY;
  }
  return {
    role: role ?? DEFAULT_IDENTITY.role,
    persona: persona ?? DEFAULT_IDENTITY.persona,
    instructions: instructions ?? DEFAULT_IDENTITY.instructions,
  };
}

/** The same safe default the agent_identity app ships (kept in sync; schema-valid). */
const DEFAULT_IDENTITY: IdentityState = {
  role: 'a block-agent assistant',
  persona: 'concise, direct, and honest',
  instructions: 'Help the user accomplish their task.',
};

/**
 * applyAppConfigOverrides — push the launcher's numeric/list knobs that have no
 * constructor path (messages token budget / display count, tools history count) through
 * the user-only `*.set_config` commands as invoker=user. This is the sanctioned runtime
 * retune path (design §3) and keeps the chokepoint intact: the CLI never writes state
 * directly. File-seeded config and compiled defaults remain the fallback; an override
 * that fails policy/validation is ignored (best-effort, never throws).
 */
async function applyAppConfigOverrides(
  operations: Operations,
  config: LauncherConfig,
): Promise<void> {
  const user = { invoker: 'user' as const };

  if (config.apps.messages.enabled) {
    const m = config.apps.messages;
    const patch: Record<string, number> = {};
    if (m.max_history_tokens !== undefined) patch['max_history_tokens'] = m.max_history_tokens;
    if (m.compression_threshold !== undefined)
      patch['compression_threshold'] = m.compression_threshold;
    if (m.display_count !== undefined) patch['display_count'] = m.display_count;
    if (Object.keys(patch).length > 0) {
      await operations.invoke_command('messages.set_config', patch, user).catch(() => undefined);
    }
  }

  // tools no longer has a set_config command: its recent-N display moved to the
  // `actions` app, so there is no tool_history_count to seed. (`enabled_tools` is a
  // CLI-only config that is not applied via a runtime command.)

  if (config.apps.memory.enabled) {
    const m = config.apps.memory;
    const patch: Record<string, number> = {};
    if (m.notes_char_limit !== undefined) patch['notes_char_limit'] = m.notes_char_limit;
    if (m.user_char_limit !== undefined) patch['user_char_limit'] = m.user_char_limit;
    if (m.recall_limit !== undefined) patch['recall_limit'] = m.recall_limit;
    if (Object.keys(patch).length > 0) {
      await operations.invoke_command('memory.set_config', patch, user).catch(() => undefined);
    }
  }

  if (config.apps.memory_letta.enabled && config.apps.memory_letta.recall_limit !== undefined) {
    await operations
      .invoke_command(
        'memory_letta.set_config',
        { recall_limit: config.apps.memory_letta.recall_limit },
        user,
      )
      .catch(() => undefined);
  }

  // task: the open-task projection cap. The CLI's `list_limit` knob maps to the app's
  // user-only `task.set_config({list_limit})`; absent → the app's seed/default holds.
  if (config.apps.task.enabled && config.apps.task.list_limit !== undefined) {
    await operations
      .invoke_command('task.set_config', { list_limit: config.apps.task.list_limit }, user)
      .catch(() => undefined);
  }

  // stats: whether the `stats:summary` block renders at all. Pushed via the app's
  // user-only `stats.set_config({show_block})`; absent → the app's seed/default holds.
  if (config.apps.stats.enabled && config.apps.stats.show_block !== undefined) {
    await operations
      .invoke_command('stats.set_config', { show_block: config.apps.stats.show_block }, user)
      .catch(() => undefined);
  }
}

/**
 * buildProviderOrThrow — construct the ModelProvider for the resolved config (design
 * §7), reading the API key from env and front-loading the no-key check. anthropic and
 * openai-compat need a key (unless --dry-run picks mock); mock never does. Throws
 * MissingProviderKeyError when a needed key is absent so main.tsx prints guidance and
 * exits before the UI mounts. The key is passed to the constructor, never echoed.
 */
function buildProviderOrThrow(config: LauncherConfig): ModelProvider {
  const { kind, model, base_url, thinking_format } = config.provider;
  switch (kind) {
    case 'anthropic': {
      const api_key = process.env['ANTHROPIC_API_KEY'];
      if (!api_key) throw new MissingProviderKeyError('anthropic', 'ANTHROPIC_API_KEY');
      return new AnthropicProvider({
        model,
        api_key,
        ...(base_url !== undefined ? { base_url } : {}),
      });
    }
    case 'openai-compat': {
      const api_key = process.env['OPENAI_API_KEY'];
      // openai-compat endpoints almost always need a key (OpenAI/DeepSeek); local
      // endpoints (Ollama/LM Studio) may not, but we cannot tell from here, so we
      // require one for safety — operators run those via --dry-run or set a dummy key.
      if (!api_key) throw new MissingProviderKeyError('openai-compat', 'OPENAI_API_KEY');
      if (base_url === undefined)
        throw new Error(
          "Provider 'openai-compat' requires a base_url (set --base-url or OPENAI_BASE_URL).",
        );
      return new OpenAiCompatibleProvider({
        base_url,
        model,
        api_key,
        thinking_format: thinking_format ?? 'none',
      });
    }
    case 'mock': {
      // Offline / --dry-run. With im_proxy enabled, use the CONTEXT-REACTIVE im-echo mock: it
      // reads the rendered prompt each turn and replies (`im_proxy.reply`) to any inbound IM
      // message it sees, so the no-key dry-run exercises the full human→IM→im_proxy→agent→
      // reply→IM vertical (it must react to context, not a fixed script — the agent burns turns
      // before the message arrives, which would exhaust a canned queue). Otherwise the plain
      // scripted mock that replies once then ends the loop (a generic dry-run smoke).
      // Task WRITE vertical (platform Phase D2b): with task_proxy enabled the offline mock is the
      // CONTEXT-REACTIVE task-create mock — it reads the rendered prompt each turn and, on an
      // inbound IM directive `create task: <title>` in the im_proxy:chat block, emits a
      // `task_proxy.add` tool_call, exercising the human→IM→im_proxy→agent→task_proxy→Task-service
      // WRITE path with no key. Checked BEFORE im_proxy (more specific): the vertical enables BOTH
      // im_proxy (the directive arrives via IM) and task_proxy (the action goes to Task), so a
      // task-directive run must select this mock, not the im-echo one. D1/D2a enable im_proxy ONLY,
      // so they still resolve to the im-echo mock below (behavior unchanged). EXPLICIT conjunction
      // (im_proxy AND task_proxy): TaskCreateMock's only directive source is the im_proxy:chat
      // block, so a task_proxy-only config (no im_proxy) has nothing to react to — it must fall
      // through to the plain mock, not spin emptily on a missing chat source.
      if (config.apps.im_proxy.enabled && config.apps.task_proxy.enabled) {
        return new TaskCreateMockProvider();
      }
      // OA NAME-RESOLUTION vertical (platform Phase D2c): with im_proxy AND oa_proxy enabled (and
      // NOT task_proxy — that is the more specific im&&task vertical, checked above), the offline
      // mock is the CONTEXT-REACTIVE oa-resolve mock. It reads the rendered prompt each turn and,
      // for an inbound IM message, replies with the peer's OA-RESOLVED display name (read out of the
      // `# Chat — dm <display>` header, which im_proxy resolves from oa_proxy's `org_directory`
      // projection of the live OA service) folded with the inbound nonce — exercising the
      // human→IM→im_proxy→agent→reply path AND proving OA→oa_proxy→org_directory→im_proxy name
      // resolution, with no key. EXPLICIT conjunction (im_proxy AND oa_proxy): without oa_proxy the
      // chat header carries no resolved name, so a config missing oa_proxy must fall through to the
      // plain im-echo mock below rather than spin with no OA projection to react to.
      if (config.apps.im_proxy.enabled && config.apps.oa_proxy.enabled) {
        return new OaResolveMockProvider();
      }
      if (config.apps.im_proxy.enabled) {
        return new ImEchoMockProvider();
      }
      return new MockProvider([
        {
          thinking: ['(mock provider) acknowledging the message'],
          tool_calls: [
            { id: 'mock-1', name: 'messages.reply', args: { content: '(mock) hello from the dry-run provider' } },
          ],
        },
        {},
      ]);
    }
  }
}
