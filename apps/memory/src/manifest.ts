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
 * Five projection blocks:
 *   - `memory:pinned`  — pinned notes,      cache_tier `stable`
 *   - `memory:notes`   — agent notes,        cache_tier `slow_changing`
 *   - `memory:user`    — user profile,       cache_tier `slow_changing`
 *   - `memory:recalled`— last recall hits,   cache_tier `volatile` (provenance-fenced)
 *   - `memory:pressure`— context-pressure distillation nudge (P1#1), cache_tier `volatile`
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
import { APPS_DIR, readAppConfig } from '@block-agent/core/apps/_app_config.js';
import {
  type MemoryRecord,
  type MemoryQuery,
  type MemoryStore,
  fenceRecalledContentBounded,
  scanMemoryContent,
} from '@block-agent/core/apps/memory_store.js';
import { MemdirStore } from './memdir_store.js';

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
/** The always-on MEMORY.md index (P1.2 Delta 2) — one line per memory, cache_tier stable. */
export const INDEX_BLOCK: BlockName = 'memory:index';
/** The context-pressure distillation nudge (P1#1) — renders only under pressure. */
export const PRESSURE_BLOCK: BlockName = 'memory:pressure';

/**
 * The pressure ratio at/above which `PressureNudgeBuilder` renders the distillation nudge
 * (P1#1, §E): 0.7 = `base`'s SOFT water, so the nudge is visible across the whole grace
 * band [0.7·E, 0.95·E) — the ≥1-turn window the agent has to distil before the oldest
 * action rows scroll out. Below it the block disappears (no pressure ⇒ no nudge).
 */
const PRESSURE_NUDGE_THRESHOLD = 0.7;

/**
 * Max rows the MEMORY.md index renders before a "还有 X 条" tail (P1.2 Delta 2). A display
 * cap on top of the fence's byte self-bound: keeps the stable index block short so it does
 * not churn the prompt-cache head. The byte ceiling (`renderFenced`) is the hard guarantee;
 * this is the readable top-N cap.
 */
const INDEX_DISPLAY_COUNT = 30;

/**
 * Per-block render ceiling (context-budget §9.2): the MAX UTF-8 bytes EACH of this App's
 * blocks may occupy in the prompt. Declared on the manifest (`render_ceiling_bytes`) so
 * install() counts it toward the dashboard reserve Σ ≤ R — PER BLOCK (缺陷1): memory renders
 * SIX blocks (pinned/notes/user/recalled/index + the P1#1 pressure nudge), so its charge is
 * 6 × this ceiling. ALL FIVE content blocks (pinned/notes/user/recalled/index) SELF-BOUND
 * their fenced output to ≤ this ceiling (§9.4 #3 / P1.2 Delta 3) so the Renderer's uniform
 * per-block clip fast-paths them and never severs the fence token; only the platform-authored
 * pressure nudge is unfenced. The notes/user windows are also char-bounded (2200/1375 chars)
 * well under this. 4 KiB per block: comfortably fits each bounded window + the fenced hits.
 */
export const MEMORY_RENDER_CEILING_BYTES = 4 * 1024;

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

/** The four memory types (skill-memory-wiki §3 frontmatter `type`). */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/**
 * MemoryEntry — one entry in the bounded projection window.
 * provenance is deterministic content only (no wall-clock, INV #21). P1.2 adds `type`
 * (skill-memory-wiki §3 four-class) so the index/notes routing carries the class.
 */
export interface MemoryEntry {
  id: string;
  target: 'notes' | 'user';
  type: MemoryType;
  content: string;
  provenance: { origin: 'agent' | 'user' | 'imported'; verified: boolean };
}

/**
 * IndexEntry — one row in the always-on MEMORY.md index (P1.2 Delta 2). Mirrors the
 * skill-memory-wiki frontmatter index fields: a short name, its type, and a one-line
 * description. Bounded (top-N) and rendered by IndexBlockBuilder in the STABLE segment.
 */
export interface IndexEntry {
  name: string;
  type: MemoryType;
  description: string;
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
  /**
   * The always-on MEMORY.md index (P1.2 Delta 2): one bounded row per live memory.
   * Maintained in sync with notes/user on remember (push) and forget (filter); NEVER
   * read from disk on the render path (pure builder, INV #16). Bounded top-N.
   */
  index: IndexEntry[];
  config: MemoryConfig;
  /**
   * The elastic working-window pressure ratio (P1#1), folded in each render by §3.5
   * consume-refresh from the `context_pressure` contract (`base` provides it). Seeded 0 so
   * a provider-less boot renders no nudge. Drives `PressureNudgeBuilder`: as it approaches 1
   * the agent is nudged to distil durable facts via `memory.remember` before the oldest
   * action rows scroll out of `base`'s byte-bounded window. NATIVE derived state — never
   * written by a memory command (only consume-refresh sets it).
   */
  context_pressure: number;
}

/** INV #14: declare every state key so set_state is schema-checked. */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['notes', 'user', 'pinned', 'recalled', 'index', 'config', 'context_pressure'],
  properties: {
    notes: { type: 'array' },
    user: { type: 'array' },
    pinned: { type: 'array' },
    recalled: { type: 'array' },
    index: { type: 'array' },
    context_pressure: { type: 'number' },
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

  /**
   * Read all live (non-deleted) records for restart restore, split by target file
   * (D1 §5.2). Synchronous + construction-time (NOT the hot path) so the MemoryApp can
   * fold the durable log into `initial_state` before install — mirrors `readAppConfig`'s
   * read-at-construction. The async `MemoryStore.query`/`load` are the runtime path; this
   * is the boot-time bulk read the narrow async interface intentionally omits.
   */
  readAllByTarget(): { notes: MemoryRecord[]; user: MemoryRecord[] } {
    return { notes: this.notes.readLive(), user: this.user.readLive() };
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
    !Array.isArray(cand.index) ||
    cand.config == null
  ) {
    return null;
  }
  return s as MemoryState;
}

/**
 * Render a list of MemoryEntry values as a bullet list. P1.2 (skill-memory-wiki §5.1
 * addendum): the per-entry `[unverified]` / origin text marker is GONE — the trust bit
 * no longer reaches the render path. Every block is wrapped UNCONDITIONALLY in the
 * provenance fence (`renderFenced`), so a poisoned memory is isolated as data regardless
 * of any self-claimed origin. Renders content only; pure + deterministic (INV #1 / #16).
 */
function renderEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '(none)';
  return entries.map((e) => `- ${e.content}`).join('\n');
}

/**
 * renderFenced — wrap a heading + rendered body in the shared provenance isolation fence,
 * SELF-BOUND to the App's render ceiling (skill-memory-wiki §9.4 #3 / P1.2 Delta 3). All
 * FIVE memory blocks (pinned/notes/user/recalled/index) go through this so the whole block
 * is ≤ ceiling BY CONSTRUCTION — the Renderer's uniform per-block clip then fast-paths
 * (no-op) and can NEVER sever the structured fence token (which would pierce INV #21). The
 * `memory:pressure` block is the ONLY render block that does NOT fence (platform-authored
 * nudge, no agent text). Returns '' when the fenced body is empty so the builder renders
 * nothing.
 */
function renderFenced(heading: string, body: string): string {
  return fenceRecalledContentBounded(`${heading}\n${body}`, MEMORY_RENDER_CEILING_BYTES);
}

/**
 * Render the bounded MEMORY.md index (P1.2 Delta 2): top-N `- [name] (type): description`
 * rows + a "还有 X 条" tail when more exist. Each name/description is passed through
 * `scanMemoryContent` (INV #21) and dropped (rendered as a neutral placeholder) if it
 * carries an injection/exfil payload — the index fields are agent-authored and reach the
 * prompt. Pure + deterministic (INV #1 / #16).
 */
function renderIndex(index: IndexEntry[]): string {
  if (index.length === 0) return '(none)';
  const shown = index.slice(0, INDEX_DISPLAY_COUNT);
  const lines = shown.map((e) => {
    const name = scanMemoryContent(e.name).ok ? e.name : '[blocked]';
    const desc = scanMemoryContent(e.description).ok ? e.description : '[blocked]';
    return `- [${name}] (${e.type}): ${desc}`;
  });
  const remaining = index.length - shown.length;
  if (remaining > 0) lines.push(`还有 ${remaining} 条`);
  return lines.join('\n');
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
    const fenced = renderFenced('# Pinned memory', renderEntries(state.pinned));
    if (fenced.length === 0) return null;
    return {
      id: PINNED_BLOCK,
      name: PINNED_BLOCK,
      children: [],
      content_text: fenced,
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
    const fenced = renderFenced('# Agent notes', renderEntries(state.notes));
    if (fenced.length === 0) return null;
    return {
      id: NOTES_BLOCK,
      name: NOTES_BLOCK,
      children: [],
      content_text: fenced,
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
    const fenced = renderFenced('# User profile', renderEntries(state.user));
    if (fenced.length === 0) return null;
    return {
      id: USER_BLOCK,
      name: USER_BLOCK,
      children: [],
      content_text: fenced,
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
    // §9.4 #3 / P1.2 Delta 3: fence-aware SELF-BOUND to the App's render ceiling, so the
    // whole fenced block is ≤ ceiling by construction. The Renderer's uniform per-block
    // clip then fast-paths this block (no-op) and can never cut the structured fence token
    // (which would pierce the INV #21 isolation). Renderer adds no fence semantics — the
    // bound lives here, in the trusted builder, where the fence structure is known.
    const fenced = renderFenced('# Recalled memory', renderEntries(state.recalled));
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

/**
 * IndexBlockBuilder — owner of `memory:index` (P1.2 Delta 2). Renders the always-on
 * MEMORY.md index: a `# Memory index` heading + one `- [name] (type): description` row per
 * live memory, capped at INDEX_DISPLAY_COUNT with a "还有 X 条" tail. cache_tier `stable`
 * (the index changes only on remember/forget). PURE: reads state.index only (INV #16) —
 * NEVER reads disk. SELF-BOUND in the fence to the App render ceiling so the stable block is
 * ≤ ceiling by construction (no prompt-cache-head blow-out). Returns null when empty.
 */
const IndexBlockBuilder: BuilderManifest = {
  name: 'IndexBlockBuilder',
  version: '1.0.0',
  owner: 'system', // INV #4: 'agent' illegal.
  app_id: APP_ID,
  inputs: [],
  outputs: [INDEX_BLOCK],
  cache_tier: 'stable',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = memoryStateOf(app_ctx);
    if (state === null || state.index.length === 0) return null;
    const fenced = renderFenced('# Memory index', renderIndex(state.index));
    if (fenced.length === 0) return null;
    return {
      id: INDEX_BLOCK,
      name: INDEX_BLOCK,
      children: [],
      content_text: fenced,
      content_blob: null,
    };
  },
};

/**
 * PressureNudgeBuilder — owner of `memory:pressure` (P1#1). Renders a distillation nudge
 * when the consumed `context_pressure` ratio crosses `base`'s soft water (≥ 0.7): it tells
 * the agent the elastic action window is filling and to distil durable facts via
 * `memory.remember` before the oldest rows scroll out. cache_tier `volatile` (the ratio
 * changes most turns). PURE: reads `state.context_pressure` only (INV #16) — `Math.round`
 * over a stored ratio is deterministic (no clock/random). Returns null below the threshold
 * (the block disappears) so it costs nothing when there is no pressure.
 */
const PressureNudgeBuilder: BuilderManifest = {
  name: 'PressureNudgeBuilder',
  version: '1.0.0',
  owner: 'system', // INV #4: 'agent' illegal.
  app_id: APP_ID,
  inputs: [],
  outputs: [PRESSURE_BLOCK],
  cache_tier: 'volatile',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = memoryStateOf(app_ctx);
    if (state === null) return null;
    const pressure = typeof state.context_pressure === 'number' ? state.context_pressure : 0;
    if (pressure < PRESSURE_NUDGE_THRESHOLD) return null;
    const pct = Math.round(pressure * 100);
    return {
      id: PRESSURE_BLOCK,
      name: PRESSURE_BLOCK,
      children: [],
      content_text:
        `# 上下文压力\n上下文压力 ${pct}%，动作窗口接近预算上限。请用 \`memory.remember\` ` +
        `把需要长期保留的耐久事实蒸馏进记忆，避免随窗口滚动丢失。`,
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

      const type: MemoryType = target === 'user' ? 'user' : 'feedback';
      const entry: MemoryEntry = { id, target, type, content, provenance: { origin, verified } };
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
      const entries: MemoryEntry[] = hits.map((r) => {
        const target: 'notes' | 'user' = r.tags.includes('user') ? 'user' : 'notes';
        const type: MemoryType = target === 'user' ? 'user' : 'feedback';
        return {
          id: r.id,
          target,
          type,
          content: r.content,
          provenance: { origin: r.provenance.origin, verified: r.provenance.verified },
        };
      });

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
      const target: 'notes' | 'user' = rec.tags.includes('user') ? 'user' : 'notes';
      const type: MemoryType = target === 'user' ? 'user' : 'feedback';
      const entry: MemoryEntry = {
        id: rec.id,
        target,
        type,
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

/** Project a durable MemoryRecord into the bounded-projection MemoryEntry shape. */
function entryFromRecord(rec: MemoryRecord): MemoryEntry {
  const target: 'notes' | 'user' = rec.tags.includes('user') ? 'user' : 'notes';
  const type: MemoryType = target === 'user' ? 'user' : 'feedback';
  return {
    id: rec.id,
    target,
    type,
    content: rec.content,
    provenance: { origin: rec.provenance.origin, verified: rec.provenance.verified },
  };
}

/**
 * Restore the bounded notes/user projection from the durable JSONL at construction
 * (D1 §5.2). Folds each file's live records (tombstones already applied) into entries and
 * applies the SAME per-target char bound the live `remember` path uses (`pushBoundedChars`),
 * so the booted window is bounded. Pure function of the JSONL + config; reads NO clock, NO
 * random — ids are loaded (content-addressed), never regenerated. `pinned`/`recalled` have
 * no durable backing of their own, so they boot empty (unchanged from before).
 *
 * Robustness (mirrors `readAppConfig`): an injected non-JSONL store or any read failure →
 * empty notes/user (zero regression), never throws at boot. Missing files already yield
 * empty live records via the store's read-live.
 */
function restoreMemory(
  store: MemoryStore,
  config: MemoryConfig,
): { notes: MemoryEntry[]; user: MemoryEntry[] } {
  if (!(store instanceof MemdirStore)) return { notes: [], user: [] };
  let live: { notes: MemoryRecord[]; user: MemoryRecord[] };
  try {
    live = store.readAllByTarget();
  } catch {
    return { notes: [], user: [] }; // torn/unreadable residue → empty, never throw.
  }
  return {
    notes: pushBoundedChars(live.notes.map(entryFromRecord), config.notes_char_limit),
    user: pushBoundedChars(live.user.map(entryFromRecord), config.user_char_limit),
  };
}

// ============================================================================
// MemoryApp — the BlockApp
// ============================================================================

/** Options for constructing a MemoryApp. */
export interface MemoryAppOptions {
  /**
   * Storage dir for the durable JSONL — **required** (no implicit cwd fallback).
   * The caller (launch.ts in production, a temp dir in tests) must always give the
   * data an explicit home. Omitted only when an injected `store` supplies its own.
   */
  dir: string;
  /**
   * Base dir for the config-file seed (optional). When omitted, the config file is
   * NOT read (compiled defaults are used) — there is no cwd-relative fallback read.
   */
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
  /** Bounded notes/user projection re-hydrated from the durable JSONL at construction. */
  private readonly seedProjection: { notes: MemoryEntry[]; user: MemoryEntry[] };

  constructor(opts: MemoryAppOptions) {
    // dir is the data's explicit home — no implicit cwd fallback. The TS type already
    // marks it required (so every caller is forced to pass it); this is the runtime
    // fence for un-typed / hot-install callers.
    if (opts.dir === undefined) {
      throw new Error('MemoryApp requires an explicit data dir; no implicit cwd fallback');
    }
    const dir = opts.dir;
    // Seed config from file ONLY when configBase is given. Omitted → compiled defaults,
    // never a cwd-relative read.
    const seeded: Record<string, unknown> = opts.configBase === undefined
      ? { ...DEFAULT_CONFIG }
      : readAppConfig(APP_ID, { ...DEFAULT_CONFIG }, opts.configBase);
    if (opts.store) {
      this.store = opts.store;
    } else {
      // Build the JSONL store with char limits seeded from config.
      const notesCharLimit = typeof seeded['notes_char_limit'] === 'number'
        ? Math.max(1, Math.floor(seeded['notes_char_limit'] as number))
        : DEFAULT_CONFIG.notes_char_limit;
      const userCharLimit = typeof seeded['user_char_limit'] === 'number'
        ? Math.max(1, Math.floor(seeded['user_char_limit'] as number))
        : DEFAULT_CONFIG.user_char_limit;
      this.store = new MemdirStore(dir, { notesCharLimit, userCharLimit });
    }
    this.seedConfig = clampConfig(seeded as unknown as MemoryConfig);
    // Restart restore (D1 §5.2): re-hydrate the bounded notes/user projection from the
    // durable JSONL at construction (pinned/recalled have no durable backing → empty).
    // Missing/torn files or an injected non-JSONL store → empty (zero regression).
    this.seedProjection = restoreMemory(this.store, this.seedConfig);
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
      // P1#1: memory CONSUMES the `context_pressure` contract (base provides it) into
      // `state.context_pressure`; consume-refresh folds the scalar each render, and
      // PressureNudgeBuilder renders the distillation nudge as it approaches 1. Identity-
      // free (§3.2): memory never names base. cardinality:'one'/combine:'first' → the one
      // provider's ratio is taken verbatim; a provider-less boot keeps the seed (0).
      consumes: [{ contract: 'context_pressure', as: 'context_pressure' }],
      // Context-budget reservation (§9.2 ①): install() counts this toward the dashboard
      // reserve Σ ≤ R, and the Renderer clips each memory block to it (§9.2 ②). The
      // recalled builder self-bounds its fenced output to the SAME value (§9.4 #3).
      render_ceiling_bytes: MEMORY_RENDER_CEILING_BYTES,
      tree_namespace: TREE_NAMESPACE,
      // initial_state carries the file-seeded config AND the bounded notes/user projection
      // re-hydrated from the durable JSONL at construction (D1 §5.2 restart restore): a
      // restart boots with notes/user intact (char-bounded). pinned/recalled have no
      // durable backing of their own, so they boot empty (unchanged).
      initial_state: {
        notes: this.seedProjection.notes,
        user: this.seedProjection.user,
        pinned: [],
        recalled: [],
        index: [],
        config: this.seedConfig,
        // P1#1 consumed pressure: seed 0 so a provider-less boot renders no nudge.
        context_pressure: 0,
      },
      state_schema: STATE_SCHEMA,
      builders: [
        () => PinnedBlockBuilder,
        () => NotesBlockBuilder,
        () => UserBlockBuilder,
        () => RecalledBlockBuilder,
        // P1.2 Delta 2: always-on MEMORY.md index, stable segment.
        () => IndexBlockBuilder,
        // P1#1 distillation nudge — renders only when context_pressure ≥ the soft water.
        () => PressureNudgeBuilder,
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
