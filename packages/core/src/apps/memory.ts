/**
 * apps/memory.ts — the built-in `memory` BlockApp (impl-memory owned).
 *
 * Implements the Hermes-style built-in memory: agent notes + user profile,
 * pinning, recall (full-text/substring, no vectors, DR-21), and a provenance
 * fence on all recalled content (H1 / INV #21). Everything is durable JSONL
 * (§12.2 discipline, same as messages/tools) under `.block-agent/apps/memory/`.
 *
 * Authoritative design: ai_com/block-agent-memory-design.md §3.1 / §4 / §5.1 / §7.1
 * and the Implementer split in apps/memory_store.ts lines 285–376.
 *
 * Four projection blocks:
 *   - `memory:pinned`  — pinned notes,      cache_tier `stable`
 *   - `memory:notes`   — agent notes,        cache_tier `slow_changing`
 *   - `memory:user`    — user profile,       cache_tier `slow_changing`
 *   - `memory:recalled`— last recall hits,   cache_tier `volatile` (provenance-fenced)
 *
 * INVARIANTS held here:
 *   #1 / #16  build PURE + byte-identical; provenance no wall-clock; id content-addressed.
 *   #3 / #15  block names `<app_id>:<name>`, one owner builder per name.
 *   #4        builder owner 'system' (never 'agent').
 *   #5        forget = soft-delete (tombstone); physical delete needs block:delete_physical.
 *   #14       state all-JSON + bounded; full log in JSONL.
 *   #21       scanMemoryContent on every write; recalled content in provenance fence.
 *   §12.2     JSONL append-only, ≤64KB/line, lock-file 'wx', startup tail-truncate.
 *
 * House style (§0.5): block-world nouns → `Block` prefix; App itself is `MemoryApp`.
 */

import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Block, BlockName, InvokerContext } from '../core/types.js';
import type {
  AppContext,
  AppManifest,
  BuildContext,
  BuilderManifest,
  Capability,
  CommandManifest,
  CommandResult,
  JsonSchema,
} from '../app/types.js';
import { APPS_DIR, readAppConfig } from './_app_config.js';
import {
  type MemoryRecord,
  type MemoryQuery,
  type MemoryStore,
  fenceRecalledContent,
  scanMemoryContent,
} from './memory_store.js';

// ============================================================================
// Identity & block names
// ============================================================================

/** App id and tree namespace (§3.1). */
const APP_ID = 'memory' as const;
const TREE_NAMESPACE = '/memory' as const;

/** The four blocks this App renders into the prompt (INV #15). */
export const PINNED_BLOCK: BlockName = 'memory:pinned';
export const NOTES_BLOCK: BlockName = 'memory:notes';
export const USER_BLOCK: BlockName = 'memory:user';
export const RECALLED_BLOCK: BlockName = 'memory:recalled';

/** §12.2: each JSONL line MUST be ≤ 64KB. */
const MAX_LINE_BYTES = 64 * 1024;

/** Timeout (ms) spinning for the advisory lock before giving up. */
const LOCK_TIMEOUT_MS = 5_000;

// ============================================================================
// Config (file-seeded; user-only `set_config` to retune at runtime)
// ============================================================================

/**
 * MemoryConfig — tunable knobs seeded from `.block-agent/apps/memory/config.json`
 * over these compiled defaults. Changeable at runtime only by the USER (set_config).
 *   - notes_char_limit   — hard char cap on the notes projection window (Hermes default 2200)
 *   - user_char_limit    — hard char cap on the user profile window (Hermes default 1375)
 *   - recall_limit       — max records returned by a recall (result-set size cap, P3)
 *   - archivist_enabled  — v3.1 placeholder; always false (follow-up milestone)
 */
export interface MemoryConfig {
  notes_char_limit: number;
  user_char_limit: number;
  recall_limit: number;
  archivist_enabled: boolean;
}

/** Compiled defaults (matching Hermes defaults). */
const DEFAULT_CONFIG: MemoryConfig = {
  notes_char_limit: 2200,
  user_char_limit: 1375,
  recall_limit: 8,
  archivist_enabled: false,
};

/** Clamp a config to sane ranges. */
function clampConfig(cfg: MemoryConfig): MemoryConfig {
  return {
    notes_char_limit: Math.max(1, Math.floor(cfg.notes_char_limit)),
    user_char_limit: Math.max(1, Math.floor(cfg.user_char_limit)),
    recall_limit: Math.max(1, Math.min(100, Math.floor(cfg.recall_limit))),
    archivist_enabled: !!cfg.archivist_enabled,
  };
}

// ============================================================================
// State (bounded projection — INV #14)
// ============================================================================

/**
 * MemoryEntry — one entry in the bounded projection window.
 * provenance is deterministic content only (no wall-clock, INV #21).
 */
export interface MemoryEntry {
  id: string;
  target: 'notes' | 'user';
  content: string;
  provenance: { origin: 'agent' | 'user' | 'imported'; verified: boolean };
}

/**
 * MemoryState — bounded projection of notes, user profile, pinned items,
 * last recall hits, and config. Full log stays in JSONL, not in state (INV #14).
 */
export interface MemoryState {
  notes: MemoryEntry[];
  user: MemoryEntry[];
  pinned: MemoryEntry[];
  recalled: MemoryEntry[];
  config: MemoryConfig;
}

/** INV #14: declare every state key so set_state is schema-checked. */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['notes', 'user', 'pinned', 'recalled', 'config'],
  properties: {
    notes: { type: 'array' },
    user: { type: 'array' },
    pinned: { type: 'array' },
    recalled: { type: 'array' },
    config: {
      type: 'object',
      required: ['notes_char_limit', 'user_char_limit', 'recall_limit', 'archivist_enabled'],
      properties: {
        notes_char_limit: { type: 'number' },
        user_char_limit: { type: 'number' },
        recall_limit: { type: 'number' },
        archivist_enabled: { type: 'boolean' },
      },
    },
  },
};

// ============================================================================
// JSONL store — §12.2 discipline (append-only, ≤64KB/line, lock-file 'wx',
//   startup tail-truncate)
// ============================================================================

/**
 * A single JSONL record in the store. Records are either `memory` entries
 * (a full MemoryRecord) or tombstone `delete` ops (soft deletes, INV #5).
 */
type StoreRecord =
  | ({ op: 'memory' } & MemoryRecord)
  | { op: 'delete'; id: string };

/**
 * MemoryJsonlFile — one append-only JSONL file for one target (notes or user).
 * Follows §12.2: each line ≤ 64KB, advisory exclusive lock ('wx'), startup
 * tail-truncate of crash-torn last line. Soft deletes leave a tombstone; physical
 * delete rewrites the file without the target record.
 */
class MemoryJsonlFile {
  private readonly lockPath: string;

  constructor(private readonly path: string) {
    this.lockPath = `${path}.lock`;
    this.truncateIncompleteTail();
  }

  /** Append one record as a single JSONL line under an exclusive advisory lock. */
  append(record: StoreRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_LINE_BYTES) {
      throw new Error(
        `memory jsonl line is ${bytes}B, exceeds the ${MAX_LINE_BYTES}B/line limit (§12.2)`,
      );
    }
    const release = acquireLock(this.lockPath);
    try {
      const fd = openSync(this.path, 'a');
      try {
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
    } finally {
      release();
    }
  }

  /**
   * Read all live (non-deleted) records by folding tombstones. Soft-deleted ids
   * are removed; physical deletes have already been rewritten out (INV #5).
   */
  readLive(): MemoryRecord[] {
    const all = this.readRaw();
    const deleted = new Set<string>();
    const records: MemoryRecord[] = [];
    for (const row of all) {
      if (row.op === 'delete') {
        deleted.add(row.id);
      } else {
        records.push({ id: row.id, content: row.content, tags: row.tags, provenance: row.provenance });
      }
    }
    return records.filter((r) => !deleted.has(r.id));
  }

  /**
   * Rewrite the file keeping only live records (for physical deletes).
   * Rebuilds from scratch on the read-live view.
   */
  rewriteWithout(id: string): void {
    const live = this.readLive().filter((r) => r.id !== id);
    const release = acquireLock(this.lockPath);
    try {
      const lines = live.map((r) => `${JSON.stringify({ op: 'memory', ...r })}\n`).join('');
      writeFileSync(this.path, lines, 'utf8');
    } finally {
      release();
    }
  }

  /** Read all raw records (including tombstones) for folding logic. */
  private readRaw(): StoreRecord[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const out: StoreRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as StoreRecord);
      } catch {
        // Skip unparseable lines (shouldn't happen after tail-truncate).
      }
    }
    return out;
  }

  /** §12.2 startup scan: truncate a crash-torn trailing line. */
  private truncateIncompleteTail(): void {
    if (!existsSync(this.path)) return;
    const buf = readFileSync(this.path);
    if (buf.length === 0) return;
    const lastNewline = buf.lastIndexOf(0x0a); // '\n'
    const keep = lastNewline + 1;
    if (keep === buf.length) return;
    const fd = openSync(this.path, 'r+');
    try {
      ftruncateSync(fd, keep);
    } finally {
      closeSync(fd);
    }
  }
}

/** Portable exclusive advisory lock using atomic 'wx' file creation (§12.2). */
function acquireLock(lockPath: string): () => void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new Error(`memory jsonl lock timeout on ${lockPath} (held too long)`);
      }
      // Tight spin: appends are sub-millisecond; staying synchronous avoids async complexity.
    }
  }
  return () => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already released — releasing twice is harmless */
    }
  };
}

// ============================================================================
// JsonlMemoryStore — implements MemoryStore with JSONL backend
// ============================================================================

/**
 * JsonlMemoryStore — the in-process, JSONL-backed MemoryStore binding (§5.1 /
 * §6.4). Two files: notes.jsonl and user.jsonl under `.block-agent/apps/memory/`.
 * Full-text/substring query (no vectors, DR-21); result ≤ limit (P3).
 * Soft delete = tombstone line folded on read (INV #5).
 * Physical delete = rewrite the file without the target record.
 * Char limit enforcement: reject store() if content exceeds the configured limit.
 */
export class JsonlMemoryStore implements MemoryStore {
  private readonly notes: MemoryJsonlFile;
  private readonly user: MemoryJsonlFile;
  /** Optional char limits (enforced at store time). */
  readonly notesCharLimit: number;
  readonly userCharLimit: number;

  constructor(
    dir: string,
    opts: { notesCharLimit?: number; userCharLimit?: number } = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.notes = new MemoryJsonlFile(join(dir, 'notes.jsonl'));
    this.user = new MemoryJsonlFile(join(dir, 'user.jsonl'));
    this.notesCharLimit = opts.notesCharLimit ?? DEFAULT_CONFIG.notes_char_limit;
    this.userCharLimit = opts.userCharLimit ?? DEFAULT_CONFIG.user_char_limit;
  }

  async store(rec: MemoryRecord): Promise<string> {
    const file = this.fileFor(rec);
    // Enforce char limit before writing (INV #14).
    const limit = rec.tags.includes('user') ? this.userCharLimit : this.notesCharLimit;
    if (rec.content.length > limit) {
      throw new Error(
        `memory content (${rec.content.length} chars) exceeds char limit (${limit}) for this target`,
      );
    }
    file.append({ op: 'memory', ...rec });
    return rec.id;
  }

  async load(id: string): Promise<MemoryRecord | null> {
    // Search both files (the record knows its own target via tags).
    for (const file of [this.notes, this.user]) {
      const live = file.readLive();
      const found = live.find((r) => r.id === id);
      if (found) return { ...found }; // shallow copy (by-value)
    }
    return null;
  }

  async query(q: MemoryQuery): Promise<MemoryRecord[]> {
    const all = [...this.notes.readLive(), ...this.user.readLive()];
    const lower = q.query.toLowerCase();
    // Full-text/substring match (DR-21: no vectors). Tags filter is optional.
    let hits = all.filter((r) => {
      if (!r.content.toLowerCase().includes(lower)) return false;
      if (q.tags && q.tags.length > 0) {
        return q.tags.some((t) => r.tags.includes(t));
      }
      return true;
    });
    // Respect limit (P3: result-set size cap).
    if (hits.length > q.limit) hits = hits.slice(0, q.limit);
    // Return copies (by-value, INV #18).
    return hits.map((r) => ({ ...r, tags: [...r.tags], provenance: { ...r.provenance } }));
  }

  async delete(id: string, physical?: boolean): Promise<void> {
    if (physical) {
      // Physical delete: rewrite both files without this record (gated upstream).
      this.notes.rewriteWithout(id);
      this.user.rewriteWithout(id);
    } else {
      // Soft delete: append a tombstone to whichever file holds the record.
      const rec = await this.load(id);
      if (rec !== null) {
        const file = this.fileForTags(rec.tags);
        file.append({ op: 'delete', id });
      }
    }
  }

  /** Determine which file a record goes to based on its tags. */
  private fileFor(rec: MemoryRecord): MemoryJsonlFile {
    return this.fileForTags(rec.tags);
  }

  private fileForTags(tags: string[]): MemoryJsonlFile {
    return tags.includes('user') ? this.user : this.notes;
  }
}

// ============================================================================
// Builders — four blocks, all owner 'system', PURE (INV #4 / #16)
// ============================================================================

/** Narrow AppContext state to MemoryState; returns null if missing or wrong shape. */
function memoryStateOf(app_ctx: AppContext | undefined): MemoryState | null {
  if (app_ctx === undefined) return null;
  const s = app_ctx.state;
  if (typeof s !== 'object' || s === null) return null;
  const cand = s as Partial<MemoryState>;
  if (
    !Array.isArray(cand.notes) ||
    !Array.isArray(cand.user) ||
    !Array.isArray(cand.pinned) ||
    !Array.isArray(cand.recalled) ||
    cand.config == null
  ) {
    return null;
  }
  return s as MemoryState;
}

/** Render a list of MemoryEntry values as a bullet list. */
function renderEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '(none)';
  return entries
    .map((e) => {
      const tag = e.provenance.verified ? '' : ' [unverified]';
      return `- (${e.provenance.origin}${tag}) ${e.content}`;
    })
    .join('\n');
}

/**
 * PinnedBlockBuilder — owner of `memory:pinned`. Renders pinned entries in the
 * STABLE segment so they stay at the cache head (§3.1). Pure: reads state.pinned
 * only (INV #16). Returns null when no entries are pinned.
 */
const PinnedBlockBuilder: BuilderManifest = {
  name: 'PinnedBlockBuilder',
  version: '1.0.0',
  owner: 'system', // INV #4: 'agent' illegal.
  app_id: APP_ID,
  inputs: [],
  outputs: [PINNED_BLOCK],
  cache_tier: 'stable',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = memoryStateOf(app_ctx);
    if (state === null || state.pinned.length === 0) return null;
    return {
      id: PINNED_BLOCK,
      name: PINNED_BLOCK,
      children: [],
      content_text: `# Pinned memory\n${renderEntries(state.pinned)}`,
      content_blob: null,
    };
  },
};

/**
 * NotesBlockBuilder — owner of `memory:notes`. Renders the bounded agent notes
 * window. cache_tier `slow_changing`: changes only when a remember/forget runs.
 * Pure: reads state.notes only (INV #16).
 */
const NotesBlockBuilder: BuilderManifest = {
  name: 'NotesBlockBuilder',
  version: '1.0.0',
  owner: 'system',
  app_id: APP_ID,
  inputs: [],
  outputs: [NOTES_BLOCK],
  cache_tier: 'slow_changing',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = memoryStateOf(app_ctx);
    if (state === null) return null;
    return {
      id: NOTES_BLOCK,
      name: NOTES_BLOCK,
      children: [],
      content_text: `# Agent notes\n${renderEntries(state.notes)}`,
      content_blob: null,
    };
  },
};

/**
 * UserBlockBuilder — owner of `memory:user`. Renders the bounded user profile
 * window. cache_tier `slow_changing`. Pure: reads state.user only (INV #16).
 */
const UserBlockBuilder: BuilderManifest = {
  name: 'UserBlockBuilder',
  version: '1.0.0',
  owner: 'system',
  app_id: APP_ID,
  inputs: [],
  outputs: [USER_BLOCK],
  cache_tier: 'slow_changing',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = memoryStateOf(app_ctx);
    if (state === null) return null;
    return {
      id: USER_BLOCK,
      name: USER_BLOCK,
      children: [],
      content_text: `# User profile\n${renderEntries(state.user)}`,
      content_blob: null,
    };
  },
};

/**
 * RecalledBlockBuilder — owner of `memory:recalled`. Renders the last recall hits
 * wrapped in the shared provenance isolation fence (§4.3 / INV #21). cache_tier
 * `volatile`: changes each recall turn. Pure: reads state.recalled only (INV #16).
 * Returns null when state.recalled is empty (no recall this turn).
 */
const RecalledBlockBuilder: BuilderManifest = {
  name: 'RecalledBlockBuilder',
  version: '1.0.0',
  owner: 'system',
  app_id: APP_ID,
  inputs: [],
  outputs: [RECALLED_BLOCK],
  cache_tier: 'volatile',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = memoryStateOf(app_ctx);
    if (state === null || state.recalled.length === 0) return null;
    const body = renderEntries(state.recalled);
    const fenced = fenceRecalledContent(body);
    if (fenced.length === 0) return null;
    return {
      id: RECALLED_BLOCK,
      name: RECALLED_BLOCK,
      children: [],
      content_text: fenced,
      content_blob: null,
    };
  },
};

// ============================================================================
// Capabilities
// ============================================================================

const CAP_BLOCK_WRITE: Capability = { name: 'block:write' };
const CAP_BLOCK_DELETE_PHYSICAL: Capability = { name: 'block:delete_physical' };

// ============================================================================
// Commands
// ============================================================================

/**
 * memory.remember({ target, content }) — persist a memory entry.
 * H1: scanMemoryContent first (INV #21); ok:false on hit.
 * Provenance: origin = invoker==='user' ? 'user' : 'agent'; verified = origin==='user'.
 * id: contentAddressedId(content) — FNV-1a hash, deterministic (INV #16 — no random/clock).
 * State-driven projection: pushes to state.notes or state.user with char-limit trimming.
 */
function rememberCommand(app: MemoryApp): CommandManifest<MemoryState> {
  return {
    name: 'remember',
    description: 'Store a memory entry (notes or user profile). H1 scan rejects injections.',
    capabilities: [CAP_BLOCK_WRITE],
    args_schema: {
      type: 'object',
      required: ['target', 'content'],
      properties: {
        target: { type: 'string', enum: ['notes', 'user'] },
        content: { type: 'string' },
      },
    },
    invoke: async (args, ctx, invoker): Promise<CommandResult> => {
      const a = args as { target?: unknown; content?: unknown } | undefined;
      const target = a?.target;
      const content = a?.content;
      if (target !== 'notes' && target !== 'user') {
        return { ok: false, error: 'remember requires target "notes" or "user"' };
      }
      if (typeof content !== 'string' || content.length === 0) {
        return { ok: false, error: 'remember requires non-empty string `content`' };
      }

      // H1: write-injection scan (INV #21).
      const scan = scanMemoryContent(content);
      if (!scan.ok) {
        return { ok: false, error: scan.reason, data: { pattern_id: scan.pattern_id } };
      }

      const origin = invoker.invoker === 'user' ? 'user' : 'agent';
      const verified = origin === 'user';
      // Content-addressed id (INV #16 — no random/clock): stable FNV-1a hash of content.
      const id = contentAddressedId(content);

      // Check for duplicates: if scanMemoryContent cleared this content and the same
      // content-addressed id already exists, return ok:false to avoid duplication.
      const existing = await app.store.load(id);
      if (existing !== null) {
        return { ok: false, error: `memory id ${id} already exists (duplicate content)` };
      }

      const rec: MemoryRecord = {
        id,
        content,
        tags: [target],
        provenance: { origin, verified },
      };
      await app.store.store(rec);

      const entry: MemoryEntry = { id, target, content, provenance: { origin, verified } };
      const cfg = (ctx.state as MemoryState).config;
      const charLimit = target === 'user' ? cfg.user_char_limit : cfg.notes_char_limit;

      ctx.set_state((s) => {
        const ms = s as MemoryState;
        const arr = target === 'user' ? ms.user : ms.notes;
        const pushed = pushBoundedChars([...arr, entry], charLimit);
        return target === 'user'
          ? { ...ms, user: pushed }
          : { ...ms, notes: pushed };
      });

      return { ok: true, data: { id, target, origin } };
    },
  };
}

/**
 * memory.recall({ query, limit?, tags? }) — full-text/substring recall.
 * Writes hits to state.recalled (projected as memory:recalled next turn).
 */
function recallCommand(app: MemoryApp): CommandManifest<MemoryState> {
  return {
    name: 'recall',
    description: 'Recall memory entries matching a query (full-text; result in memory:recalled).',
    capabilities: [CAP_BLOCK_WRITE],
    args_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = args as { query?: unknown; limit?: unknown; tags?: unknown } | undefined;
      if (typeof a?.query !== 'string' || a.query.length === 0) {
        return { ok: false, error: 'recall requires non-empty string `query`' };
      }
      const cfg = (ctx.state as MemoryState).config;
      const requestedLimit = typeof a.limit === 'number' ? Math.floor(a.limit) : cfg.recall_limit;
      const limit = Math.min(requestedLimit, cfg.recall_limit);
      const tags = Array.isArray(a.tags) ? (a.tags as string[]) : undefined;

      const queryArgs: MemoryQuery = { query: a.query, limit };
      if (tags !== undefined) queryArgs.tags = tags;
      const hits = await app.store.query(queryArgs);
      const entries: MemoryEntry[] = hits.map((r) => ({
        id: r.id,
        target: r.tags.includes('user') ? 'user' : 'notes',
        content: r.content,
        provenance: { origin: r.provenance.origin, verified: r.provenance.verified },
      }));

      ctx.set_state((s) => ({ ...(s as MemoryState), recalled: entries }));
      return { ok: true, data: { count: entries.length } };
    },
  };
}

/**
 * memory.pin({ id }) — move a note into the pinned stable segment.
 */
function pinCommand(app: MemoryApp): CommandManifest<MemoryState> {
  return {
    name: 'pin',
    description: 'Pin a memory entry to the stable segment (always in context).',
    capabilities: [CAP_BLOCK_WRITE],
    args_schema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const id = (args as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string' || id.length === 0) {
        return { ok: false, error: 'pin requires a non-empty `id`' };
      }
      const rec = await app.store.load(id);
      if (rec === null) {
        return { ok: false, error: `memory id '${id}' not found` };
      }
      const entry: MemoryEntry = {
        id: rec.id,
        target: rec.tags.includes('user') ? 'user' : 'notes',
        content: rec.content,
        provenance: { ...rec.provenance },
      };

      ctx.set_state((s) => {
        const ms = s as MemoryState;
        // Idempotent: don't add if already pinned.
        if (ms.pinned.some((e) => e.id === id)) return ms;
        return { ...ms, pinned: [...ms.pinned, entry] };
      });
      return { ok: true, data: { pinned: id } };
    },
  };
}

/**
 * memory.unpin({ id }) — remove a note from the pinned segment.
 */
function unpinCommand(): CommandManifest<MemoryState> {
  return {
    name: 'unpin',
    description: 'Remove a memory entry from the stable pinned segment.',
    capabilities: [CAP_BLOCK_WRITE],
    args_schema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const id = (args as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string' || id.length === 0) {
        return { ok: false, error: 'unpin requires a non-empty `id`' };
      }
      const ms = ctx.state as MemoryState;
      if (!ms.pinned.some((e) => e.id === id)) {
        return { ok: false, error: `memory id '${id}' is not pinned` };
      }
      ctx.set_state((s) => ({
        ...(s as MemoryState),
        pinned: (s as MemoryState).pinned.filter((e) => e.id !== id),
      }));
      return { ok: true, data: { unpinned: id } };
    },
  };
}

/**
 * memory.forget({ id }) — soft delete (tombstone, INV #5). All invokers allowed;
 * only needs block:write. The record is archived, not erased — readable via the
 * durable JSONL but folded out of live query results.
 */
function forgetCommand(app: MemoryApp): CommandManifest<MemoryState> {
  return {
    name: 'forget',
    description: 'Soft-delete (archive) a memory entry. All invokers allowed.',
    capabilities: [CAP_BLOCK_WRITE],
    args_schema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const id = (args as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string' || id.length === 0) {
        return { ok: false, error: 'forget requires a non-empty `id`' };
      }
      await app.store.delete(id, false);
      ctx.set_state((s) => {
        const ms = s as MemoryState;
        return {
          ...ms,
          notes: ms.notes.filter((e) => e.id !== id),
          user: ms.user.filter((e) => e.id !== id),
          pinned: ms.pinned.filter((e) => e.id !== id),
          recalled: ms.recalled.filter((e) => e.id !== id),
        };
      });
      return { ok: true, data: { forgotten: id, physical: false } };
    },
  };
}

/**
 * memory.forget_physical({ id }) — physical (irrecoverable) delete (INV #5).
 * Declares `block:delete_physical`: PolicyEngine flatly denies agent invokers
 * (§9.4 default table — agent's denied set includes block:delete_physical).
 * user and app invokers pass through. Handler rewrites the JSONL file without
 * the target record — no invoker check needed here (§9.1 chokepoint already gated).
 */
function forgetPhysicalCommand(app: MemoryApp): CommandManifest<MemoryState> {
  return {
    name: 'forget_physical',
    description:
      'Physically (irrecoverably) remove a memory entry. Requires block:delete_physical — agent invoker is denied by PolicyEngine (INV #5).',
    capabilities: [CAP_BLOCK_DELETE_PHYSICAL],
    args_schema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const id = (args as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string' || id.length === 0) {
        return { ok: false, error: 'forget_physical requires a non-empty `id`' };
      }
      await app.store.delete(id, true);
      ctx.set_state((s) => {
        const ms = s as MemoryState;
        return {
          ...ms,
          notes: ms.notes.filter((e) => e.id !== id),
          user: ms.user.filter((e) => e.id !== id),
          pinned: ms.pinned.filter((e) => e.id !== id),
          recalled: ms.recalled.filter((e) => e.id !== id),
        };
      });
      return { ok: true, data: { forgotten: id, physical: true } };
    },
  };
}

/**
 * memory.set_config({ notes_char_limit?, user_char_limit?, recall_limit?, archivist_enabled? })
 * USER-ONLY: `allowed_invokers: ['user']` (DR-28 gate). Agent cannot retune its own limits.
 */
function setConfigCommand(): CommandManifest<MemoryState> {
  return {
    name: 'set_config',
    description: 'Retune memory config (char limits / recall limit / archivist). User/UI only.',
    capabilities: [CAP_BLOCK_WRITE],
    allowed_invokers: ['user'],
    args_schema: {
      type: 'object',
      properties: {
        notes_char_limit: { type: 'number' },
        user_char_limit: { type: 'number' },
        recall_limit: { type: 'number' },
        archivist_enabled: { type: 'boolean' },
      },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const patch = readConfigPatch(args);
      if (Object.keys(patch).length === 0) {
        return {
          ok: false,
          error:
            'set_config: no valid field (notes_char_limit/user_char_limit/recall_limit/archivist_enabled)',
        };
      }
      ctx.set_state((s) => {
        const ms = s as MemoryState;
        return { ...ms, config: clampConfig({ ...ms.config, ...patch }) };
      });
      return { ok: true, data: { updated: Object.keys(patch) } };
    },
  };
}

/** Pull numeric/boolean config fields from set_config args; ignore unknown keys. */
function readConfigPatch(args: unknown): Partial<MemoryConfig> {
  if (typeof args !== 'object' || args === null) return {};
  const a = args as Record<string, unknown>;
  const patch: Partial<MemoryConfig> = {};
  if (typeof a['notes_char_limit'] === 'number') patch.notes_char_limit = a['notes_char_limit'];
  if (typeof a['user_char_limit'] === 'number') patch.user_char_limit = a['user_char_limit'];
  if (typeof a['recall_limit'] === 'number') patch.recall_limit = a['recall_limit'];
  if (typeof a['archivist_enabled'] === 'boolean') patch.archivist_enabled = a['archivist_enabled'];
  return patch;
}

// ============================================================================
// Pure helpers (no IO, no clock, no random)
// ============================================================================

/**
 * Content-addressed id using FNV-1a 32-bit hash over the content string.
 * Deterministic + stable (INV #16 / #1): same content → same id on replay.
 * Mirrors the invocationIdFor pattern in tools.ts.
 */
function contentAddressedId(content: string): string {
  return `mem.${fnv1a(content)}`;
}

/** FNV-1a 32-bit hex — a stable, dependency-free content hash. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ============================================================================
// Projection helpers
// ============================================================================

/**
 * Push `entry` into `arr` and trim to keep total char count ≤ charLimit.
 * Drops the OLDEST entries first (FIFO). Pure.
 */
function pushBoundedChars(arr: MemoryEntry[], charLimit: number): MemoryEntry[] {
  let total = arr.reduce((sum, e) => sum + e.content.length, 0);
  const result = [...arr];
  // Remove from the front until we're within the limit.
  while (result.length > 0 && total > charLimit) {
    const dropped = result.shift()!;
    total -= dropped.content.length;
  }
  return result;
}

// ============================================================================
// MemoryApp — the BlockApp
// ============================================================================

/** Options for constructing a MemoryApp. */
export interface MemoryAppOptions {
  /** Storage dir (defaults to `.block-agent/apps/memory/`). */
  dir?: string;
  /** Base dir for config-file seed (defaults to `.block-agent/apps`). */
  configBase?: string;
  /** Injectable store for testing (overrides the JSONL store). */
  store?: MemoryStore;
}

/**
 * MemoryApp — the concrete built-in memory BlockApp. `manifest()` produces the
 * AppManifest the AppRegistry installs. Tests inject a temp dir or FakeMemoryStore
 * so the repo's real `.block-agent` is never touched.
 */
export class MemoryApp {
  readonly store: MemoryStore;
  private readonly seedConfig: MemoryConfig;

  constructor(opts: MemoryAppOptions = {}) {
    const dir = opts.dir ?? join(APPS_DIR, APP_ID);
    if (opts.store) {
      this.store = opts.store;
    } else {
      // Build the JSONL store with char limits seeded from config.
      const defaults: Record<string, unknown> = { ...DEFAULT_CONFIG };
      const seeded = readAppConfig(APP_ID, defaults, opts.configBase ?? APPS_DIR);
      const notesCharLimit = typeof seeded['notes_char_limit'] === 'number'
        ? Math.max(1, Math.floor(seeded['notes_char_limit'] as number))
        : DEFAULT_CONFIG.notes_char_limit;
      const userCharLimit = typeof seeded['user_char_limit'] === 'number'
        ? Math.max(1, Math.floor(seeded['user_char_limit'] as number))
        : DEFAULT_CONFIG.user_char_limit;
      this.store = new JsonlMemoryStore(dir, { notesCharLimit, userCharLimit });
    }
    // Seed config from file over compiled defaults.
    const defaults: Record<string, unknown> = { ...DEFAULT_CONFIG };
    const seeded = readAppConfig(APP_ID, defaults, opts.configBase ?? APPS_DIR);
    this.seedConfig = clampConfig(seeded as unknown as MemoryConfig);
  }

  /**
   * The AppManifest to hand to `AppRegistry.install`. Returned widened to the bare
   * `AppManifest` per the team's locked TS2379 convention.
   */
  manifest(): AppManifest {
    const app = this;
    const manifest: AppManifest<MemoryState> = {
      id: APP_ID,
      version: '1.0.0',
      depends_on: [],
      tree_namespace: TREE_NAMESPACE,
      initial_state: {
        notes: [],
        user: [],
        pinned: [],
        recalled: [],
        config: this.seedConfig,
      },
      state_schema: STATE_SCHEMA,
      builders: [
        () => PinnedBlockBuilder,
        () => NotesBlockBuilder,
        () => UserBlockBuilder,
        () => RecalledBlockBuilder,
      ],
      commands: [
        () => rememberCommand(app),
        () => recallCommand(app),
        () => pinCommand(app),
        () => unpinCommand(),
        () => forgetCommand(app),
        () => forgetPhysicalCommand(app),
        () => setConfigCommand(),
      ],
    };
    return manifest as AppManifest;
  }
}

// Re-export store types for tests.
export { type MemoryRecord, type MemoryQuery, type MemoryStore };
export { APPS_DIR };
