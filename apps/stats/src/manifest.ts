/**
 * apps/stats.ts — the `stats` BlockApp (impl-apps owned). NEW · DEFAULT DISABLED.
 *
 * StatsApp is the END-TO-END VALIDATION App for the contract + consume-refresh
 * machinery (§4.4): it proves that App↔App data flow really works without ANY identity
 * coupling. It consumes two contracts — `message_count` and `task_count` — folds their
 * merged provider outputs into its OWN derived state each render cycle (§3.5
 * consume-refresh), and projects a one-line summary. It NEVER names MessageApp or
 * TaskApp: swap, add, or remove a provider and StatsApp does not change (§3.2 / §5 swap).
 *
 * It ships DEFAULT `enabled:false` (user directive): a mechanism-validation App, not a
 * resident user feature. Even when enabled, `show_block` defaults to false so it renders
 * nothing until explicitly turned on — the round-trip (consume-refresh fills state) is
 * the deliverable, the rendered block is opt-in.
 *
 * Authoritative design: ai_com/design/blockapp-multi-app-architecture.md §4.4 + §3.5.
 *
 * One projection block:
 *   - `stats:summary` — `「{task_count} 待办 · {msg_count} 条消息」`, cache_tier
 *     `volatile` (the counts change most turns). `show_block === false` → `build`
 *     returns null (the block disappears).
 *
 * consumes: `[{contract:'message_count', as:'msg_count'},
 *            {contract:'task_count',    as:'task_count'}]`.
 *
 * INVARIANTS held here:
 *   #1 / #16  build PURE + byte-identical; no clock/random in build.
 *   #4        builder owner 'system'.
 *   #14       state all-JSON + bounded (two numbers + one boolean).
 *
 * House style (§0.5): block-world noun → `Block` prefix (`SummaryBlockBuilder`); the App
 * itself is `StatsApp`.
 */

import type { Block, BlockName } from '@block-agent/core/core/types.js';
import type {
  AppContext,
  AppManifest,
  BuildContext,
  BuilderManifest,
  CommandManifest,
  CommandResult,
  JsonSchema,
} from '@block-agent/core/app/types.js';
import { readAppConfig, APPS_DIR } from '@block-agent/core/apps/_app_config.js';

// ============================================================================
// Identity & block names
// ============================================================================

/** App id + tree namespace (§4.4). */
const APP_ID = 'stats' as const;
const TREE_NAMESPACE = '/stats' as const;

/** The single block this App renders into the prompt (INV #15). */
export const STATS_SUMMARY_BLOCK: BlockName = 'stats:summary';

// ============================================================================
// Config (file-seeded; user-only `set_config` to retune at runtime)
// ============================================================================

/**
 * StatsConfig — tunable knobs, seeded from `.block-agent/apps/stats/config.json` over
 * these compiled defaults, changeable at runtime only by the USER (set_config).
 *   - show_block — whether `stats:summary` renders. DEFAULT false (§4.4): even when the
 *     App is enabled it stays silent until explicitly turned on.
 */
export interface StatsConfig {
  show_block: boolean;
}

/** Compiled defaults — show_block false (§4.4: default silent). */
const DEFAULT_CONFIG: StatsConfig = {
  show_block: false,
};

// ============================================================================
// State (bounded derived projection — INV #14)
// ============================================================================

/**
 * StatsState — the two consumed counts plus config. `msg_count` / `task_count` are
 * NATIVE derived state filled each render by §3.5 consume-refresh (the registry folds
 * the merged provider outputs into `state[as]`); seeded to 0 so a contract-less boot
 * (no provider yet) renders `0` rather than undefined. All-JSON + bounded (INV #14).
 */
export interface StatsState {
  msg_count: number;
  task_count: number;
  config: StatsConfig;
}

/** INV #14: declare the schema so set_state (and consume-refresh's fold) is checked. */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['msg_count', 'task_count', 'config'],
  properties: {
    msg_count: { type: 'number' },
    task_count: { type: 'number' },
    config: {
      type: 'object',
      required: ['show_block'],
      properties: { show_block: { type: 'boolean' } },
    },
  },
};

// ============================================================================
// Builder — stats:summary (volatile), owner 'system', PURE (INV #4 / #16)
// ============================================================================

/** Narrow an AppContext's state to StatsState; null if missing / wrong shape. */
function statsStateOf(app_ctx: AppContext | undefined): StatsState | null {
  if (app_ctx === undefined) return null;
  const s = app_ctx.state;
  if (typeof s !== 'object' || s === null) return null;
  const cand = s as Partial<StatsState>;
  if (typeof cand.msg_count !== 'number' || typeof cand.task_count !== 'number' || cand.config == null) {
    return null;
  }
  return s as StatsState;
}

/**
 * SummaryBlockBuilder — owner of `stats:summary`. Renders the one-line count summary.
 * cache_tier `volatile`: the consumed counts change most turns. Pure: reads
 * `state.msg_count` / `state.task_count` / `state.config.show_block` only (INV #16).
 * Returns null when `show_block === false` (§4.4: default silent → the block disappears).
 */
const SummaryBlockBuilder: BuilderManifest = {
  name: 'SummaryBlockBuilder',
  version: '1.0.0',
  owner: 'system', // INV #4: 'agent' illegal.
  app_id: APP_ID,
  inputs: [],
  outputs: [STATS_SUMMARY_BLOCK],
  cache_tier: 'volatile',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = statsStateOf(app_ctx);
    if (state === null || state.config.show_block !== true) return null;
    return {
      id: STATS_SUMMARY_BLOCK,
      name: STATS_SUMMARY_BLOCK,
      children: [],
      content_text: `# Stats\n${state.task_count} 待办 · ${state.msg_count} 条消息`,
      content_blob: null,
    };
  },
};

// ============================================================================
// Command — set_config (user-only). NO write commands exposed to the agent (§4.4).
// ============================================================================

/**
 * stats.set_config({show_block}) — toggle the rendered block at runtime. USER-ONLY
 * (`allowed_invokers:['user']`) so the agent can never turn its own stats block on/off
 * (anti-self-modification, same gate as agent_identity.set). This is the App's ONLY
 * command — StatsApp exposes no write command to the agent (§4.4): its data comes purely
 * from consume-refresh.
 */
function setConfigCommand(): CommandManifest<StatsState> {
  return {
    name: 'set_config',
    description: 'Toggle the stats summary block (show_block). User/UI only.',
    capabilities: [{ name: 'block:write' }],
    allowed_invokers: ['user'],
    args_schema: { type: 'object', properties: { show_block: { type: 'boolean' } } },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
      if (typeof a['show_block'] !== 'boolean') {
        return { ok: false, error: 'set_config: no valid field (show_block)' };
      }
      ctx.set_state((s) => {
        const ss = s as StatsState;
        return { ...ss, config: { ...ss.config, show_block: a['show_block'] as boolean } };
      });
      return { ok: true, data: { updated: ['show_block'] } };
    },
  };
}

// ============================================================================
// StatsApp — the BlockApp
// ============================================================================

/** Options for constructing a StatsApp. */
export interface StatsAppOptions {
  /**
   * Base dir for the read-only config-file seed. OPTIONAL: when omitted, StatsApp
   * skips reading any config file and uses compiled defaults — it never reads a
   * cwd-relative fallback path. (Stats holds no data dir; config is its only file input.)
   */
  configBase?: string;
}

/**
 * StatsApp — the concrete contract-consuming validation BlockApp. `manifest()` produces
 * the AppManifest the AppRegistry installs; it holds NO store (the counts are derived
 * state, filled by consume-refresh, not persisted). It declares `consumes` for the two
 * count contracts and never names a provider App (identity-free, §3.2).
 */
export class StatsApp {
  private readonly seedConfig: StatsConfig;

  constructor(opts: StatsAppOptions = {}) {
    // configBase is the read-only config-seed base. When omitted we skip reading
    // the config file entirely and fall back to compiled defaults — we never read a
    // cwd-relative path (no implicit APPS_DIR fallback). Hardening (B 方案): a missing
    // configBase yields defaults, not a silent cwd read.
    const seeded =
      opts.configBase === undefined
        ? DEFAULT_CONFIG as unknown as Record<string, unknown>
        : readAppConfig(
            APP_ID,
            DEFAULT_CONFIG as unknown as Record<string, unknown>,
            opts.configBase,
          );
    this.seedConfig = { show_block: seeded['show_block'] === true };
  }

  /**
   * The AppManifest to hand to `AppRegistry.install`. Returned widened to the bare
   * `AppManifest` per the team's locked TS2379 convention. `consumes` binds on contract
   * NAMES only (no provider app-id) — the registry resolves providers and folds the
   * merged result into `state.msg_count` / `state.task_count` each render (§3.5).
   */
  manifest(): AppManifest {
    return makeStatsApp({ msg_count: 0, task_count: 0, config: this.seedConfig });
  }
}

/**
 * makeStatsApp — a direct AppManifest factory (mirrors `makeAgentIdentityApp`), for
 * callers that supply the initial derived state explicitly rather than seeding config
 * from a file. `initial_state` carries the two consumed counts (seeded to 0 for a
 * contract-less boot) plus `config.show_block`. The manifest is identical in shape to
 * `StatsApp.manifest()` — same consumes / builder / command — so the e2e + launch wiring
 * may use whichever construction fits. Returned widened to the bare `AppManifest` per the
 * team's locked TS2379 convention.
 */
export function makeStatsApp(
  initial_state: StatsState = { msg_count: 0, task_count: 0, config: { ...DEFAULT_CONFIG } },
): AppManifest {
  const manifest: AppManifest<StatsState> = {
    id: APP_ID,
    version: '1.0.0',
    depends_on: [],
    consumes: [
      { contract: 'message_count', as: 'msg_count' },
      { contract: 'task_count', as: 'task_count' },
    ],
    tree_namespace: TREE_NAMESPACE,
    initial_state,
    state_schema: STATE_SCHEMA,
    builders: [() => SummaryBlockBuilder],
    commands: [() => setConfigCommand()],
  };
  return manifest as AppManifest;
}

// Re-export for tests.
export { DEFAULT_CONFIG, APPS_DIR };
