/**
 * cli/types.ts — the CLI module's internal contracts (architect-owned).
 *
 * These are the seams the two wave-2 implementers build against:
 *   - impl-cli-logic owns config.ts / launch.ts / cli_channel.ts / commands.ts /
 *     context_view.ts and PRODUCES a `LaunchedAgent` + the `SlashCommand` registry.
 *   - impl-cli-ui owns ui/*.tsx + main.tsx and CONSUMES `LaunchedAgent` + the
 *     registry, rendering with Ink/React.
 *
 * Design: ai_com/block-agent-cli-design.md (§3 LauncherConfig, §5 SlashCommand,
 * §6 reply=onReply, the launcher returns a LaunchedAgent handle). House style: the
 * CLI is a CLI ChannelAdapter (invoker=user, §9.5); actors get role names
 * (`CliChannel`), config/handle types stay descriptive. core types are imported via
 * the `@block-agent/core/*` subpath exports — NodeNext requires the `.js` extension.
 *
 * IMPORTANT (dependency direction): this file imports core types only as TYPES
 * (`import type`). Ink/React never appear here — the contract is UI-agnostic so
 * `cli_channel.ts` / `launch.ts` stay unit-testable without mounting React.
 */

import type { Operations, Renderer, InvokerContext, AgentState } from '@block-agent/core/core/types.js';
import type { AppRegistry } from '@block-agent/core/app/registry.js';
import type { AgentRuntime } from '@block-agent/core/runtime/agent_runtime.js';
import type { ModelProvider } from '@block-agent/core/provider/types.js';
import type { MessagesApp } from '@block-agent/app-messages/manifest.js';

// ============================================================================
// LauncherConfig — the single source of truth `launch()` consumes (design §3)
// ============================================================================

/** Which provider backend to construct (design §7). */
export type ProviderKind = 'anthropic' | 'openai-compat' | 'mock';

/**
 * The provider's thinking_format (only meaningful for openai-compat; anthropic's
 * adapter is fixed). Mirrors ModelCapabilities['thinking_format'] in core; declared
 * here as a string union so the CLI config does not import a value from core.
 */
export type ThinkingFormat =
  | 'anthropic_blocks'
  | 'openai_reasoning'
  | 'xml_think_tag'
  | 'xml_thinking_tag'
  | 'none';

/** Provider section of the launcher config. API key is NOT here — read from env. */
export interface ProviderConfig {
  kind: ProviderKind;
  /** e.g. 'claude-opus-4-7' / 'deepseek-reasoner'. */
  model: string;
  /** openai-compat endpoint; or an anthropic base_url override. */
  base_url?: string;
  /** openai-compat only: selects the matching ThinkingAdapter. */
  thinking_format?: ThinkingFormat;
}

/** agent_identity seed (→ the app's initial_state); all optional, app has defaults. */
export interface IdentityConfig {
  enabled: boolean;
  role?: string;
  persona?: string;
  instructions?: string;
}

/** messages app config knobs (non-file overrides; file seed still honored). */
export interface MessagesConfig {
  enabled: boolean;
  max_history_tokens?: number;
  compression_threshold?: number;
  display_count?: number;
}

/**
 * `task` app config knobs (§4.2). Enabled by default (zero dependency, local jsonl
 * store like `memory`). The agent can never retune these at runtime
 * (`task.set_config` is user-only), so the operator pins them here / in the file.
 */
export interface TaskConfig {
  enabled: boolean;
  /**
   * Max OPEN tasks the `task:list` projection renders (bounded window). Maps to the
   * task app's own `list_limit` knob (retuned at runtime via the user-only
   * `task.set_config`); a non-file override, the app's config seed is the fallback.
   */
  list_limit?: number;
}

/**
 * `stats` app config knobs (§4.4). DISABLED by default: it is a pure consumer
 * (message_count + task_count) whose `stats:summary` block is hidden until the
 * operator turns it on AND `show_block` is true (the builder renders null otherwise).
 */
/**
 * base app launcher toggle (formerly `actions`). The app's own ledger knobs (window_size /
 * command_detail / input_detail / char limits) live in the app's seed config, not here —
 * this only gates boot install. Trusted, default-ON; runtime uninstall is guarded (F1),
 * config-level disable at boot is allowed.
 *
 * `enabled_tools` — the enabled-tool subset for the built-in tool commands (read_file /
 * grep / bash / http_request), merged in from the former `tools` app. Absent → all four
 * builtins enabled. Config-seeded only (the base app reads it at construction); the
 * agent can never retune it.
 */
export interface BaseConfig {
  enabled: boolean;
  /** Subset of builtin tools to enable; absent → all enabled. */
  enabled_tools?: string[];
}

export interface StatsConfig {
  enabled: boolean;
  /**
   * Whether `stats:summary` renders its block at all (the builder returns null when
   * false — the §4.4 default). A non-file override; the app's own config seed is the
   * fallback. User-only at runtime (`stats.set_config`).
   */
  show_block?: boolean;
}

/** Welcome screen config knobs (cube animation toggle). */
export interface WelcomeConfig {
  /** When true (default), the rotating cube is rendered. `--no-cube` sets this to false. */
  cube: boolean;
}

/**
 * Built-in `memory` app config knobs (non-file overrides; the app's own config.json
 * file seed is still honored). All optional — the app ships safe defaults (Hermes char
 * limits). The agent can never retune these at runtime (`memory.set_config` is
 * user-only), so the operator sets them here / in the file once.
 */
export interface MemoryConfig {
  enabled: boolean;
  /** Hard char cap on the agent-notes projection window (default 2200). */
  notes_char_limit?: number;
  /** Hard char cap on the user-profile projection window (default 1375). */
  user_char_limit?: number;
  /** Max records a recall returns (result-set cap, default 8). */
  recall_limit?: number;
}

/**
 * `memory_letta` app config knobs. DISABLED by default: it needs an external Letta
 * server, so a default boot must not try to connect to one. The API key is NOT here —
 * it is read from `LETTA_API_KEY` env ONLY (the ANTHROPIC_API_KEY rule). `base_url`
 * resolves flag > file > env (`LETTA_BASE_URL`) > the app default `http://localhost:8283`.
 */
export interface MemoryLettaConfig {
  enabled: boolean;
  /** Letta server base URL (default `http://localhost:8283`). */
  base_url?: string;
  /** Max archival search results per recall (default 8). */
  recall_limit?: number;
}

/**
 * Platform-service proxy app config — shared by `im_proxy` / `oa_proxy` / `task_proxy`
 * (Phase C). ALL DISABLED by default: each projects a BlockAI-team service (IM/OA/Task)
 * and must not try to connect on a default boot. This config carries ONLY the enable gate;
 * the connection is configured by ENV, read inside each proxy's client uniformly — the
 * endpoint `IM_SERVICE_URL` / `OA_SERVICE_URL` / `TASK_SERVICE_URL` and the bearer token
 * `IM_SERVICE_TOKEN` / `OA_SERVICE_TOKEN` / `TASK_SERVICE_TOKEN` (the token is env-ONLY, the
 * ANTHROPIC_API_KEY rule — never config/flag/log). `task_proxy` needs a THIRD required var,
 * `TASK_SERVICE_SELF` = this agent's OA principal_id (for `task.claim` self-assign + the `mine`
 * block filter); if URL/TOKEN/SELF is incomplete, task_proxy degrades to a READ-ONLY shell
 * (no net commands) SILENTLY — so a per-instance env set that enables task_proxy must set all
 * three. Unconfigured → the proxy degrades to an empty projection (never throws). (The Phase D
 * platform console injects the per-instance env per process.)
 */
export interface ServiceProxyConfig {
  enabled: boolean;
}

/**
 * LauncherConfig — resolved from flags ⊕ file ⊕ env ⊕ defaults by `loadConfig()`
 * (design §3, precedence highest-wins: flags > file > env > defaults; the config file
 * is authoritative over ambient env vars). Pure data; `launch()` turns it into the
 * live core object graph.
 */
export interface LauncherConfig {
  provider: ProviderConfig;
  apps: {
    agent_identity: IdentityConfig;
    messages: MessagesConfig;
    memory: MemoryConfig;
    /** The unified action/observation ledger + built-in tools (formerly `actions`); enabled by default (runtime uninstall guarded, F1). */
    base: BaseConfig;
    memory_letta: MemoryLettaConfig;
    /** §4.2 task tracker (local jsonl); enabled by default. */
    task: TaskConfig;
    /** §4.4 stats summary (pure consumer); DISABLED by default. */
    stats: StatsConfig;
    /** Phase C platform-service proxies; ALL DISABLED by default (each needs a running service). */
    im_proxy: ServiceProxyConfig;
    oa_proxy: ServiceProxyConfig;
    task_proxy: ServiceProxyConfig;
  };
  /**
   * OPTIONAL operator-supplied contract rebindings (C-API-7). The contract model
   * binds consumers to providers by TYPE (the contract name) via the registry's
   * derived provider table — no hand-written routes are required, so this is empty
   * for every built-in boot. It exists as a forward seam: an operator could pin which
   * provider satisfies a contract when several compete. `loadConfig` parses it
   * defensively (a malformed entry drops out); nothing in the default path reads it.
   */
  contract_bindings?: Record<string, string>;
  /**
   * Base dir for `.block-agent` storage — the per-process `root_dir` (default cwd); apps get
   * an explicit dir derived from it. Resolved by `bootstrap` + `loadConfig` (root-dir-
   * architecture.md §3): always set to the root now, so launch/purge `?? cwd` never fires.
   */
  storage_dir?: string;
  /** Forwarded to AgentRuntime. */
  max_turns_per_wake?: number;
  /**
   * Gate for the destructive `/app purge` command (physical delete of an app's local
   * data). DISABLED by default — the operator must set `allow_purge: true` (file/flag)
   * to even surface the command. Resolved by `loadConfig` and threaded onto
   * `LaunchedAgent.allow_purge`. Nothing else reads it.
   */
  allow_purge?: boolean;
  /**
   * The config file path `loadConfig` actually consulted (the `--config <path>` value
   * or the default `block-agent.config.json`). Threaded onto `LaunchedAgent.config_path`
   * so `/app install|uninstall|swap` write back to the SAME file the operator launched
   * with (not a guessed default). Resolved by `loadConfig`.
   */
  config_path?: string;
  /**
   * Welcome screen config. Optional in LauncherConfig (defaults to `{ cube: true }` in
   * DEFAULTS). Always defined on LaunchedAgent once launch resolves it.
   */
  welcome?: WelcomeConfig;
}

// ============================================================================
// LaunchedAgent — the handle `launch()` returns; what the CLI reads/drives
// ============================================================================

/**
 * LaunchedAgent — the wired core object graph `launch()` hands back. The CLI uses
 * exactly these live references and nothing else:
 *   - operations  — the mutation chokepoint (`messages.ingest` / `invoke_command`,
 *     always invoker=user from the CLI) + `snapshot()` for /context.
 *   - renderer    — `render(snapshot)` for /context and /dump (read-only).
 *   - runtime     — `on_wake(...)` to run a turn; `onThinking(cb)` to stream
 *     reasoning; `state` for /status.
 *   - registry    — `list()` / `resolve_command` / `resolve_builder` for /apps.
 *   - messages    — the MessagesApp instance, for `onReply(cb)` (reply=Option B,
 *     design §6) so the CLI receives agent replies as a push, symmetric to
 *     onThinking. May be null if the messages app was disabled in config.
 *   - provider_id — for /status display (no key/secret ever exposed here).
 *
 * No Ink/React here — this handle is produced by pure `launch.ts`.
 */
export interface LaunchedAgent {
  readonly operations: Operations;
  readonly renderer: Renderer;
  readonly runtime: AgentRuntime;
  readonly registry: AppRegistry;
  readonly messages: MessagesApp | null;
  readonly provider: ModelProvider;
  readonly provider_id: string;
  /**
   * Hot-uninstall a currently-installed app without requiring a restart (v1).
   * Implemented by HotMutator in launch.ts (#5). When absent, appCommand falls back
   * to "write config + prompt restart". Shape per spec §5.
   *
   *   - Returns `{ok:false, reason:'busy'}` when the runtime has in-flight turns.
   *   - Returns `{ok:false, reason:'not_installed'}` when the id is unknown.
   *   - Returns `{ok:true, removed_blocks}` on success.
   */
  hotUninstall?(app_id: string): Promise<HotUninstallResult>;
  /**
   * The config file `launch` was started from (typically the resolved `--config`
   * path or `block-agent.config.json`). `/app install|uninstall|swap` write their
   * `apps.<id>.enabled` patch back to THIS file. Typed replacement for the earlier
   * `_configPath` cast. Absent ⇒ appCommand falls back to the default file name.
   */
  readonly config_path?: string;
  /**
   * Project storage base dir (the resolved `storage_dir`, default cwd). `/app purge`
   * deletes `<storage_dir>/.block-agent/apps/<id>/`. Typed replacement for `_storageDir`.
   */
  readonly storage_dir?: string;
  /**
   * Whether the destructive `/app purge` command is enabled (from config `allow_purge`).
   * Typed replacement for the `_allowPurge` / `_config.allow_purge` casts. Default false.
   */
  readonly allow_purge?: boolean;
  /**
   * Resolved welcome screen config (always present after launch). `cube` controls
   * whether the rotating cube animation renders in WelcomeScreen. Default `{ cube: true }`.
   */
  readonly welcome: WelcomeConfig;
}

// ============================================================================
// CliChannel — the §9.5 CLI ChannelAdapter (invoker=user)
// ============================================================================

/**
 * ReplyEvent — one agent reply observed on the CLI's delivery side. Shape matches
 * what `MessagesApp.onReply` emits (the just-written reply): the assigned id, the
 * content, and the optional reply_to. (reply=Option B, design §6.)
 */
export interface ReplyEvent {
  id: string;
  content: string;
  reply_to?: string;
}

/**
 * CliChannel — the CLI ChannelAdapter at the trust boundary (§9.5). Unlike the
 * abstract ChannelAdapter, the CLI's `receive` is push-driven by the Ink input
 * component and `deliver` pushes into UI state, so this interface is shaped for that:
 *   - `authenticate()` stamps every CLI action as invoker=user.
 *   - `submit(text)` is called by the UI when the user submits a line; the channel
 *     routes it through the Operations chokepoint (`messages.ingest`, invoker=user)
 *     and awaits the resulting turn.
 *   - `onDeliver(cb)` registers the UI's render callback; the channel forwards each
 *     `MessagesApp.onReply` event to it. Returns an unsubscribe thunk.
 * It holds only callbacks (no React import), so it is unit-testable on its own.
 */
export interface CliChannel {
  readonly id: 'cli';
  authenticate(): InvokerContext;
  submit(text: string): Promise<void>;
  onDeliver(cb: (event: ReplyEvent) => void): () => void;
}

// ============================================================================
// SlashCommand — the slash-command registry entry (design §5)
// ============================================================================

/**
 * CtxView — a view payload a slash command pushes to the UI's ContextView component
 * (the abbreviated /context, /apps, /status, /help text, or a /cmd result). Kept a
 * discriminated union so the UI renders each shape deliberately; the exact member
 * fields are owned by impl-cli-logic + impl-cli-ui together (this is the seam).
 *
 * v1 change: the `apps` variant now carries two segments (installed + available) so
 * the /apps panel can show what's running and what can be installed. Action results
 * from /app sub-commands reuse `command_result` / `message` (no new variant needed).
 */
export type CtxView =
  | { kind: 'context'; snapshot_hash: string; segments: SegmentSummary[] }
  | { kind: 'apps'; installed: AppSummary[]; available: AvailableApp[] }
  | { kind: 'status'; runtime_state: AgentState['kind']; provider_id: string; app_count: number; turns: number }
  | { kind: 'command_result'; ok: boolean; text: string }
  | { kind: 'message'; text: string };

/** One abbreviated render segment for the /context view. */
export interface SegmentSummary {
  tier: string;
  bytes: number;
  cache_boundary: boolean;
  preview: string;
}

/** One app's reflection for the /apps installed segment. */
export interface AppSummary {
  id: string;
  version: string;
  blocks: string[];
  /** Full command names `<id>.<cmd>`, each flagged if user-only (allowed_invokers). */
  commands: Array<{ full_name: string; user_only: boolean }>;
}

/**
 * AvailableApp — catalog entry projected for the /apps available segment.
 * Mirrors BuiltinAppEntry shape from app_catalog.ts but defined here as the
 * CtxView-side seam (UI renders it; context_view.ts produces it).
 */
export interface AvailableApp {
  id: string;
  /** One-line Chinese summary (matches BUILTIN_APP_CATALOG[*].summary). */
  summary: string;
  default_enabled: boolean;
  /** External dependency note (e.g. 'Letta server + LETTA_API_KEY'). */
  requires?: string;
}

/**
 * HotUninstallResult — result returned by LaunchedAgent.hotUninstall (defined here
 * so both appCommand [caller] and launch.ts [implementer, #5] share the shape).
 *
 * Designed by spec §5: `ok:false + reason:'busy'` when the runtime had in-flight
 * turns; `ok:true + removed_blocks` on success.
 */
export interface HotUninstallResult {
  ok: boolean;
  /** Present on failure: why uninstall was declined. */
  reason?: 'busy' | 'not_installed' | 'error';
  /** Block names whose nodes were removed (soft-deleted via Operations). */
  removed_blocks?: string[];
  /** Error message when reason='error'. */
  error?: string;
}

/**
 * SetView — the sink a slash command (and the dispatcher) uses to push a view to the
 * UI's ContextView. Shared by SlashCommand.run + DispatchFn so the logic side and the
 * UI side reference one shape (in practice a React `setState`-style setter).
 */
export type SetView = (v: CtxView) => void;

/**
 * SlashCommand — one `/name` entry in the central registry (design §5). `run`
 * receives the live agent, the parsed argv (after the name), and a `setView` sink to
 * push its result to the UI. Local commands only in v3.0 (no model-prompt commands).
 */
export interface SlashCommand {
  /** Without the leading '/'. */
  name: string;
  /** One-line summary for /help. */
  summary: string;
  usage?: string;
  run(agent: LaunchedAgent, argv: string[], setView: SetView): Promise<void> | void;
}

/**
 * DispatchFn — the exact signature of `commands.dispatch` (design §4). The UI calls
 * it for every `/line` the user submits; the dispatcher parses the name, looks it up
 * in SLASH_COMMANDS, and runs it with the live agent + a `setView` sink. Declared here
 * as a contract so impl-cli-logic (which implements `dispatch`) and impl-cli-ui (which
 * calls it from App.tsx) converge with no cast.
 *
 * `line` is the full submitted line INCLUDING the leading '/'.
 */
export type DispatchFn = (agent: LaunchedAgent, line: string, setView: SetView) => Promise<void> | void;

// ============================================================================
// Launch error contract — the no-key graceful path (design §7)
// ============================================================================

/**
 * MISSING_PROVIDER_KEY_CODE — the `code` tag `launch()` throws with when the selected
 * provider needs an API key and env has none. main.tsx recognizes this tag to print
 * the graceful guidance (which env var to set; --provider mock to try offline) and
 * exit non-zero BEFORE mounting the UI (design §7). A contract so impl-cli-logic
 * (throws it) and impl-cli-ui (catches it) agree — no message-regex guessing.
 */
export const MISSING_PROVIDER_KEY_CODE = 'missing_provider_key' as const;

/**
 * MissingProviderKeyError — the tagged error `launch()` throws for the no-key path.
 * Carries `code: 'missing_provider_key'`, the offending `provider_kind`, and the
 * `env_var` the operator should set. `main.tsx` narrows on `err.code === code`.
 */
export interface MissingProviderKeyError extends Error {
  code: typeof MISSING_PROVIDER_KEY_CODE;
  provider_kind: ProviderKind;
  /** The env var to set (e.g. 'ANTHROPIC_API_KEY' / 'OPENAI_API_KEY'). */
  env_var: string;
}

/** Type guard for the no-key launch error (use in main.tsx's catch). */
export function isMissingProviderKeyError(err: unknown): err is MissingProviderKeyError {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === MISSING_PROVIDER_KEY_CODE
  );
}
