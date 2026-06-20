/**
 * apps/memory/src/memdir_store.ts — the MemdirStore backend (P1.2, impl-memory owned).
 *
 * Replaces the prior JSONL backend as the PRODUCTION binding of the shared `MemoryStore`
 * contract (apps/memory_store.ts). The interface SHAPE is unchanged (store/load/query/
 * delete) so the seven memory commands need NO change (Product A2 hard gate).
 *
 * Storage layout (skill-memory-wiki §3 / §9): one markdown file per record under
 *   `<dir>/<type>-<slug>.md`
 * where `slug` is the kebab of the record's description (collision → a short content
 * hash suffix). The markdown BODY is the content; the frontmatter carries ONLY the
 * inert, self-describing fields:
 *   id / type / name / description / scope: private   (+ archived: true on a tombstone)
 *
 * TRUST RED LINE (skill-memory-wiki §5.1, P1.2 addendum): the trust bits
 * (origin / verified) are NEVER written to disk — there is nothing on disk to forge.
 * Everything read back from this private, agent-writable directory is stamped
 * `{ origin: 'agent', verified: false }` by physical location (= private dir = untrusted),
 * fail-closed. A hand-written `origin: user` in a .md file therefore CANNOT promote a
 * record's trust — the field is not even read. The render path fences all five blocks
 * unconditionally on top of this (manifest.ts), so a poisoned memory is never read as an
 * instruction (INV #21).
 *
 * INVARIANTS held here:
 *   #5   delete = archive (soft tombstone via `archived: true` frontmatter, folded on read);
 *        physical delete = unlinkSync (gated upstream by block:delete_physical).
 *   #16  id is content-addressed (`mem.<fnv1a(content)>`) — never random/clock; same content
 *        → same id → same file → de-dup preserved. load/query/delete address by ID, not by
 *        filename.
 *   #18  query/load return by-value copies.
 *
 * ZERO new core dependency: this file lives in @block-agent/app-memory and uses only
 * node:fs/node:path + the shared contract types. The trust stamp is applied here, in the
 * trusted app code, by location — never derived from file content.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type {
  MemoryQuery,
  MemoryRecord,
  MemoryStore,
} from '@block-agent/core/apps/memory_store.js';

/** The four record types (skill-memory-wiki §3 frontmatter `type`). */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** The set of valid frontmatter types, for parse-time validation. */
const MEMORY_TYPES: ReadonlySet<string> = new Set<MemoryType>([
  'user',
  'feedback',
  'project',
  'reference',
]);

/** Default char limits (mirrors manifest DEFAULT_CONFIG; the store enforces at write time). */
const DEFAULT_NOTES_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;

/**
 * The frontmatter we persist — INERT, self-describing fields ONLY. The trust bits
 * (origin/verified) are deliberately absent: they are stamped by physical location on
 * read, never trusted from disk (skill-memory-wiki §5.1).
 */
interface MemdirFrontmatter {
  id: string;
  type: MemoryType;
  name: string;
  description: string;
  scope: 'private';
  /** Present + true only on a soft-deleted (archived) record (INV #5 tombstone). */
  archived?: boolean;
}

/** A parsed record file: its frontmatter + the markdown body (= content). */
interface MemdirEntry {
  frontmatter: MemdirFrontmatter;
  content: string;
  /** The basename on disk, so we can unlink/rewrite the exact file. */
  file: string;
}

/**
 * MemdirStore — the markdown-directory MemoryStore binding (P1.2). One .md file per
 * record; soft delete = `archived: true` tombstone folded on read; physical delete =
 * unlink. Full-text/substring query (no vectors, DR-21), result ≤ limit (P3). Reads back
 * with a fail-closed, location-based trust stamp (always untrusted).
 */
export class MemdirStore implements MemoryStore {
  readonly notesCharLimit: number;
  readonly userCharLimit: number;

  constructor(
    private readonly dir: string,
    opts: { notesCharLimit?: number; userCharLimit?: number } = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.notesCharLimit = opts.notesCharLimit ?? DEFAULT_NOTES_CHAR_LIMIT;
    this.userCharLimit = opts.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT;
  }

  async store(rec: MemoryRecord): Promise<string> {
    // Enforce char limit before writing (INV #14), mirroring the JSONL backend.
    const type = typeFromRecord(rec);
    const limit = type === 'user' ? this.userCharLimit : this.notesCharLimit;
    if (rec.content.length > limit) {
      throw new Error(
        `memory content (${rec.content.length} chars) exceeds char limit (${limit}) for this target`,
      );
    }

    const frontmatter: MemdirFrontmatter = {
      id: rec.id,
      type,
      name: nameFromRecord(rec),
      description: descriptionFromRecord(rec),
      scope: 'private',
    };

    // Find the existing on-disk file for this id (de-dup by content-addressed id), or
    // mint a fresh, collision-free filename from the description slug.
    const existing = this.fileForId(rec.id);
    const file = existing ?? this.freshFilename(frontmatter);
    this.writeAtomic(file, frontmatter, rec.content);
    return rec.id;
  }

  async load(id: string): Promise<MemoryRecord | null> {
    for (const entry of this.scan()) {
      if (entry.frontmatter.archived) continue; // fold tombstones (INV #5)
      if (entry.frontmatter.id === id) return this.toRecord(entry);
    }
    return null;
  }

  async query(q: MemoryQuery): Promise<MemoryRecord[]> {
    const lower = q.query.toLowerCase();
    const hits: MemoryRecord[] = [];
    for (const entry of this.scan()) {
      if (entry.frontmatter.archived) continue; // fold tombstones (INV #5)
      if (!entry.content.toLowerCase().includes(lower)) continue;
      if (q.tags && q.tags.length > 0) {
        // The only tag a private memory carries is its target bucket (notes/user); the
        // record's type maps to that bucket so tag filters still resolve.
        const bucket = entry.frontmatter.type === 'user' ? 'user' : 'notes';
        if (!q.tags.includes(bucket)) continue;
      }
      hits.push(this.toRecord(entry));
      if (hits.length >= q.limit) break; // result-set cap (P3)
    }
    return hits;
  }

  async delete(id: string, physical?: boolean): Promise<void> {
    const entry = this.fileEntryForId(id);
    if (entry === null) return;
    if (physical) {
      // Physical delete (gated upstream): erase the file.
      try {
        unlinkSync(join(this.dir, entry.file));
      } catch {
        /* already gone — idempotent */
      }
      return;
    }
    // Soft delete: rewrite the file's frontmatter with archived: true (INV #5 tombstone).
    if (entry.frontmatter.archived) return; // already archived
    this.writeAtomic(entry.file, { ...entry.frontmatter, archived: true }, entry.content);
  }

  /**
   * Read all live (non-archived) records for restart restore, split by target bucket
   * (skill-memory-wiki §3). Synchronous + construction-time bulk read (NOT the hot path),
   * mirroring the JSONL backend's `readAllByTarget`. `type: 'user'` → user bucket; every
   * other type (feedback/project/reference) → notes bucket. Reads back fail-closed
   * untrusted (location-based stamp), like query/load.
   */
  readAllByTarget(): { notes: MemoryRecord[]; user: MemoryRecord[] } {
    const notes: MemoryRecord[] = [];
    const user: MemoryRecord[] = [];
    for (const entry of this.scan()) {
      if (entry.frontmatter.archived) continue; // fold tombstones (INV #5)
      const rec = this.toRecord(entry);
      if (entry.frontmatter.type === 'user') user.push(rec);
      else notes.push(rec);
    }
    return { notes, user };
  }

  // --------------------------------------------------------------------------
  // internals
  // --------------------------------------------------------------------------

  /**
   * Project a parsed on-disk entry into a MemoryRecord with the FAIL-CLOSED,
   * location-based trust stamp: everything from this private dir reads back
   * `{ origin: 'agent', verified: false }` regardless of any frontmatter the file
   * may carry (skill-memory-wiki §5.1). `tags` is the target bucket so downstream
   * (recall projection, restore) routes it. By-value (INV #18) — fresh objects.
   */
  private toRecord(entry: MemdirEntry): MemoryRecord {
    const bucket = entry.frontmatter.type === 'user' ? 'user' : 'notes';
    return {
      id: entry.frontmatter.id,
      content: entry.content,
      tags: [bucket],
      // Location-based stamp — NEVER read origin/verified from disk (fail-closed).
      provenance: { origin: 'agent', verified: false },
    };
  }

  /** Scan the dir and parse every .md file. Unreadable/garbage files are skipped. */
  private scan(): MemdirEntry[] {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: MemdirEntry[] = [];
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const parsed = this.parseFile(file);
      if (parsed !== null) out.push(parsed);
    }
    // Deterministic order (by filename) so query/restore are stable across runs.
    out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return out;
  }

  /** Parse one .md file into an entry, or null if it is unreadable / malformed. */
  private parseFile(file: string): MemdirEntry | null {
    let text: string;
    try {
      text = readFileSync(join(this.dir, file), 'utf8');
    } catch {
      return null;
    }
    const parsed = parseFrontmatter(text);
    if (parsed === null) return null;
    return { frontmatter: parsed.frontmatter, content: parsed.body, file };
  }

  /** Find the on-disk basename for a content-addressed id (any state), or null. */
  private fileForId(id: string): string | null {
    const entry = this.fileEntryForId(id);
    return entry === null ? null : entry.file;
  }

  /** Find the full parsed entry for an id INCLUDING archived ones (for delete). */
  private fileEntryForId(id: string): MemdirEntry | null {
    for (const entry of this.scan()) {
      if (entry.frontmatter.id === id) return entry;
    }
    return null;
  }

  /**
   * Mint a collision-free filename `<type>-<slug>.md` from the description. On a slug
   * collision with a DIFFERENT id already on disk, suffix a short content hash so two
   * distinct records never share a file.
   */
  private freshFilename(fm: MemdirFrontmatter): string {
    const slug = kebab(fm.description) || 'untitled';
    const base = `${fm.type}-${slug}`;
    let candidate = `${base}.md`;
    if (!existsSync(join(this.dir, candidate))) return candidate;
    // Collision: append a short hash of the id (stable, deterministic).
    const suffix = shortHash(fm.id);
    candidate = `${base}-${suffix}.md`;
    return candidate;
  }

  /** Atomic write: temp file + rename (no torn reads). */
  private writeAtomic(file: string, fm: MemdirFrontmatter, body: string): void {
    const full = join(this.dir, file);
    const tmp = `${full}.tmp`;
    writeFileSync(tmp, serializeFile(fm, body), 'utf8');
    renameSync(tmp, full);
  }
}

// ============================================================================
// Pure helpers — frontmatter (de)serialization, slug, hash, field mapping
// ============================================================================

/**
 * Derive the record `type` from a MemoryRecord. The store contract carries no `type`
 * field, so the command layer encodes it in `tags` as `type:<x>` (alongside the target
 * bucket). Fall back to the target bucket: `user` → 'user', else 'feedback'.
 */
function typeFromRecord(rec: MemoryRecord): MemoryType {
  const tagged = rec.tags.find((t) => t.startsWith('type:'));
  if (tagged !== undefined) {
    const t = tagged.slice('type:'.length);
    if (MEMORY_TYPES.has(t)) return t as MemoryType;
  }
  return rec.tags.includes('user') ? 'user' : 'feedback';
}

/** Derive the `name` from a `name:<x>` tag, else the content-addressed id. */
function nameFromRecord(rec: MemoryRecord): string {
  const tagged = rec.tags.find((t) => t.startsWith('name:'));
  if (tagged !== undefined) return tagged.slice('name:'.length);
  return rec.id;
}

/** Derive the `description` from a `desc:<x>` tag, else a clipped content preview. */
function descriptionFromRecord(rec: MemoryRecord): string {
  const tagged = rec.tags.find((t) => t.startsWith('desc:'));
  if (tagged !== undefined) return tagged.slice('desc:'.length);
  // Fall back to a one-line content preview (first 80 chars, single line).
  const oneLine = rec.content.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? oneLine.slice(0, 80) : oneLine;
}

/** Serialize a record file: YAML-lite frontmatter + a blank line + the markdown body. */
function serializeFile(fm: MemdirFrontmatter, body: string): string {
  const lines = [
    '---',
    `id: ${yamlScalar(fm.id)}`,
    `type: ${yamlScalar(fm.type)}`,
    `name: ${yamlScalar(fm.name)}`,
    `description: ${yamlScalar(fm.description)}`,
    `scope: ${yamlScalar(fm.scope)}`,
  ];
  if (fm.archived) lines.push('archived: true');
  lines.push('---', '', body);
  return lines.join('\n');
}

/**
 * Parse a record file's frontmatter + body. Returns null when the frontmatter block is
 * missing, malformed, or missing required fields (fail-closed: a malformed file is
 * skipped, never half-loaded). The trust fields are intentionally NOT parsed.
 */
function parseFrontmatter(text: string): { frontmatter: MemdirFrontmatter; body: string } | null {
  if (!text.startsWith('---')) return null;
  // Split off the leading frontmatter block delimited by `---` ... `---`.
  const rest = text.slice(3);
  const endRel = rest.indexOf('\n---');
  if (endRel < 0) return null;
  const block = rest.slice(0, endRel);
  // Body starts after the closing `---` line.
  let bodyStart = endRel + '\n---'.length;
  // Skip the rest of the closing line + one optional blank line.
  if (rest[bodyStart] === '\r') bodyStart++;
  if (rest[bodyStart] === '\n') bodyStart++;
  if (rest[bodyStart] === '\n') bodyStart++; // the blank line after the fence
  const body = rest.slice(bodyStart);

  const fields: Record<string, string> = {};
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fields[key] = unyamlScalar(value);
  }

  const id = fields['id'];
  const type = fields['type'];
  if (id === undefined || id.length === 0) return null;
  if (type === undefined || !MEMORY_TYPES.has(type)) return null;

  const frontmatter: MemdirFrontmatter = {
    id,
    type: type as MemoryType,
    name: fields['name'] ?? id,
    description: fields['description'] ?? '',
    scope: 'private',
    archived: fields['archived'] === 'true',
  };
  return { frontmatter, body };
}

/** Quote a YAML scalar so colons/newlines/leading specials round-trip safely. */
function yamlScalar(value: string): string {
  // Collapse newlines (frontmatter is single-line per field) and double-quote.
  const flat = value.replace(/\r?\n/g, ' ');
  return JSON.stringify(flat); // JSON string == a valid double-quoted YAML scalar.
}

/** Inverse of yamlScalar: unquote a double-quoted scalar; pass through a bare scalar. */
function unyamlScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Kebab-case a description into a filename-safe slug (ASCII alnum + hyphen, ≤ 48 chars). */
function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/** A short, stable, deterministic hash suffix (FNV-1a hex) for slug-collision tie-breaks. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}
