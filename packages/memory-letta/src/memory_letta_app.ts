/**
 * src/memory_letta_app.ts — `memory_letta` BlockApp (design §3.2).
 *
 * Wraps a Letta server as block-agent's semantic-recall long-term memory backend.
 * Exposes:
 *   - `memory_letta:core`     (slow_changing) — Letta core memory blocks projection.
 *   - `memory_letta:recalled` (volatile)       — most-recent archival search results,
 *                                                wrapped in the shared provenance fence.
 *
 * Commands:
 *   - `memory_letta.remember`  — store content as a Letta archival passage.
 *   - `memory_letta.recall`    — semantic search, update recalled state + projection.
 *   - `memory_letta.set_block` — update a Letta core block (refuses read_only).
 *   - `memory_letta.set_config`— user-only; tune recall_limit / base_url.
 *
 * Security:
 *   - H1 scan (`scanMemoryContent`) before every store/upload (INV #21).
 *   - All archival/imported records get `provenance.verified = false` → heavier
 *     [unverified] fence in projection (INV #21 / §4.3).
 *   - `set_config` is `allowed_invokers: ['user']` — agent cannot retune its own
 *     backend (DR-M6 / DR-28 gate).
 *
 * Dependencies (INV chain):
 *   - imports `@block-agent/core` (contract only, never edits it).
 *   - @letta-ai/letta-client lives in LettaMemoryStore (lazy-loaded, DR-M4).
 *   - No sibling-app imports.
 *
 * House style (§0.5): extension unit is `BlockApp`; builders are `<Name>BlockBuilder`;
 * block names are `<app_id>:<name>`; commands are `<app_id>.<name>`.
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
import {
  scanMemoryContent,
  fenceRecalledContent,
  type MemoryRecord,
} from '@block-agent/core/apps/memory_store.js';
import { LettaMemoryStore, type LettaCoreBlock } from './letta_store.js';

// Re-export for test and consumer convenience (avoids leaking letta_store import path).
export type { LettaCoreBlock } from './letta_store.js';

// ============================================================================
// Identity + block names
// ============================================================================

export const APP_ID = 'memory_letta' as const;
const TREE_NAMESPACE = '/memory_letta' as const;

/** The two blocks this App renders. */
const CORE_BLOCK: BlockName = 'memory_letta:core';
const RECALLED_BLOCK: BlockName = 'memory_letta:recalled';

// ============================================================================
// State (INV #14 — all JSON + bounded)
// ============================================================================

/**
 * One recalled memory entry in App state. Holds content + provenance for the
 * projection builder (INV #14: plain JSON, bounded array, no Store reference).
 */
export interface RecalledEntry {
  id: string;
  content: string;
  tags: string[];
  origin: 'agent' | 'user' | 'imported';
  verified: boolean;
}

/**
 * LettaMemoryState — the bounded in-state projection (INV #14).
 * Full archival history lives in Letta server; we only keep the latest recall hits.
 */
export interface LettaMemoryState {
  /** Snapshot of Letta core memory blocks (label, value, read_only). */
  core_blocks: LettaCoreBlock[];
  /** Most-recent archival search hits (volatile; replaced on each recall). */
  recalled: RecalledEntry[];
  config: LettaMemoryConfig;
}

export interface LettaMemoryConfig {
  /** The Letta agent id bound to this block-agent instance. */
  agent_id: string;
  /** Archival search result-set cap (P3 defense). Default: 8. */
  recall_limit: number;
  /** Letta server base URL. Default: http://localhost:8283. */
  base_url: string;
}

const DEFAULT_CONFIG: LettaMemoryConfig = {
  agent_id: '',
  recall_limit: 8,
  base_url: 'http://localhost:8283',
};

const MAX_RECALL_LIMIT = 50;

/** State schema for set_state Proxy validation (INV #14). */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['core_blocks', 'recalled', 'config'],
  properties: {
    core_blocks: { type: 'array' },
    recalled: { type: 'array' },
    config: {
      type: 'object',
      required: ['agent_id', 'recall_limit', 'base_url'],
      properties: {
        agent_id: { type: 'string' },
        recall_limit: { type: 'number' },
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
// Builders (owner 'system', PURE, INV #16 — read state only, no I/O)
// ============================================================================

/**
 * CoreBlocksBuilder — projects Letta core memory blocks into `memory_letta:core`.
 * cache_tier `slow_changing`: changes only when an agent calls `set_block` or
 * `on_install` refreshes the snapshot.
 * INV #16: reads `app_ctx.state.core_blocks` only — no Letta call, no clock.
 */
function makeCoreBlocksBuilder(initialState: LettaMemoryState): BuilderManifest {
  return {
    name: 'CoreBlocksBuilder',
    version: '1.0.0',
    owner: 'system',
    app_id: APP_ID,
    inputs: [],
    outputs: [CORE_BLOCK],
    cache_tier: 'slow_changing',

    async build(_ctx: BuildContext, app_ctx?: AppContext<LettaMemoryState>): Promise<Block | null> {
      const state: LettaMemoryState = app_ctx?.state ?? initialState;
      const blocks = state.core_blocks;
      if (blocks.length === 0) return null;

      const lines = blocks.map(
        (b) => `[${b.label}${b.read_only ? ' (read-only)' : ''}]\n${b.value}`,
      );
      const content = lines.join('\n\n');

      return {
        id: 'memory_letta:core',
        name: CORE_BLOCK,
        children: [],
        content_text: content,
        content_blob: null,
      };
    },
  };
}

/**
 * RecalledBlockBuilder — projects the most-recent archival search hits into
 * `memory_letta:recalled`. Wraps content in the shared provenance fence
 * (`fenceRecalledContent`) with [unverified] markers for unverified entries.
 * cache_tier `volatile`: changes on every recall command.
 * INV #16: reads `app_ctx.state.recalled` only — no Letta call, no clock.
 */
function makeRecalledBlockBuilder(initialState: LettaMemoryState): BuilderManifest {
  return {
    name: 'RecalledBlockBuilder',
    version: '1.0.0',
    owner: 'system',
    app_id: APP_ID,
    inputs: [],
    outputs: [RECALLED_BLOCK],
    cache_tier: 'volatile',

    async build(_ctx: BuildContext, app_ctx?: AppContext<LettaMemoryState>): Promise<Block | null> {
      const state: LettaMemoryState = app_ctx?.state ?? initialState;
      const entries = state.recalled;
      if (entries.length === 0) return null;

      const body = entries
        .map((e) => {
          const tag = e.verified ? '' : ' [unverified]';
          return `- (${e.origin}${tag}) ${e.content}`;
        })
        .join('\n');

      const fenced = fenceRecalledContent(body);
      if (fenced.length === 0) return null;

      return {
        id: 'memory_letta:recalled',
        name: RECALLED_BLOCK,
        children: [],
        content_text: fenced,
        content_blob: null,
      };
    },
  };
}

// ============================================================================
// Helper: build a store from current state config
// ============================================================================

function storeFromConfig(cfg: LettaMemoryConfig): LettaMemoryStore {
  return new LettaMemoryStore({ agentId: cfg.agent_id, baseUrl: cfg.base_url });
}

// ============================================================================
// Content-addressed id (INV #16 — no random/clock)
// ============================================================================

/**
 * FNV-1a 32-bit hex — stable, dependency-free content hash.
 * Mirrors tools.ts and memory.ts (no sibling-app import; each app owns a copy).
 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Content-addressed seed id for a memory record (INV #16 / #1).
 * Letta will reassign the final passage id on success; this seed is only used
 * as a stable fallback id if the server call fails gracefully. Same content →
 * same id on replay, so offline/failure paths remain byte-identical.
 */
function contentAddressedId(content: string): string {
  return `mem.${fnv1a(content)}`;
}

// ============================================================================
// Commands
// ============================================================================

/**
 * memory_letta.remember — store content as a Letta archival passage.
 * Caps [block:write, net:http]. H1 scan before upload (INV #21).
 * Origin: invoker==='user' → 'user', else 'agent'. Archival/imported verified=false
 * (heavier [unverified] fence), agent-written verified=false, user-written verified=true.
 */
function makeRememberCommand(): CommandManifest<LettaMemoryState> {
  return {
    name: 'remember',
    description: 'Store content as a Letta archival passage for long-term semantic recall.',
    args_schema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string', description: 'The text to remember.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional categorization tags.',
        },
      },
    },
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],

    async invoke(
      args: unknown,
      ctx: AppContext<LettaMemoryState>,
      invoker: InvokerContext,
    ): Promise<CommandResult> {
      const { content, tags } = args as { content: string; tags?: string[] };

      // H1 injection / exfiltration scan (INV #21).
      const scan = scanMemoryContent(content);
      if (!scan.ok) {
        return { ok: false, error: scan.reason };
      }

      const cfg = ctx.state.config;
      if (!cfg.agent_id) {
        return { ok: false, error: 'memory_letta is not configured: agent_id missing. Run memory_letta.set_config or reinstall.' };
      }

      const origin: 'user' | 'agent' = invoker.invoker === 'user' ? 'user' : 'agent';
      const verified = origin === 'user';

      const rec: MemoryRecord = {
        id: contentAddressedId(content), // deterministic seed; Letta reassigns to passage id on success
        content,
        tags: tags ?? [],
        provenance: { origin, verified },
      };

      const store = storeFromConfig(cfg);
      const finalId = await store.store(rec);

      return {
        ok: true,
        data: { id: finalId, origin, verified },
      };
    },
  };
}

/**
 * memory_letta.recall — semantic archival search, update recalled state, project.
 * Caps [block:write, net:http].
 */
function makeRecallCommand(): CommandManifest<LettaMemoryState> {
  return {
    name: 'recall',
    description: 'Semantically search Letta archival memory and update the recalled projection.',
    args_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'The search query.' },
        limit: { type: 'number', description: 'Max results (capped at recall_limit config).' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tag filter.',
        },
      },
    },
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],

    async invoke(
      args: unknown,
      ctx: AppContext<LettaMemoryState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      const { query, limit, tags } = args as { query: string; limit?: number; tags?: string[] };

      const cfg = ctx.state.config;
      if (!cfg.agent_id) {
        return { ok: false, error: 'memory_letta is not configured: agent_id missing.' };
      }

      const cap = Math.min(limit ?? cfg.recall_limit, cfg.recall_limit);

      const store = storeFromConfig(cfg);
      const q: import('@block-agent/core/apps/memory_store.js').MemoryQuery = { query, limit: cap };
      if (tags != null) q.tags = tags;
      const hits = await store.query(q);

      const entries: RecalledEntry[] = hits.map((r) => ({
        id: r.id,
        content: r.content,
        tags: [...r.tags],
        origin: r.provenance.origin,
        verified: r.provenance.verified,
      }));

      ctx.set_state((s) => ({ ...s, recalled: entries }));

      return { ok: true, data: { count: entries.length } };
    },
  };
}

/**
 * memory_letta.set_block — update a Letta core block by label.
 * Refuses writes to read_only blocks. Caps [block:write, net:http].
 */
function makeSetBlockCommand(): CommandManifest<LettaMemoryState> {
  return {
    name: 'set_block',
    description: "Update a Letta core memory block by label. Refuses read-only blocks.",
    args_schema: {
      type: 'object',
      required: ['label', 'value'],
      properties: {
        label: { type: 'string', description: 'The block label (e.g. "human", "persona").' },
        value: { type: 'string', description: 'The new block value.' },
      },
    },
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],

    async invoke(
      args: unknown,
      ctx: AppContext<LettaMemoryState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      const { label, value } = args as { label: string; value: string };

      // Check read_only in current state snapshot.
      const existing = ctx.state.core_blocks.find((b) => b.label === label);
      if (existing?.read_only === true) {
        return { ok: false, error: `Block '${label}' is read-only and cannot be modified.` };
      }

      const cfg = ctx.state.config;
      if (!cfg.agent_id) {
        return { ok: false, error: 'memory_letta is not configured: agent_id missing.' };
      }

      // H1 scan — core blocks are injected into prompt too (INV #21).
      const scan = scanMemoryContent(value);
      if (!scan.ok) {
        return { ok: false, error: scan.reason };
      }

      const store = storeFromConfig(cfg);
      const updated = await store.setBlock(label, value);

      if (updated !== null) {
        // Refresh state snapshot for the updated block.
        ctx.set_state((s) => ({
          ...s,
          core_blocks: s.core_blocks.map((b) =>
            b.label === label ? { ...b, value: updated.value } : b,
          ),
        }));
      }

      return { ok: updated !== null, data: updated ?? undefined };
    },
  };
}

/**
 * memory_letta.set_config — user-only runtime config update (DR-28 gate).
 * Agent can never retune its own backend / recall limit.
 */
function makeSetConfigCommand(): CommandManifest<LettaMemoryState> {
  return {
    name: 'set_config',
    description: 'User-only: update memory_letta config (recall_limit, base_url).',
    args_schema: {
      type: 'object',
      properties: {
        recall_limit: { type: 'number', description: 'Max archival search results per recall.' },
        base_url: { type: 'string', description: 'Letta server base URL.' },
      },
    },
    // DR-28 gate: agent cannot retune its own backend config.
    allowed_invokers: ['user'],

    async invoke(
      args: unknown,
      ctx: AppContext<LettaMemoryState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      const { recall_limit, base_url } = args as {
        recall_limit?: number;
        base_url?: string;
      };

      ctx.set_state((s) => {
        const newCfg: LettaMemoryConfig = { ...s.config };
        if (recall_limit !== undefined) {
          newCfg.recall_limit = Math.max(1, Math.min(MAX_RECALL_LIMIT, Math.floor(recall_limit)));
        }
        if (base_url !== undefined && base_url.length > 0) {
          newCfg.base_url = base_url;
        }
        return { ...s, config: newCfg };
      });

      return { ok: true, data: { config: ctx.state.config } };
    },
  };
}

// ============================================================================
// MemoryLettaApp — the BlockApp factory
// ============================================================================

/** Options for constructing a MemoryLettaApp. */
export interface MemoryLettaAppOptions {
  /**
   * Optional store override for testing (inject a FakeMemoryStore instead of the
   * real LettaMemoryStore). When provided, `on_install` skips agent creation.
   */
  store?: import('@block-agent/core/apps/memory_store.js').MemoryStore & {
    coreBlocks?(): Promise<LettaCoreBlock[]>;
  };
  /** Letta server base URL (default: http://localhost:8283). */
  baseUrl?: string;
}

/**
 * MemoryLettaApp — factory returning the `memory_letta` AppManifest.
 *
 * Construct with `new MemoryLettaApp(opts).manifest()` for installation.
 * In tests, pass `{ store: fakeStore }` to skip real Letta I/O.
 */
export class MemoryLettaApp {
  private readonly opts: MemoryLettaAppOptions;

  constructor(opts: MemoryLettaAppOptions = {}) {
    this.opts = opts;
  }

  manifest(): AppManifest<LettaMemoryState> {
    const opts = this.opts;

    const initialState: LettaMemoryState = {
      core_blocks: [],
      recalled: [],
      config: { ...DEFAULT_CONFIG },
    };

    return {
      id: APP_ID,
      version: '1.0.0',
      depends_on: [],
      tree_namespace: TREE_NAMESPACE,
      initial_state: initialState,
      state_schema: STATE_SCHEMA,

      builders: [
        (_s: LettaMemoryState) => makeCoreBlocksBuilder(initialState),
        (_s: LettaMemoryState) => makeRecalledBlockBuilder(initialState),
      ],

      commands: [
        // Override commands to use the injected store when present (for testing).
        opts.store != null
          ? (_s: LettaMemoryState) => makeRememberCommandWithStore(opts.store!)
          : (_s: LettaMemoryState) => makeRememberCommand(),
        opts.store != null
          ? (_s: LettaMemoryState) => makeRecallCommandWithStore(opts.store!)
          : (_s: LettaMemoryState) => makeRecallCommand(),
        opts.store != null
          ? (_s: LettaMemoryState) => makeSetBlockCommandWithStore(opts.store!)
          : (_s: LettaMemoryState) => makeSetBlockCommand(),
        (_s: LettaMemoryState) => makeSetConfigCommand(),
      ],

      /**
       * on_install: fetch core blocks snapshot to warm state. If no agent_id is
       * configured, create a new Letta agent and store its id in config. Server
       * unreachable → silent degrade (SETUP_NEEDED style, never hard crash).
       */
      async on_install(ctx: AppContext<LettaMemoryState>): Promise<void> {
        const cfg = ctx.state.config;
        let agentId = cfg.agent_id;

        // If a test store is injected, skip real agent creation.
        if (opts.store == null && !agentId) {
          const created = await LettaMemoryStore.createAgent(cfg.base_url);
          if (created != null) {
            agentId = created;
            ctx.set_state((s) => ({
              ...s,
              config: { ...s.config, agent_id: agentId },
            }));
          }
          // Server unreachable → leave agent_id empty; commands will degrade gracefully.
        }

        // Warm core blocks snapshot if we have an agent.
        if (agentId) {
          try {
            const store = opts.store ?? new LettaMemoryStore({ agentId, baseUrl: cfg.base_url });
            const coreBlocksFn = (store as { coreBlocks?: () => Promise<LettaCoreBlock[]> }).coreBlocks;
            const blocks: LettaCoreBlock[] = coreBlocksFn != null
              ? await coreBlocksFn.call(store)
              : await (store as LettaMemoryStore).coreBlocks?.() ?? [];
            if (blocks.length > 0) {
              ctx.set_state((s) => ({ ...s, core_blocks: blocks }));
            }
          } catch {
            // Graceful degrade — leave core_blocks empty.
          }
        }
      },
    };
  }
}

// ============================================================================
// Store-injected command variants (for testing — bypass LettaMemoryStore)
// ============================================================================

type InjectedStore = import('@block-agent/core/apps/memory_store.js').MemoryStore & {
  coreBlocks?(): Promise<LettaCoreBlock[]>;
  setBlock?(label: string, value: string): Promise<LettaCoreBlock | null>;
};

function makeRememberCommandWithStore(store: InjectedStore): CommandManifest<LettaMemoryState> {
  return {
    name: 'remember',
    description: 'Store content as a Letta archival passage for long-term semantic recall.',
    args_schema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],

    async invoke(
      args: unknown,
      _ctx: AppContext<LettaMemoryState>,
      invoker: InvokerContext,
    ): Promise<CommandResult> {
      const { content, tags } = args as { content: string; tags?: string[] };

      const scan = scanMemoryContent(content);
      if (!scan.ok) return { ok: false, error: scan.reason };

      const origin: 'user' | 'agent' = invoker.invoker === 'user' ? 'user' : 'agent';
      const verified = origin === 'user';

      const rec: MemoryRecord = {
        id: contentAddressedId(content),
        content,
        tags: tags ?? [],
        provenance: { origin, verified },
      };

      const finalId = await store.store(rec);
      return { ok: true, data: { id: finalId, origin, verified } };
    },
  };
}

function makeRecallCommandWithStore(store: InjectedStore): CommandManifest<LettaMemoryState> {
  return {
    name: 'recall',
    description: 'Semantically search Letta archival memory and update the recalled projection.',
    args_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],

    async invoke(
      args: unknown,
      ctx: AppContext<LettaMemoryState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      const { query, limit, tags } = args as { query: string; limit?: number; tags?: string[] };

      const cfg = ctx.state.config;
      const cap = Math.min(limit ?? cfg.recall_limit, cfg.recall_limit);

      const q: import('@block-agent/core/apps/memory_store.js').MemoryQuery = { query, limit: cap };
      if (tags != null) q.tags = tags;
      const hits = await store.query(q);

      const entries: RecalledEntry[] = hits.map((r) => ({
        id: r.id,
        content: r.content,
        tags: [...r.tags],
        origin: r.provenance.origin,
        verified: r.provenance.verified,
      }));

      ctx.set_state((s) => ({ ...s, recalled: entries }));
      return { ok: true, data: { count: entries.length } };
    },
  };
}

function makeSetBlockCommandWithStore(store: InjectedStore): CommandManifest<LettaMemoryState> {
  return {
    name: 'set_block',
    description: "Update a Letta core memory block by label. Refuses read-only blocks.",
    args_schema: {
      type: 'object',
      required: ['label', 'value'],
      properties: {
        label: { type: 'string' },
        value: { type: 'string' },
      },
    },
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],

    async invoke(
      args: unknown,
      ctx: AppContext<LettaMemoryState>,
      _invoker: InvokerContext,
    ): Promise<CommandResult> {
      const { label, value } = args as { label: string; value: string };

      const existing = ctx.state.core_blocks.find((b) => b.label === label);
      if (existing?.read_only === true) {
        return { ok: false, error: `Block '${label}' is read-only and cannot be modified.` };
      }

      const scan = scanMemoryContent(value);
      if (!scan.ok) return { ok: false, error: scan.reason };

      // Use injected store's setBlock if available, else a stub update.
      let updated: LettaCoreBlock | null = null;
      if (typeof (store as { setBlock?: unknown }).setBlock === 'function') {
        updated = await (store as { setBlock: (l: string, v: string) => Promise<LettaCoreBlock | null> }).setBlock(label, value);
      } else {
        updated = { label, value, read_only: false };
      }

      if (updated !== null) {
        ctx.set_state((s) => ({
          ...s,
          core_blocks: s.core_blocks.map((b) =>
            b.label === label ? { ...b, value } : b,
          ),
        }));
      }

      return { ok: updated !== null, data: updated ?? undefined };
    },
  };
}
