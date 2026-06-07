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
import { PolicyEngine } from '@block-agent/core/core/policy.js';
import { Renderer } from '@block-agent/core/core/renderer.js';
import { AppRegistry } from '@block-agent/core/app/registry.js';
import { MESSAGE_COUNT, TASK_COUNT } from '@block-agent/core/app/contracts.js';
import { AgentRuntime, type ToolCatalog } from '@block-agent/core/runtime/agent_runtime.js';
import { AnthropicProvider } from '@block-agent/core/provider/anthropic.js';
import { OpenAiCompatibleProvider } from '@block-agent/core/provider/openai_compat.js';
import { MockProvider } from '@block-agent/core/provider/mock.js';
import { makeAgentIdentityApp } from '@block-agent/core/apps/agent_identity.js';
import { MessagesApp } from '@block-agent/core/apps/messages.js';
import { ToolsApp } from '@block-agent/core/apps/tools.js';
import { MemoryApp } from '@block-agent/core/apps/memory.js';
import { TaskApp } from '@block-agent/core/apps/task.js';
import { StatsApp } from '@block-agent/core/apps/stats.js';
import { MemoryLettaApp } from '@block-agent/memory-letta/memory_letta_app.js';

import type { BlockName } from '@block-agent/core/core/types.js';
import type { ModelProvider } from '@block-agent/core/provider/types.js';
import type { IdentityState } from '@block-agent/core/apps/agent_identity.js';
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

  // 2a) Register the built-in scalar-count contracts (R-6) BEFORE installing any app,
  //     so the assemble-time provides/consumes check can resolve each contract NAME to
  //     its ContractDef (output_schema ⊨ via.result_schema, R-1) the moment a provider
  //     (messages→message_count, task→task_count) or consumer (stats) installs. Register
  //     before install or the check sees an unknown contract and the binding is silently
  //     dropped. App-defined contracts (none built-in beyond these two) would register here too.
  registry.registerContract(MESSAGE_COUNT);
  registry.registerContract(TASK_COUNT);

  const base = appsBaseDir(config);
  const { messages } = installEnabledApps(config, registry, base);

  // 3) PolicyEngine wired to the command capabilities + allowed_invokers, then
  //    Operations (the single mutation chokepoint, with the engine inside).
  const policy = new PolicyEngine({
    capability_resolver: (full_name) => registry.resolve_command(full_name)?.capabilities ?? [],
    allowed_invokers_resolver: (full_name) =>
      registry.resolve_command(full_name)?.allowed_invokers ?? null,
  });
  const operations = new Operations(tree, policy, registry);

  // Route cross-app invoke_command through Operations so it re-enters PolicyEngine
  // (INV #11), exactly as a full boot wires it.
  registry.commandRouter = (full_name, args, invoker) =>
    operations.invoke_command(full_name, args, invoker);

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
  //    invoker=app), so the chokepoint + PolicyEngine still run (no bypass, §9.1); each
  //    builder overwrites its block from state on every render. Parent = ROOT_NAME (the
  //    empty-tree root core:root).
  await registry.seedProjectionBlocks(
    (name) => operations.has(name),
    (ops) => operations.apply(ops, { invoker: 'app' }),
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
  //      d) registry.uninstall → drop the builder index + run on_uninstall (graceful
  //         teardown only; never deletes durable data, INV #5);
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
        (ops) => operations.apply(ops, { invoker: 'app' }),
      );
      // (d) drop the registry index + run on_uninstall (graceful teardown).
      registry.uninstall(app_id);
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
  // memory_letta (external Letta backend; default-disabled). Its SDK lives ONLY in
  // @block-agent/memory-letta — core never imports it (DR-M4). base_url comes from
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

  return { messages };
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

  if (config.apps.tools.enabled && config.apps.tools.tool_history_count !== undefined) {
    await operations
      .invoke_command(
        'tools.set_config',
        { tool_history_count: config.apps.tools.tool_history_count },
        user,
      )
      .catch(() => undefined);
  }

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
      // Offline / --dry-run: a scripted provider that replies once then ends the loop,
      // so a no-key, no-network smoke run still exercises the full turn loop.
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
