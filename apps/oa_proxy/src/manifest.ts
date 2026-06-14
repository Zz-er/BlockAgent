/**
 * apps/oa_proxy/src/manifest.ts — the `oa_proxy` BlockApp (platform phase-C).
 *
 * oa_proxy projects the OA org DIRECTORY into the agent's context as a single, read-heavy
 * `stable` block (who is who, which dept, what title) AND provides the `org_directory`
 * contract that im_proxy / task_proxy consume — so each proxy resolves a principal_id to
 * {name, title, employee_no} from this ONE projection instead of re-pulling OA itself
 * (contracts bind on TYPE, not identity: none of them names oa_proxy).
 *
 * Read-heavy by design (oa.md §0): the value is the always-visible org block; there are NO
 * write commands (org / membership writes are console-side, oa.md §6). v1 forms / approval
 * are DEFERRED (oa.md §4b), so this app does not carry them.
 *
 * trust 'trusted' / host 'in-process' (same as the other proxies, package.json blockAgent):
 * the OA HTTP client (oa_client.ts) is isolated to THIS workspace (cli runtime dep, core
 * devDep) so @block-agent/core's runtime closure stays empty — same rule as memory_letta.
 *
 * Blocks:
 *   - `oa_proxy:directory` (cache_tier `stable`) — the org directory projection. `stable`
 *     because the org changes only on an org restructure → renders first, highest
 *     prompt-cache hit rate (renderer segments stable → slow_changing → volatile).
 *
 * Commands:
 *   - `oa.refresh_directory` — pull GET /oa/directory into state (`block:write` + `net:http`).
 *   - `oa.lookup {principal_id}` — readonly GET /oa/principal/{id} (`net:http`); app/user only.
 *   - `oa.org_directory` — the `org_directory` contract's readonly `via`; app/user only.
 *   - `oa.set_config` — user-only (anti-self-modification gate).
 *
 * provides: `[{ contract: 'org_directory', via: 'org_directory' }]`.
 *
 * INVARIANTS held here:
 *   #1 / #16  build PURE + byte-identical; no clock / random / network in build (state only).
 *   #4        builder owner 'system' (never 'agent').
 *   #5        on_uninstall does NOT delete OA data — there is no durable OA store to delete;
 *             OA is upstream. on_uninstall is a no-op (nothing to tear down besides state).
 *   #14       state all-JSON + bounded (directory capped to dir_limit).
 *   #18       every OA response is deep-copied through oa_client's `to*` mappers before it
 *             reaches state — an untrusted backend cannot smuggle an aliased object in.
 *
 * House style (§0.5): block-world noun → `Block` prefix (`DirectoryBlockBuilder`); the app is
 * `OaProxyApp`; block name `oa_proxy:directory`; command `oa.<name>`.
 */

import type { Block, BlockName, InvokerContext } from '@block-agent/core/core/types.js';
import type {
  AppContext,
  AppManifest,
  BuildContext,
  BuilderManifest,
  Capability,
  CommandManifest,
  CommandResult,
  JsonSchema,
} from '@block-agent/core/app/types.js';
import { readAppConfig, APPS_DIR } from '@block-agent/core/apps/_app_config.js';
import { OaServiceClient, type OaClient } from './oa_client.js';
import type { DirectoryMember, OrgDirectory } from './wire.js';
import { ORG_DIRECTORY } from './contract.js';

// Re-export the wire types so consumers / tests don't reach into ./wire.js.
export type { DirectoryMember, OrgDirectory } from './wire.js';
// Re-export the ContractDef so launch.ts can `registry.registerContract(ORG_DIRECTORY)`.
// The canonical definition lives in ./contract.ts (Architect ruling: a standalone file the
// launcher imports without pulling the whole manifest).
export { ORG_DIRECTORY, ORG_DIRECTORY_NAME } from './contract.js';

// ============================================================================
// Identity & block names
// ============================================================================

const APP_ID = 'oa_proxy' as const;
const TREE_NAMESPACE = '/oa_proxy' as const;

/** The single block this App renders into the prompt (read-heavy, `stable`). */
export const OA_DIRECTORY_BLOCK: BlockName = 'oa_proxy:directory';

// ============================================================================
// Config (file-seeded; user-only set_config to retune at runtime)
// ============================================================================

/**
 * OaProxyConfig — tunable knobs, seeded from `.block-agent/apps/oa_proxy/config.json` over
 * these compiled defaults, changeable at runtime only by the USER (set_config).
 *   - dir_limit — max members kept in state.directory (INV #14 boundedness).
 *   - base_url  — OA service base URL.
 */
export interface OaProxyConfig {
  dir_limit: number;
  base_url: string;
}

const DEFAULT_CONFIG: OaProxyConfig = {
  dir_limit: 100,
  base_url: 'http://localhost:8284',
};

const MAX_DIR_LIMIT = 1000;

// ============================================================================
// State (bounded directory projection — INV #14)
// ============================================================================

/**
 * OaProxyState — the directory projection plus config + the org_id the directory belongs to.
 * `directory` is bounded (capped to config.dir_limit). All plain JSON (INV #14); no client
 * handle lives in state.
 */
export interface OaProxyState {
  org_id: string;
  directory: DirectoryMember[];
  config: OaProxyConfig;
}

/** INV #14: declare the schema so set_state (and any fold) is checked. */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['org_id', 'directory', 'config'],
  properties: {
    org_id: { type: 'string' },
    directory: { type: 'array' },
    config: {
      type: 'object',
      required: ['dir_limit', 'base_url'],
      properties: {
        dir_limit: { type: 'number' },
        base_url: { type: 'string' },
      },
    },
  },
};

// ============================================================================
// Capability tokens
// ============================================================================

const CAP_BLOCK_WRITE: Capability = { name: 'block:write' };
const CAP_NET_HTTP: Capability = { name: 'net:http' };

// ============================================================================
// Builder — oa_proxy:directory (stable), owner 'system', PURE (INV #4 / #16)
// ============================================================================

/** Narrow an AppContext's state to OaProxyState; null if missing / wrong shape. */
function oaStateOf(app_ctx: AppContext | undefined): OaProxyState | null {
  if (app_ctx === undefined) return null;
  const s = app_ctx.state;
  if (typeof s !== 'object' || s === null) return null;
  const cand = s as Partial<OaProxyState>;
  if (!Array.isArray(cand.directory) || cand.config == null) return null;
  return s as OaProxyState;
}

/** Render one member line. dept_path + title shown when present; nulls omitted. */
function renderMember(m: DirectoryMember): string {
  const parts: string[] = [];
  // Primary display: prefer the display name, fall back to the real name.
  const shown = m.display.length > 0 ? m.display : m.name;
  parts.push(`- ${shown} (${m.kind})`);
  const meta: string[] = [];
  if (m.title != null && m.title.length > 0) meta.push(m.title);
  if (m.dept_path != null && m.dept_path.length > 0) meta.push(m.dept_path);
  if (meta.length > 0) parts.push(` — ${meta.join(', ')}`);
  return parts.join('');
}

/**
 * DirectoryBlockBuilder — owner of `oa_proxy:directory`. Renders the org directory.
 * cache_tier `stable`: the org changes only on a restructure, so this block is highly
 * cacheable and renders first. PURE: reads `state.directory` only (INV #16) — no OA call,
 * no clock. Empty directory → null (the block disappears).
 */
const DirectoryBlockBuilder: BuilderManifest = {
  name: 'DirectoryBlockBuilder',
  version: '1.0.0',
  owner: 'system', // INV #4: 'agent' illegal.
  app_id: APP_ID,
  inputs: [],
  outputs: [OA_DIRECTORY_BLOCK],
  cache_tier: 'stable',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = oaStateOf(app_ctx);
    if (state === null || state.directory.length === 0) return null;
    const lines = state.directory.map(renderMember);
    return {
      id: OA_DIRECTORY_BLOCK,
      name: OA_DIRECTORY_BLOCK,
      children: [],
      content_text: `# Organization\n${lines.join('\n')}`,
      content_blob: null,
    };
  },
};

// ============================================================================
// Commands
// ============================================================================

const BACKEND_UNAVAILABLE =
  'OA service unavailable — directory not refreshed (check OA_SERVICE_TOKEN / base_url).';

/** Build a client from the current state config (token comes from env, inside the client). */
function clientFromConfig(cfg: OaProxyConfig): OaClient {
  return new OaServiceClient({ baseUrl: cfg.base_url });
}

/** Cap a directory to dir_limit (INV #14 boundedness). */
function capDirectory(members: DirectoryMember[], limit: number): DirectoryMember[] {
  const n = Math.max(0, Math.min(MAX_DIR_LIMIT, Math.floor(limit)));
  return members.slice(0, n);
}

/**
 * oa.refresh_directory — pull GET /oa/directory and fold it into state.directory (capped to
 * dir_limit) + state.org_id. `block:write` + `net:http`. Default invokers (agent may refresh
 * its own org view; it is a pull from the authoritative source, not a self-edit). Degrades
 * with a clear error when the OA service is unreachable.
 */
function makeRefreshCommand(clientFactory: (cfg: OaProxyConfig) => OaClient): CommandManifest<OaProxyState> {
  return {
    name: 'refresh_directory',
    description: 'Pull the current OA org directory into state (GET /oa/directory).',
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
    args_schema: { type: 'object', properties: {} },
    async invoke(_args: unknown, ctx: AppContext<OaProxyState>, _invoker: InvokerContext): Promise<CommandResult> {
      const cfg = ctx.state.config;
      const client = clientFactory(cfg);
      const dir = await client.getDirectory();
      if (dir === null) return { ok: false, error: BACKEND_UNAVAILABLE };
      const members = capDirectory(dir.members, cfg.dir_limit);
      ctx.set_state((s) => ({ ...s, org_id: dir.org_id, directory: members }));
      return { ok: true, data: { org_id: dir.org_id, count: members.length } };
    },
  };
}

/**
 * oa.lookup {principal_id} — readonly GET /oa/principal/{id}: resolve one principal's org
 * identity. `net:http`, readonly. `allowed_invokers: ['user','app']` so it never enters the
 * agent tool catalog (it is a data read for UIs / internal use, DR-F). Returns the
 * OrgIdentity (employee_no may be null — downstream must not assume non-null).
 */
function makeLookupCommand(clientFactory: (cfg: OaProxyConfig) => OaClient): CommandManifest<OaProxyState> {
  return {
    name: 'lookup',
    description: 'Look up one principal\'s OA org identity by principal_id (data; app/user only).',
    readonly: true,
    allowed_invokers: ['user', 'app'],
    capabilities: [CAP_NET_HTTP],
    args_schema: { type: 'object', required: ['principal_id'], properties: { principal_id: { type: 'string' } } },
    async invoke(args: unknown, ctx: AppContext<OaProxyState>, _invoker: InvokerContext): Promise<CommandResult> {
      const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
      const id = a['principal_id'];
      if (typeof id !== 'string' || id.length === 0) {
        return { ok: false, error: 'lookup: principal_id (string) required' };
      }
      const client = clientFactory(ctx.state.config);
      const identity = await client.getPrincipal(id);
      if (identity === null) return { ok: false, error: `OA principal '${id}' not found or OA unavailable.` };
      return { ok: true, data: identity };
    },
  };
}

/**
 * oa.org_directory — the `org_directory` contract's readonly `via`. Returns the WHOLE
 * OrgDirectory `{ org_id, members }` from CURRENT state (the provider computes from its OWN
 * state, INV #11 — no OA call here, so consume-refresh stays a pure read). `readonly:true` +
 * `result_schema` = the OrgDirectory object (matches ORG_DIRECTORY.output_schema, R-1).
 * `allowed_invokers: ['app','user']` so it never enters the agent tool catalog (DR-F).
 */
function makeOrgDirectoryCommand(): CommandManifest<OaProxyState> {
  return {
    name: 'org_directory',
    description: 'Return the current OA org directory (the org_directory contract via; app/user only).',
    readonly: true,
    allowed_invokers: ['app', 'user'],
    capabilities: [],
    result_schema: ORG_DIRECTORY.output_schema,
    args_schema: { type: 'object', properties: {} },
    async invoke(_args: unknown, ctx: AppContext<OaProxyState>, _invoker: InvokerContext): Promise<CommandResult> {
      const out: OrgDirectory = { org_id: ctx.state.org_id, members: ctx.state.directory };
      return { ok: true, data: out };
    },
  };
}

/**
 * oa.set_config {dir_limit?, base_url?} — user-only runtime config update. USER-ONLY
 * (`allowed_invokers: ['user']`) so the agent can never retune its own OA backend / cap
 * (anti-self-modification, same gate as agent_identity.set / every *.set_config).
 */
function makeSetConfigCommand(): CommandManifest<OaProxyState> {
  return {
    name: 'set_config',
    description: 'User-only: update oa_proxy config (dir_limit, base_url).',
    capabilities: [CAP_BLOCK_WRITE],
    allowed_invokers: ['user'],
    args_schema: {
      type: 'object',
      properties: { dir_limit: { type: 'number' }, base_url: { type: 'string' } },
    },
    async invoke(args: unknown, ctx: AppContext<OaProxyState>, _invoker: InvokerContext): Promise<CommandResult> {
      const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
      const dir_limit = a['dir_limit'];
      const base_url = a['base_url'];
      if (typeof dir_limit !== 'number' && typeof base_url !== 'string') {
        return { ok: false, error: 'set_config: no valid field (dir_limit / base_url)' };
      }
      ctx.set_state((s) => {
        const cfg: OaProxyConfig = { ...s.config };
        if (typeof dir_limit === 'number') {
          cfg.dir_limit = Math.max(0, Math.min(MAX_DIR_LIMIT, Math.floor(dir_limit)));
        }
        if (typeof base_url === 'string' && base_url.length > 0) cfg.base_url = base_url;
        return { ...s, config: cfg };
      });
      return { ok: true, data: { config: ctx.state.config } };
    },
  };
}

// ============================================================================
// OaProxyApp — the BlockApp factory
// ============================================================================

/** Options for constructing an OaProxyApp. */
export interface OaProxyAppOptions {
  /** Base dir for the config-file seed (defaults to `.block-agent/apps`). */
  configBase?: string;
  /**
   * Optional client override for testing (inject a FakeOaClient instead of the real
   * OaServiceClient). When provided, the commands + on_install use it and skip real HTTP.
   */
  client?: OaClient;
}

/**
 * OaProxyApp — factory returning the `oa_proxy` AppManifest. Holds NO durable store (the
 * directory is a projection of the upstream OA service; on_uninstall deletes nothing, INV #5).
 */
export class OaProxyApp {
  private readonly seedConfig: OaProxyConfig;
  private readonly client: OaClient | undefined;

  constructor(opts: OaProxyAppOptions = {}) {
    const seeded = readAppConfig(
      APP_ID,
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      opts.configBase ?? APPS_DIR,
    );
    this.seedConfig = {
      dir_limit: typeof seeded['dir_limit'] === 'number' ? (seeded['dir_limit'] as number) : DEFAULT_CONFIG.dir_limit,
      base_url: typeof seeded['base_url'] === 'string' ? (seeded['base_url'] as string) : DEFAULT_CONFIG.base_url,
    };
    this.client = opts.client;
  }

  manifest(): AppManifest {
    const seedConfig = this.seedConfig;
    const injected = this.client;
    // A client factory: the injected fake (tests) or a fresh real client (prod).
    const clientFactory = (cfg: OaProxyConfig): OaClient => injected ?? clientFromConfig(cfg);

    const initial_state: OaProxyState = {
      org_id: '',
      directory: [],
      config: { ...seedConfig },
    };

    const manifest: AppManifest<OaProxyState> = {
      id: APP_ID,
      version: '1.0.0',
      depends_on: [],
      provides: [{ contract: 'org_directory', via: 'org_directory' }],
      tree_namespace: TREE_NAMESPACE,
      initial_state,
      state_schema: STATE_SCHEMA,
      builders: [() => DirectoryBlockBuilder],
      commands: [
        () => makeRefreshCommand(clientFactory),
        () => makeLookupCommand(clientFactory),
        () => makeOrgDirectoryCommand(),
        () => makeSetConfigCommand(),
      ],

      /**
       * on_install: warm the directory projection by pulling GET /oa/directory once. OA
       * unreachable → silent degrade (leave directory empty; oa.refresh_directory retries
       * later). Never throws at boot. INV #5: reads only — deletes nothing.
       */
      async on_install(ctx: AppContext<OaProxyState>): Promise<void> {
        try {
          const client = clientFactory(ctx.state.config);
          const dir = await client.getDirectory();
          if (dir !== null) {
            const members = capDirectory(dir.members, ctx.state.config.dir_limit);
            ctx.set_state((s) => ({ ...s, org_id: dir.org_id, directory: members }));
          }
        } catch {
          // Graceful degrade — leave directory empty.
        }
      },
    };
    return manifest as AppManifest;
  }
}

// Re-export for tests / launch wiring.
export { DEFAULT_CONFIG, APPS_DIR };
