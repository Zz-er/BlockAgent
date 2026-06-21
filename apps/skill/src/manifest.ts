/**
 * apps/skill/src/manifest.ts — the `skill` BlockApp (impl-skill owned).
 *
 * Implements the progressive-disclosure skill mechanism (§2 SSOT): index stable, body
 * metered on invoke (8KB/N=3/LRU). Skills are authored as markdown+frontmatter files
 * under a platform-configured `skillsDir` (constructor injection), read once at install
 * (on_install → initial_state.index) — no runtime file IO in builders.
 *
 * Three projection blocks:
 *   - `skill:index`  — available skills list,   cache_tier `stable`
 *   - `skill:active` — open skill bodies,        cache_tier `volatile` (metered 8KB/N=3/LRU)
 *
 * Commands:
 *   - invoke         — load a skill's body (with $ARGUMENTS substitution) into active
 *   - close          — remove a skill from active
 *   - list           — readonly, list available skills
 *   - index_provider — app-only readonly, returns index (never provides externally, §2)
 *   - set_config     — user-only retune of metering knobs
 *
 * INVARIANTS held here:
 *   #1 / #16  build PURE + byte-identical; no IO in builders; index from state only.
 *   #3 / #15  block names `<app_id>:<name>`, one owner builder per name.
 *   #4        builder owner 'system' (never 'agent').
 *   #14       state all-JSON + bounded (open set bounded by LRU + byte cap).
 *   #21       skill body text is fenced in skill:active (agent-authored file content = untrusted).
 *
 * v1: all trusted authors, no untrusted/sandboxed skills. Source stamp by physical directory
 * location (SKILL.md file path relative to skillsDir), never from frontmatter self-declared fields.
 * Fail-closed: parse failure → default untrusted → skill body fenced.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import type { Block, BlockName } from '@block-agent/core/core/types.js';
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
  type ScanResult,
  fenceRecalledContentBounded,
  scanMemoryContent,
} from '@block-agent/core/apps/memory_store.js';

// ============================================================================
// Identity & block names
// ============================================================================

/** App id and tree namespace (§2). */
const APP_ID = 'skill' as const;
const TREE_NAMESPACE = '/skill' as const;

/** The two blocks this App renders into the prompt. */
export const INDEX_BLOCK: BlockName = 'skill:index';
export const ACTIVE_BLOCK: BlockName = 'skill:active';

// ============================================================================
// Metering constants (user-tunable via set_config)
// ============================================================================

/** Default maximum UTF-8 bytes the active block may render (8KB per §2). */
const DEFAULT_ACTIVE_BYTE_CEILING = 8 * 1024;

/** Default maximum number of simultaneously open skills (N=3 per §2). */
const DEFAULT_ACTIVE_COUNT_CAP = 3;

/**
 * Per-block render ceiling (context-budget §9.2): the MAX UTF-8 bytes EACH skill block
 * may occupy in the prompt. Declared on the manifest so install() counts it toward the
 * dashboard reserve Σ ≤ R. TWO blocks (index + active) = 2 × this ceiling charge.
 */
export const SKILL_RENDER_CEILING_BYTES = 8 * 1024;

// ============================================================================
// Config (file-seeded; user-only `set_config` to retune at runtime)
// ============================================================================

export interface SkillConfig {
  /** Hard byte cap on the skill:active rendered block (default 8KB). */
  active_byte_ceiling: number;
  /** Max simultaneously open skills (N, default 3); LRU eviction when exceeded. */
  active_count_cap: number;
}

const DEFAULT_CONFIG: SkillConfig = {
  active_byte_ceiling: DEFAULT_ACTIVE_BYTE_CEILING,
  active_count_cap: DEFAULT_ACTIVE_COUNT_CAP,
};

function clampConfig(cfg: SkillConfig): SkillConfig {
  return {
    active_byte_ceiling: Math.max(1024, Math.floor(cfg.active_byte_ceiling)),
    active_count_cap: Math.max(1, Math.min(10, Math.floor(cfg.active_count_cap))),
  };
}

// ============================================================================
// State (bounded projection — INV #14)
// ============================================================================

/**
 * SkillIndexEntry — one skill in the always-on index. Read at install time from
 * SKILL.md frontmatter + physical file path. Source is stamped by physical directory
 * location, never from frontmatter self-declared fields (§2).
 */
export interface SkillIndexEntry {
  /** The skill name (from frontmatter `name`). */
  name: string;
  /** One-line summary (from frontmatter `description`). */
  description: string;
  /**
   * When the agent should invoke this skill (from frontmatter `whenToUse`). OPTIONAL key:
   * absent (not `undefined`-valued) when the frontmatter omits it — App state forbids
   * `undefined` values (assertJsonSerializable), so the key must be omitted, not set to undefined.
   */
  whenToUse?: string;
  /** Physical file path relative to skillsDir — source stamp (trusted code assigns). */
  file_path: string;
}

/**
 * SkillActiveEntry — one currently-open skill in the volatile projection.
 * body is the markdown content with $ARGUMENTS already substituted.
 * loaded_at is a monotonic counter for LRU eviction (not wall-clock, INV #16).
 */
export interface SkillActiveEntry {
  name: string;
  /** The substituted skill body text. */
  body: string;
  /** Monotonic load counter for LRU (deterministic, INV #16). */
  loaded_at: number;
}

/**
 * SkillState — bounded projection. Index is loaded once (on_install), active is
 * metered volatile (capped at N entries + byte ceiling).
 */
export interface SkillState {
  index: SkillIndexEntry[];
  open: Record<string, SkillActiveEntry>;
  config: SkillConfig;
  /**
   * Monotonic load counter — incremented on each skill.invoke so LRU eviction is
   * deterministic and wall-clock-free (INV #16). Seeded at 0.
   */
  load_counter: number;
}

/** INV #14: declare every state key so set_state is schema-checked. */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['index', 'open', 'config', 'load_counter'],
  properties: {
    index: { type: 'array' },
    open: { type: 'object' },
    load_counter: { type: 'number' },
    config: {
      type: 'object',
      required: ['active_byte_ceiling', 'active_count_cap'],
      properties: {
        active_byte_ceiling: { type: 'number' },
        active_count_cap: { type: 'number' },
      },
    },
  },
};

// ============================================================================
// SKILL.md parser — frontmatter + body
// ============================================================================

/**
 * Raw parsed SKILL.md content. Frontmatter is YAML-lite (key: value pairs); body is
 * everything after the closing `---`.
 */
interface ParsedSkillFile {
  name: string;
  description: string;
  whenToUse: string | undefined;
  allowedTools: string[] | undefined;
  body: string;
}

/**
 * Parse a SKILL.md file's frontmatter (YAML-lite: only top-level string keys, no
 * nesting/arrays/quoting — matching the MemdirStore frontmatter dialect, §3).
 * Fail-closed: any parse failure → null (caller must handle — v1 default untrusted).
 *
 * Expected frontmatter shape:
 *   ---
 *   name: <string>
 *   description: <string>
 *   whenToUse: <string>   (optional)
 *   allowedTools: <comma-separated list>  (optional, §2 — non-binding hint)
 *   ---
 *   body markdown...
 */
function parseSkillMd(raw: string, relPath: string): ParsedSkillFile | null {
  // Must start with frontmatter delimiter.
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return null;

  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);

  // Find closing `---`
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return null; // no closing delimiter

  // Parse frontmatter lines (key: value)
  const fm: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue; // skip malformed lines (fail-soft)
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length > 0 && value.length > 0) {
      fm[key] = value;
    }
  }

  // Required fields
  const name = fm['name'];
  const description = fm['description'];
  if (!name || !description) return null; // required fields missing → fail-closed

  // Optional fields
  const whenToUse = fm['whenToUse'];
  const allowedToolsRaw = fm['allowedTools'];
  const allowedTools = allowedToolsRaw
    ? allowedToolsRaw.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined;

  // Body: everything after the closing `---`
  const body = lines.slice(end + 1).join('\n');

  return { name, description, whenToUse, allowedTools, body };
}

// ============================================================================
// Source stamp — by physical directory location
// ============================================================================

/**
 * Read the skills directory and build the initial index. Each `.md` file is parsed
 * as a SKILL.md; non-markdown files are skipped. Source stamp = relative path from
 * skillsDir (trusted code assigns, never from frontmatter). Fail-closed: a file that
 * fails to parse is skipped (no entry in the index) — it is never default-trusted.
 *
 * Synchronous (called at construct/install time, NOT in builders — INV #1 safe).
 */
function buildSkillIndex(skillsDir: string): SkillIndexEntry[] {
  const entries: SkillIndexEntry[] = [];

  if (!existsSync(skillsDir)) return entries;
  if (!statSync(skillsDir).isDirectory()) return entries;

  let items: string[];
  try {
    items = readdirSync(skillsDir);
  } catch {
    return entries; // unreadable dir → empty index, never throw
  }
  // Re-read with stat to filter files ONLY (could use withFileTypes but string[] is
  // simpler and avoids Buffer-vs-string typing noise under exactOptionalPropertyTypes).
  const fileNames = items.filter((name) => {
    if (!name.endsWith('.md')) return false;
    try {
      return statSync(join(skillsDir, name)).isFile();
    } catch {
      return false;
    }
  });

  for (const fname of fileNames) {
    const absPath = join(skillsDir, fname);
    let raw: string;
    try {
      raw = readFileSync(absPath, 'utf8');
    } catch {
      continue; // unreadable file → skip
    }

    const relPath = relative(skillsDir, absPath).replace(/\\/g, '/');
    const parsed = parseSkillMd(raw, relPath);
    if (parsed === null) continue; // parse failure → skip, never default-trusted

    entries.push({
      name: parsed.name,
      description: parsed.description,
      // OMIT `whenToUse` when absent — App state forbids `undefined` values
      // (assertJsonSerializable), and `whenToUse?` is an optional key.
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      file_path: relPath,
    });
  }

  // Sort by name for deterministic index ordering (INV #16).
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

// ============================================================================
// $ARGUMENTS substitution — pure string replacement
// ============================================================================

/**
 * Substitute `$ARGUMENTS` placeholders in the skill body with the provided arguments.
 * Pure + deterministic (INV #1 / #16). Supports one form:
 *   - `$ARGUMENTS` — replaced with the entire raw args string (or '' if missing)
 *
 * This is the ONLY substitution; per-arg named placeholders are v2 (§2).
 */
function substituteArguments(body: string, rawArgs: string): string {
  return body.replace(/\$ARGUMENTS/g, rawArgs);
}

// ============================================================================
// LRU eviction — deterministic (monotonic counter, no wall-clock)
// ============================================================================

/**
 * Apply LRU eviction to the open set: when `open.size > cap`, evict the least-recently-used
 * entry (lowest `loaded_at`). Returns a new Record (no mutation, INV #16).
 * Pure: reads only the monotonic counters.
 */
function evictLru(
  open: Record<string, SkillActiveEntry>,
  cap: number,
): Record<string, SkillActiveEntry> {
  const entries = Object.entries(open);
  if (entries.length <= cap) return open;

  // Sort by loaded_at ascending, evict the oldest.
  entries.sort((a, b) => a[1].loaded_at - b[1].loaded_at);
  const toEvict = entries.slice(0, entries.length - cap).map((e) => e[0]);
  const result: Record<string, SkillActiveEntry> = {};
  for (const [name, entry] of entries) {
    if (!toEvict.includes(name)) result[name] = entry;
  }
  return result;
}

// ============================================================================
// Narrow state helper
// ============================================================================

function skillStateOf(app_ctx: AppContext | undefined): SkillState | null {
  if (app_ctx === undefined) return null;
  const s = app_ctx.state;
  if (typeof s !== 'object' || s === null) return null;
  const cand = s as Partial<SkillState>;
  if (
    !Array.isArray(cand.index) ||
    cand.config == null ||
    cand.open == null ||
    typeof cand.open !== 'object'
  ) {
    return null;
  }
  return s as SkillState;
}

// ============================================================================
// Builders — PURE, all owner 'system' (INV #4 / #16)
// ============================================================================

/**
 * SkillIndexBuilder — owner of `skill:index`. Renders the available skills list in the
 * STABLE segment so it stays at the cache head. Pure: reads state.index only.
 * Returns null when index is empty.
 *
 * Fenced: the index entries' name/description fields are sourced from SKILL.md files
 * (agent-writable in v1 trusted-only, but v2 may relax) — we scan+delimit for safety.
 * Because the index is a stable cache_tier, we fence it to keep injections isolated
 * (skill-memory-wiki §5.1: agent-readable files → fenced output).
 */
const SkillIndexBuilder: BuilderManifest = {
  name: 'SkillIndexBuilder',
  version: '1.0.0',
  owner: 'system',
  app_id: APP_ID,
  inputs: [],
  outputs: [INDEX_BLOCK],
  cache_tier: 'stable',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = skillStateOf(app_ctx);
    if (state === null || state.index.length === 0) return null;

    const lines = ['# Available skills'];
    for (const e of state.index) {
      const name = scanMemoryContent(e.name).ok ? e.name : '[blocked]';
      const desc = scanMemoryContent(e.description).ok ? e.description : '[blocked]';
      const when = e.whenToUse
        ? (scanMemoryContent(e.whenToUse).ok ? e.whenToUse : '[blocked]')
        : undefined;
      if (when) {
        lines.push(`- **${name}**: ${desc} _(use when: ${when})_`);
      } else {
        lines.push(`- **${name}**: ${desc}`);
      }
    }
    lines.push('', 'Use `skill.invoke <name>` to load a skill body.');

    const body = lines.join('\n');
    const fenced = fenceRecalledContentBounded(body, SKILL_RENDER_CEILING_BYTES);
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
 * SkillActiveBuilder — owner of `skill:active`. Renders the bodies of currently-open
 * skills in the VOLATILE segment. Entries ≤ config.active_count_cap (LRU eviction happens
 * at invoke time, not here).
 *
 * Pure: reads state.open only (INV #16). Returns null when no skills are open.
 *
 * Fenced + SELF-BOUND (skill-memory-wiki §9.4 #3): skill body text comes from SKILL.md
 * files — agent-readable, potentially agent-authored (v2). All open skills are concatenated
 * into ONE body and wrapped in a SINGLE provenance fence bounded to
 * `min(config.active_byte_ceiling, SKILL_RENDER_CEILING_BYTES)`, so the WHOLE block is
 * ≤ the manifest render ceiling BY CONSTRUCTION. This matters: the Renderer applies a
 * uniform per-block `clipBytes(text, SKILL_RENDER_CEILING_BYTES)`; were the block over the
 * ceiling (e.g. N fenced sub-blocks joined, the old shape), that blind clip would sever a
 * `</memory-context>` close token mid-content and pierce INV #21. A single self-bounded fence
 * makes the Renderer clip a no-op fast-path that can NEVER cut the fence (mirrors memory's
 * `renderFenced`). When the concatenation exceeds the budget the tail (by sorted name) is
 * clipped inside the fence — bounded + deterministic.
 *
 * Per-skill injection scan stays: a body flagged by `scanMemoryContent` is replaced with a
 * neutral `[blocked]` placeholder BEFORE concatenation (the outer fence also neutralizes any
 * embedded fence tokens, but the scan keeps known injection/exfil bodies out entirely).
 * The $ARGUMENTS substitution happens at invoke time (in the command handler), not here.
 */
const SkillActiveBuilder: BuilderManifest = {
  name: 'SkillActiveBuilder',
  version: '1.0.0',
  owner: 'system',
  app_id: APP_ID,
  inputs: [],
  outputs: [ACTIVE_BLOCK],
  cache_tier: 'volatile',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = skillStateOf(app_ctx);
    if (state === null) return null;

    const entries = Object.entries(state.open);
    if (entries.length === 0) return null;

    // Sort by name for deterministic rendering (INV #16).
    entries.sort((a, b) => a[0].localeCompare(b[0]));

    // Concatenate every open skill into ONE body (per-skill injection scan → [blocked]).
    const sections: string[] = [];
    for (const [name, entry] of entries) {
      const heading = `## Skill: ${name}`;
      const scanned = scanMemoryContent(entry.body);
      sections.push(scanned.ok ? `${heading}\n${entry.body}` : `${heading}\n[blocked: ${scanned.reason}]`);
    }

    // Single fence, self-bounded to the manifest render ceiling (never above it, so the
    // Renderer's uniform per-block clip fast-paths and can't sever the fence). The user-tunable
    // config may LOWER the budget but never RAISE it past the static SKILL_RENDER_CEILING_BYTES.
    const ceiling = Math.min(state.config.active_byte_ceiling, SKILL_RENDER_CEILING_BYTES);
    const fenced = fenceRecalledContentBounded(sections.join('\n\n'), ceiling);
    if (fenced.length === 0) return null;

    return {
      id: ACTIVE_BLOCK,
      name: ACTIVE_BLOCK,
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

// ============================================================================
// Commands
// ============================================================================

/**
 * skill.invoke(name, arguments?) — load a skill body into the active set.
 *   - Reads the SKILL.md file from skillsDir (synchronous, cached by source path from index)
 *   - Substitutes $ARGUMENTS in the body with the provided `arguments` string
 *   - Adds to state.open with a monotonic load counter
 *   - Applies LRU eviction if the active set exceeds config.active_count_cap
 *   - Returns the substituted body text in CommandResult.data.body
 *
 * Capabilities: [block:write] (writes to state.open)
 */
function invokeCommand(skillsDir: string): CommandManifest<SkillState> {
  return {
    name: 'invoke',
    description:
      'Load a skill body into the active context. Substitute $ARGUMENTS with the provided arguments.',
    capabilities: [CAP_BLOCK_WRITE],
    args_schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        arguments: { type: 'string' },
      },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = args as { name?: unknown; arguments?: unknown } | undefined;
      const name = a?.name;
      if (typeof name !== 'string' || name.length === 0) {
        return { ok: false, error: 'skill.invoke requires a non-empty `name`' };
      }

      const state = ctx.state as SkillState;
      const indexEntry = state.index.find((e) => e.name === name);
      if (!indexEntry) {
        return { ok: false, error: `skill '${name}' not found in index` };
      }

      // Read the skill file from disk.
      const absPath = join(skillsDir, indexEntry.file_path);
      let raw: string;
      try {
        raw = readFileSync(absPath, 'utf8');
      } catch {
        return { ok: false, error: `skill file '${indexEntry.file_path}' is unreadable` };
      }

      const parsed = parseSkillMd(raw, indexEntry.file_path);
      if (parsed === null) {
        return { ok: false, error: `skill file '${indexEntry.file_path}' failed to parse` };
      }

      const rawArgs = typeof a?.arguments === 'string' ? a.arguments : '';
      const body = substituteArguments(parsed.body, rawArgs);

      ctx.set_state((s) => {
        const ms = s as SkillState;
        const counter = ms.load_counter + 1;
        const newOpen = {
          ...ms.open,
          [name]: { name, body, loaded_at: counter },
        };
        const capped = evictLru(newOpen, ms.config.active_count_cap);
        return { ...ms, open: capped, load_counter: counter };
      });

      return { ok: true, data: { name, body } };
    },
  };
}

/**
 * skill.close(name) — remove a skill from the active set.
 *
 * Capabilities: [block:write]
 */
function closeCommand(): CommandManifest<SkillState> {
  return {
    name: 'close',
    description: 'Remove a skill body from the active context.',
    capabilities: [CAP_BLOCK_WRITE],
    args_schema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const name = (args as { name?: unknown } | undefined)?.name;
      if (typeof name !== 'string' || name.length === 0) {
        return { ok: false, error: 'skill.close requires a non-empty `name`' };
      }

      const state = ctx.state as SkillState;
      if (!(name in state.open)) {
        return { ok: false, error: `skill '${name}' is not currently open` };
      }

      ctx.set_state((s) => {
        const ms = s as SkillState;
        const newOpen = { ...ms.open };
        delete newOpen[name];
        return { ...ms, open: newOpen };
      });

      return { ok: true, data: { closed: name } };
    },
  };
}

/**
 * skill.list() — readonly, returns the available skill index.
 *
 * Readonly: no tree mutations (CM-1), returns data only.
 */
function listCommand(): CommandManifest<SkillState> {
  return {
    name: 'list',
    description: 'List all available skills (read-only).',
    readonly: true,
    invoke: async (_args, ctx): Promise<CommandResult> => {
      const state = ctx.state as SkillState;
      const summary = state.index.map((e) => ({
        name: e.name,
        description: e.description,
        ...(e.whenToUse !== undefined ? { whenToUse: e.whenToUse } : {}),
        open: e.name in state.open,
      }));
      return { ok: true, data: { skills: summary } };
    },
  };
}

/**
 * skill.index_provider() — app-only readonly, returns the raw index entries.
 *
 * Used internally by the App framework (e.g. consume-refresh contract provision).
 * NEVER `provides` to an external app — that would leak untrusted frontmatter
 * through a contract and bypass the source-stamp guard (§2). The `app-only`
 * restriction is enforced by `allowed_invokers: ['app']`.
 *
 * Readonly: no tree mutations.
 */
function indexProviderCommand(): CommandManifest<SkillState> {
  return {
    name: 'index_provider',
    description: 'Expose the skill index for internal App use (app-only).',
    readonly: true,
    allowed_invokers: ['app'],
    invoke: async (_args, ctx): Promise<CommandResult> => {
      const state = ctx.state as SkillState;
      return { ok: true, data: { index: state.index } };
    },
  };
}

/**
 * skill.set_config({ active_byte_ceiling?, active_count_cap? })
 *
 * USER-ONLY: `allowed_invokers: ['user']` — the agent cannot retune its own
 * metering limits. The ceiling is clamped to a minimum of 1024 bytes; count cap
 * to [1, 10]. The manifest-level `render_ceiling_bytes` is NOT tunable here
 * (it is a static value that the install-time Σ check depends on, §9.4 #7).
 */
function setConfigCommand(): CommandManifest<SkillState> {
  return {
    name: 'set_config',
    description: 'Retune skill metering config (user only).',
    capabilities: [CAP_BLOCK_WRITE],
    allowed_invokers: ['user'],
    args_schema: {
      type: 'object',
      properties: {
        active_byte_ceiling: { type: 'number' },
        active_count_cap: { type: 'number' },
      },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const patch = readSkillConfigPatch(args);
      if (Object.keys(patch).length === 0) {
        return {
          ok: false,
          error: 'skill.set_config: no valid field (active_byte_ceiling / active_count_cap)',
        };
      }
      ctx.set_state((s) => {
        const ms = s as SkillState;
        return { ...ms, config: clampConfig({ ...ms.config, ...patch }) };
      });
      return { ok: true, data: { updated: Object.keys(patch) } };
    },
  };
}

function readSkillConfigPatch(args: unknown): Partial<SkillConfig> {
  if (typeof args !== 'object' || args === null) return {};
  const a = args as Record<string, unknown>;
  const patch: Partial<SkillConfig> = {};
  if (typeof a['active_byte_ceiling'] === 'number') patch.active_byte_ceiling = a['active_byte_ceiling'];
  if (typeof a['active_count_cap'] === 'number') patch.active_count_cap = a['active_count_cap'];
  return patch;
}

// ============================================================================
// SkillApp — the BlockApp
// ============================================================================

/** Options for constructing a SkillApp. */
export interface SkillAppOptions {
  /**
   * The skills directory absolute path — **required**. Root-fenced (P0③) to an
   * OS-level read-only location for v1 trusted-only operation. All SKILL.md files
   * are read from this directory at install time.
   */
  skillsDir: string;
}

/**
 * SkillApp — the concrete skill BlockApp. `manifest()` produces the AppManifest
 * the AppRegistry installs. Constructor injection of `skillsDir` per the BlockApp
 * pattern (mirrors MemoryAppOptions / BaseAppOptions).
 */
export class SkillApp {
  private readonly skillsDir: string;
  /** Index built at construction from skillsDir — installed into initial_state. */
  private readonly seedIndex: SkillIndexEntry[];

  constructor(opts: SkillAppOptions) {
    if (opts.skillsDir === undefined) {
      throw new Error('SkillApp requires an explicit skillsDir; no implicit cwd fallback');
    }
    this.skillsDir = opts.skillsDir;
    // Build the index once at construction time (static — on_install won't reload).
    // Failures (missing dir, unreadable files, parse errors) are silently absorbed
    // into an empty or partial index — never throw at boot. (Mirrors MemoryApp's
    // restoreMemory resilience.)
    this.seedIndex = buildSkillIndex(this.skillsDir);
  }

  manifest(): AppManifest {
    const app = this;
    const skillsDir = this.skillsDir;
    const manifest: AppManifest<SkillState> = {
      id: APP_ID,
      version: '1.0.0',
      depends_on: [],
      // §9.2: per-block render ceiling — two blocks (skill:index + skill:active).
      render_ceiling_bytes: SKILL_RENDER_CEILING_BYTES,
      tree_namespace: TREE_NAMESPACE,
      initial_state: {
        index: this.seedIndex,
        open: {},
        config: { ...DEFAULT_CONFIG },
        load_counter: 0,
      },
      state_schema: STATE_SCHEMA,
      builders: [
        () => SkillIndexBuilder,
        () => SkillActiveBuilder,
      ],
      commands: [
        () => invokeCommand(skillsDir),
        () => closeCommand(),
        () => listCommand(),
        () => indexProviderCommand(),
        () => setConfigCommand(),
      ],
    };
    return manifest as AppManifest;
  }
}
