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
import type { MessagesApp } from '@block-agent/core/apps/messages.js';

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

/** tools app config knobs. */
export interface ToolsConfig {
  enabled: boolean;
  tool_history_count?: number;
  /** Subset of builtin tools to enable; absent → all enabled. */
  enabled_tools?: string[];
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
    tools: ToolsConfig;
    memory: MemoryConfig;
    memory_letta: MemoryLettaConfig;
  };
  /** Base dir for `.block-agent` storage (apps get an explicit dir); default cwd. */
  storage_dir?: string;
  /** Forwarded to AgentRuntime. */
  max_turns_per_wake?: number;
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
 */
export type CtxView =
  | { kind: 'context'; snapshot_hash: string; segments: SegmentSummary[] }
  | { kind: 'apps'; apps: AppSummary[] }
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

/** One app's reflection for the /apps view. */
export interface AppSummary {
  id: string;
  version: string;
  blocks: string[];
  /** Full command names `<id>.<cmd>`, each flagged if user-only (allowed_invokers). */
  commands: Array<{ full_name: string; user_only: boolean }>;
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
