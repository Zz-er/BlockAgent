/**
 * src/letta_store.ts — LettaMemoryStore: out-of-process Letta binding (DR-M4).
 *
 * Implements `MemoryStore` by proxying to a Letta server via `@letta-ai/letta-client`.
 * The SDK is lazy-imported (the `await import(...)` pattern from tools.ts) so a build
 * that does not install this app never loads the SDK.
 *
 * Trust model (§6.4 / INV #18): the Letta server is an UNTRUSTED external backend.
 * Every `query` result is deep-copied before it crosses back into block-agent code.
 * Result count is capped at `q.limit` (P3). Outbound calls require the `net:http`
 * capability — declared on the commands in memory_letta_app.ts, not here.
 *
 * Graceful degradation: when the Letta server is unreachable, methods degrade rather
 * than throwing (SETUP_NEEDED style). `store` / `query` log a warning and return
 * an empty/null result instead of crashing the turn loop.
 *
 * Config: base URL from `baseUrl` constructor param (default http://localhost:8283).
 * API key from `LETTA_API_KEY` env ONLY — never passed through config/state/log.
 *
 * SDK methods used (confirmed from letta-ai/letta-node source):
 *   passages.create(agentId, { text, tags? })     → Passage[] (create response)
 *   passages.search(agentId, { query, top_k? })   → PassageSearchResponse { count, results[] }
 *   passages.list(agentId)                        → Passage[] (for load by id, linear scan)
 *   passages.delete(memoryId, { agent_id })       → void
 *   blocks.list(agentId)                          → BlockResponse[] (paginated)
 *   blocks.retrieve(label, { agent_id })          → BlockResponse { id, label, value, read_only }
 *   blocks.update(label, { agent_id, value })     → BlockResponse
 *   agents.create({ ... })                        → AgentState { id }
 */

import type { MemoryRecord, MemoryProvenance, MemoryQuery, MemoryStore } from '@block-agent/core/apps/memory_store.js';

// ============================================================================
// Letta core block shape (returned by coreBlocks() helper)
// ============================================================================

/** One Letta core memory block as seen by block-agent. */
export interface LettaCoreBlock {
  label: string;
  value: string;
  read_only: boolean;
}

// ============================================================================
// LettaClient lazy-load helper
// ============================================================================

/**
 * Lazy-loaded SDK module cache. We import once on first use so the SDK is never
 * loaded if the memory_letta app is not installed (DR-M4 dependency isolation).
 */
let _sdkModule: typeof import('@letta-ai/letta-client') | null = null;

async function getSdk(): Promise<typeof import('@letta-ai/letta-client')> {
  if (_sdkModule === null) {
    _sdkModule = await import('@letta-ai/letta-client');
  }
  return _sdkModule;
}

// ============================================================================
// LettaMemoryStore
// ============================================================================

/** Options for constructing a LettaMemoryStore. */
export interface LettaMemoryStoreOptions {
  /** Letta agent id (assigned on first install and stored in app config). */
  agentId: string;
  /**
   * Letta server base URL. Default: http://localhost:8283 (Docker default port).
   * The API key is taken from `process.env.LETTA_API_KEY` — never from options.
   */
  baseUrl?: string;
}

/**
 * LettaMemoryStore — the out-of-process Letta binding for `MemoryStore` (§6.4).
 *
 * "Passive" backend: only stores what is handed to it, returns by-value copies,
 * never decides what enters the prompt. The trusted memory_letta app code does
 * the projection (INV #20).
 *
 * Dependency isolation: imports `@letta-ai/letta-client` only inside async methods
 * via the lazy `getSdk()` call (tools.ts pattern). The core package never sees it.
 */
export class LettaMemoryStore implements MemoryStore {
  readonly agentId: string;
  private readonly baseUrl: string;

  constructor(opts: LettaMemoryStoreOptions) {
    this.agentId = opts.agentId;
    this.baseUrl = opts.baseUrl ?? 'http://localhost:8283';
  }

  // --------------------------------------------------------------------------
  // Internal: build a LettaClient for each call (stateless; SDK manages HTTP pool)
  // --------------------------------------------------------------------------

  private async client(): Promise<import('@letta-ai/letta-client').Letta> {
    const sdk = await getSdk();
    // API key from env ONLY (the ANTHROPIC_API_KEY rule). Never log or persist.
    const apiKey = process.env['LETTA_API_KEY'] ?? 'no-key';
    return new sdk.Letta({ apiKey, baseURL: this.baseUrl });
  }

  // --------------------------------------------------------------------------
  // MemoryStore.store — passages.create (archival insert)
  // --------------------------------------------------------------------------

  /**
   * Persist one record as a Letta archival passage.
   * Returns the Letta-assigned passage id, or the original `rec.id` on failure.
   * On server unreachable → logs warning, returns original id (graceful degrade).
   */
  async store(rec: MemoryRecord): Promise<string> {
    try {
      const client = await this.client();
      const createParams: { text: string; tags?: string[] | null } = { text: rec.content };
      if (rec.tags.length > 0) createParams.tags = rec.tags;
      const passages = await client.agents.passages.create(this.agentId, createParams);
      // passages.create returns Array<Passage>; use the id of the first item.
      const first = Array.isArray(passages) ? passages[0] : null;
      return (first != null && typeof (first as { id?: unknown }).id === 'string')
        ? (first as { id: string }).id
        : rec.id;
    } catch (err) {
      this._warn('store', err);
      return rec.id; // graceful degrade — caller already wrote to state
    }
  }

  // --------------------------------------------------------------------------
  // MemoryStore.load — linear scan of passages (no direct get-by-id in SDK)
  // --------------------------------------------------------------------------

  /**
   * Load one record by id. The Letta SDK has no direct get-by-id for archival
   * passages, so we do a linear scan of `passages.list`. Returns a deep copy
   * (by-value, INV #18). Returns null if not found or server unreachable.
   */
  async load(id: string): Promise<MemoryRecord | null> {
    try {
      const client = await this.client();
      const all = await client.agents.passages.list(this.agentId);
      const items = Array.isArray(all) ? all : [];
      for (const p of items) {
        const passage = p as RawPassage;
        if (passage.id === id) {
          return deepCopyRecord(toMemoryRecord(passage));
        }
      }
      return null;
    } catch (err) {
      this._warn('load', err);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // MemoryStore.query — passages.search (semantic / archival search)
  // --------------------------------------------------------------------------

  /**
   * Recall records semantically. Calls Letta `passages.search` with the query text.
   * Returns DEEP COPIES (by-value, INV #18) and AT MOST `q.limit` records (P3).
   * On server unreachable → empty array (graceful degrade).
   */
  async query(q: MemoryQuery): Promise<MemoryRecord[]> {
    try {
      const client = await this.client();
      const searchParams: { query: string; top_k?: number; tags?: string[] | null } = {
        query: q.query,
        top_k: q.limit,
      };
      if (q.tags != null) searchParams.tags = q.tags;
      const resp = await client.agents.passages.search(this.agentId, searchParams);
      // PassageSearchResponse: { count: number, results: Array<{ id, content, tags, ... }> }
      const results: RawSearchResult[] = (resp as RawSearchResponse).results ?? [];
      const limited = results.slice(0, q.limit);
      return limited.map((r) => deepCopyRecord(searchResultToMemoryRecord(r)));
    } catch (err) {
      this._warn('query', err);
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // MemoryStore.delete — passages.delete (soft/physical via same endpoint)
  // --------------------------------------------------------------------------

  /**
   * Delete a passage. The Letta API does a physical delete; block-agent soft-delete
   * semantics (INV #5) are enforced at the command layer. `physical` flag is
   * accepted but both map to the same Letta call here.
   */
  async delete(id: string, _physical?: boolean): Promise<void> {
    try {
      const client = await this.client();
      await client.agents.passages.delete(id, { agent_id: this.agentId });
    } catch (err) {
      this._warn('delete', err);
      // graceful degrade — do not crash the turn loop
    }
  }

  // --------------------------------------------------------------------------
  // coreBlocks() — helper for the CoreBlocksBuilder projection
  // --------------------------------------------------------------------------

  /**
   * Read the agent's Letta core memory blocks. Returns an empty array on failure.
   * The result feeds the `CoreBlocksBuilder` projection (INV #20 — the builder
   * calls this in the command path, not during build; build reads from state only).
   */
  async coreBlocks(): Promise<LettaCoreBlock[]> {
    try {
      const client = await this.client();
      const page = await client.agents.blocks.list(this.agentId);
      // BlockResponsesArrayPage — iterate via the items property or async iteration.
      const items: RawBlockResponse[] = (page as { data?: RawBlockResponse[] }).data
        ?? (Array.isArray(page) ? (page as RawBlockResponse[]) : []);
      return items.map((b) => ({
        label: String(b.label ?? ''),
        value: String(b.value ?? ''),
        read_only: Boolean(b.read_only ?? false),
      }));
    } catch (err) {
      this._warn('coreBlocks', err);
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // setBlock() — helper for memory_letta.set_block command
  // --------------------------------------------------------------------------

  /**
   * Update one Letta core block by label. Returns the updated block or null on failure.
   */
  async setBlock(label: string, value: string): Promise<LettaCoreBlock | null> {
    try {
      const client = await this.client();
      const resp = await client.agents.blocks.update(label, {
        agent_id: this.agentId,
        value,
      });
      const b = resp as RawBlockResponse;
      return {
        label: String(b.label ?? label),
        value: String(b.value ?? value),
        read_only: Boolean(b.read_only ?? false),
      };
    } catch (err) {
      this._warn('setBlock', err);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Static factory: create a new Letta agent on first install
  // --------------------------------------------------------------------------

  /**
   * Create a new Letta agent and return its id. Called from `on_install` when
   * no `agent_id` is configured yet. Returns null on server unreachable.
   */
  static async createAgent(baseUrl?: string): Promise<string | null> {
    try {
      const sdk = await getSdk();
      const apiKey = process.env['LETTA_API_KEY'] ?? 'no-key';
      const client = new sdk.Letta({ apiKey, baseURL: baseUrl ?? 'http://localhost:8283' });
      const agent = await client.agents.create({
        model: 'openai/gpt-4o-mini', // default; user can point at local model via Letta config
        embedding: 'openai/text-embedding-3-small',
        memory_blocks: [
          { label: 'human', value: 'Human user information' },
          { label: 'persona', value: 'block-agent assistant' },
        ],
      });
      return (agent as { id?: unknown }).id != null ? String((agent as { id: string }).id) : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Internal warning helper (never logs API keys)
  // --------------------------------------------------------------------------

  private _warn(method: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    // Truncate to avoid accidental credential leakage in error messages.
    const safe = msg.slice(0, 200);
    console.warn(`[memory_letta] LettaMemoryStore.${method}: Letta server unreachable or error — ${safe}`);
  }
}

// ============================================================================
// Raw SDK shape typings (opaque shapes we cast from SDK responses)
// ============================================================================

/** Raw passage shape from passages.list (Passage type from Letta SDK). */
interface RawPassage {
  id: string;
  text?: string;      // passages.create returns items with `text`
  content?: string;   // some endpoints use `content`
  tags?: string[] | null;
}

/** Raw passage shape from passages.search results. */
interface RawSearchResult {
  id: string;
  content: string;    // search response uses `content` not `text`
  tags?: string[] | null;
}

/** Raw passages.search response envelope. */
interface RawSearchResponse {
  count: number;
  results: RawSearchResult[];
}

/** Raw blocks response shape. */
interface RawBlockResponse {
  id?: string;
  label?: string;
  value?: string;
  read_only?: boolean;
}

// ============================================================================
// Conversion helpers
// ============================================================================

/**
 * Convert a raw Letta passage (from passages.list) to a MemoryRecord.
 * Origin is 'imported' (external / unverified source, INV #21).
 */
function toMemoryRecord(p: RawPassage): MemoryRecord {
  const content = p.content ?? p.text ?? '';
  const tags: string[] = Array.isArray(p.tags) ? [...p.tags] : [];
  const provenance: MemoryProvenance = { origin: 'imported', verified: false };
  return { id: p.id, content, tags, provenance };
}

/**
 * Convert a raw search result (from passages.search) to a MemoryRecord.
 * Origin is 'imported' (from archival / external source, INV #21).
 */
function searchResultToMemoryRecord(r: RawSearchResult): MemoryRecord {
  const content = r.content;
  const tags: string[] = Array.isArray(r.tags) ? [...r.tags] : [];
  const provenance: MemoryProvenance = { origin: 'imported', verified: false };
  return { id: r.id, content, tags, provenance };
}

/**
 * Deep copy a MemoryRecord (by-value, INV #18). All fields are primitives or
 * plain arrays of primitives, so a shallow clone of the record plus a spread
 * of the arrays and provenance object suffices.
 */
function deepCopyRecord(rec: MemoryRecord): MemoryRecord {
  return {
    id: rec.id,
    content: rec.content,
    tags: [...rec.tags],
    provenance: { origin: rec.provenance.origin, verified: rec.provenance.verified },
  };
}
