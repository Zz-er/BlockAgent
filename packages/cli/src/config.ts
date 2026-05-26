/**
 * cli/config.ts — multi-source launcher config loader (impl-cli-logic owned).
 *
 * Design: ai_com/block-agent-cli-design.md §3.
 *
 * loadConfig() resolves a LauncherConfig from, highest-wins: CLI flags > env >
 * config file (block-agent.config.json) > compiled defaults. API key is read from
 * env ONLY (never a flag, never returned in config, never logged). A minimal
 * hand-rolled flag parser — no commander/yargs dependency.
 *
 * Pure: no Ink/React, no console. Returns data; main.tsx decides what to print.
 */

import { existsSync, readFileSync } from 'node:fs';

import type {
  LauncherConfig,
  ProviderConfig,
  ProviderKind,
  ThinkingFormat,
} from './types.js';

/** Compiled defaults (design §3): anthropic, all three apps enabled. */
export const DEFAULTS: LauncherConfig = {
  provider: { kind: 'anthropic', model: 'claude-opus-4-7' },
  apps: {
    agent_identity: { enabled: true },
    messages: { enabled: true },
    tools: { enabled: true },
  },
};

/** The config file consulted when `--config` is absent (design §3 / §11.4). */
const DEFAULT_CONFIG_FILE = 'block-agent.config.json';

/** The provider kinds we accept on flags / env / file. */
const PROVIDER_KINDS: ReadonlySet<string> = new Set<ProviderKind>([
  'anthropic',
  'openai-compat',
  'mock',
]);

/** The thinking_format values we accept (mirrors ThinkingFormat). */
const THINKING_FORMATS: ReadonlySet<string> = new Set<ThinkingFormat>([
  'anthropic_blocks',
  'openai_reasoning',
  'xml_think_tag',
  'xml_thinking_tag',
  'none',
]);

// ============================================================================
// Flag parsing — minimal hand-rolled (`--k v` / `--k=v` / `--flag`)
// ============================================================================

/**
 * ParsedFlags — the raw flag bag. A bare `--flag` becomes `true`; `--k v` and
 * `--k=v` both bind a string value. Unknown flags are kept (harmless): the merge
 * only reads the keys it knows. Deliberately tiny — no commander/yargs (design §3).
 */
export type ParsedFlags = Record<string, string | true>;

/**
 * parseFlags — turn an argv slice into a flag bag. Only `--` long flags are
 * recognized; a `--k=v` binds inline, a `--k <value>` consumes the next token
 * UNLESS that token is itself a flag (then `--k` is a boolean). Non-flag tokens
 * with no preceding flag are ignored (the CLI takes no positional args in v3.0).
 */
export function parseFlags(argv: readonly string[]): ParsedFlags {
  const flags: ParsedFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]!;
    if (!tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return flags;
}

// ============================================================================
// Config-file source (defensive — bad JSON never throws; defaults win)
// ============================================================================

/**
 * readConfigFile — read + parse a JSON config file, returning a partial config
 * (only the top-level keys we merge). DEFENSIVE: a missing file, unreadable file,
 * or malformed JSON yields `{}` (defaults win), matching the "startup never throws"
 * posture of the apps' `readAppConfig`. Returns the parsed object verbatim — the
 * merge below picks fields out of it with type guards, so a structurally-wrong file
 * cannot corrupt the resolved config.
 */
function readConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Malformed JSON / IO error → ignore the file (defaults + env + flags still apply).
    return {};
  }
}

// ============================================================================
// Narrowing helpers (each source hands us `unknown`; pick values defensively)
// ============================================================================

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asProviderKind(v: unknown): ProviderKind | undefined {
  return typeof v === 'string' && PROVIDER_KINDS.has(v) ? (v as ProviderKind) : undefined;
}

function asThinkingFormat(v: unknown): ThinkingFormat | undefined {
  return typeof v === 'string' && THINKING_FORMATS.has(v) ? (v as ThinkingFormat) : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return [...(v as string[])];
  // Comma-separated string form (for the `--enabled-tools a,b,c` flag).
  if (typeof v === 'string' && v.length > 0)
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  return undefined;
}

/** First defined value across the precedence-ordered candidates (flags → … → default). */
function pick<T>(...candidates: Array<T | undefined>): T | undefined {
  for (const c of candidates) if (c !== undefined) return c;
  return undefined;
}

// ============================================================================
// loadConfig — the merge
// ============================================================================

/**
 * loadConfig — merge flags ⊕ env ⊕ file ⊕ DEFAULTS into a resolved LauncherConfig
 * (highest-wins: flags > env > file > defaults, design §3).
 *
 * The API key is NOT part of LauncherConfig — `launch.ts` reads it straight from
 * env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). This loader never touches a key, so
 * it can never echo or persist one.
 *
 * Each field is resolved with `pick(flagVal, envVal, fileVal, defaultVal)`; a source
 * that omits or mis-types a field simply drops out of the chain (defensive narrowing),
 * so a malformed config file or stray env var degrades to the next source rather than
 * crashing.
 */
export function loadConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): LauncherConfig {
  const flags = parseFlags(argv);

  // Config file: `--config <path>` overrides the default file name; either way a
  // bad/missing file degrades to `{}` so defaults win (never throws at startup).
  const configPath = asString(flags['config']) ?? DEFAULT_CONFIG_FILE;
  const file = readConfigFile(configPath);
  const fileProvider = pickObject(file['provider']);
  const fileApps = pickObject(file['apps']);

  // --dry-run forces the mock provider (offline smoke), trumping every other source
  // for the provider KIND — it is an explicit operator intent (design §7).
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true';

  const kind: ProviderKind =
    pick(
      dryRun ? ('mock' as const) : undefined,
      asProviderKind(flags['provider']),
      asProviderKind(env['BLOCK_AGENT_PROVIDER']),
      asProviderKind(fileProvider['kind']),
      DEFAULTS.provider.kind,
    ) ?? DEFAULTS.provider.kind;

  const model: string =
    pick(
      asString(flags['model']),
      asString(env['BLOCK_AGENT_MODEL']),
      asString(fileProvider['model']),
      DEFAULTS.provider.model,
    ) ?? DEFAULTS.provider.model;

  // base_url: flag > the provider-specific env > file. anthropic and openai-compat
  // read different env vars; we offer whichever matches the resolved kind first, then
  // fall back to the other so a misconfigured pair still surfaces something.
  const base_url = pick(
    asString(flags['base-url']),
    kind === 'openai-compat'
      ? asString(env['OPENAI_BASE_URL'])
      : asString(env['ANTHROPIC_BASE_URL']),
    asString(env['ANTHROPIC_BASE_URL']),
    asString(env['OPENAI_BASE_URL']),
    asString(fileProvider['base_url']),
  );

  const thinking_format = pick(
    asThinkingFormat(flags['thinking-format']),
    asThinkingFormat(fileProvider['thinking_format']),
  );

  const provider: ProviderConfig = {
    kind,
    model,
    ...(base_url !== undefined ? { base_url } : {}),
    ...(thinking_format !== undefined ? { thinking_format } : {}),
  };

  // Storage dir: flag > env > file > (undefined → launch defaults to cwd).
  const storage_dir = pick(
    asString(flags['storage-dir']),
    asString(env['BLOCK_AGENT_STORAGE_DIR']),
    asString(file['storage_dir']),
  );

  const max_turns_per_wake = pick(
    asNumber(flags['max-turns-per-wake']),
    asNumber(env['BLOCK_AGENT_MAX_TURNS_PER_WAKE']),
    asNumber(file['max_turns_per_wake']),
  );

  return {
    provider,
    apps: {
      agent_identity: resolveIdentity(flags, fileApps),
      messages: resolveMessages(flags, fileApps),
      tools: resolveTools(flags, fileApps),
    },
    ...(storage_dir !== undefined ? { storage_dir } : {}),
    ...(max_turns_per_wake !== undefined ? { max_turns_per_wake } : {}),
  };
}

/** A nested object from the config file, or `{}` if absent/non-object. */
function pickObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * `--no-<app>` disables an app (design §3). An app is enabled unless the flag is
 * present, OR the config file explicitly set `enabled:false` and no `--no-<app>` /
 * positive override appeared. Flags win, so `--no-tools` always disables.
 */
function appEnabled(
  flags: ParsedFlags,
  fileApp: Record<string, unknown>,
  noFlag: string,
): boolean {
  if (flags[noFlag] === true || flags[noFlag] === 'true') return false;
  const fileEnabled = asBool(fileApp['enabled']);
  return fileEnabled ?? true;
}

function resolveIdentity(
  flags: ParsedFlags,
  fileApps: Record<string, unknown>,
): LauncherConfig['apps']['agent_identity'] {
  const f = pickObject(fileApps['agent_identity']);
  const role = pick(asString(flags['role']), asString(f['role']));
  const persona = pick(asString(flags['persona']), asString(f['persona']));
  const instructions = pick(asString(flags['instructions']), asString(f['instructions']));
  return {
    enabled: appEnabled(flags, f, 'no-agent-identity'),
    ...(role !== undefined ? { role } : {}),
    ...(persona !== undefined ? { persona } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
  };
}

function resolveMessages(
  flags: ParsedFlags,
  fileApps: Record<string, unknown>,
): LauncherConfig['apps']['messages'] {
  const f = pickObject(fileApps['messages']);
  const max_history_tokens = pick(
    asNumber(flags['max-history-tokens']),
    asNumber(f['max_history_tokens']),
  );
  const compression_threshold = pick(
    asNumber(flags['compression-threshold']),
    asNumber(f['compression_threshold']),
  );
  const display_count = pick(asNumber(flags['display-count']), asNumber(f['display_count']));
  return {
    enabled: appEnabled(flags, f, 'no-messages'),
    ...(max_history_tokens !== undefined ? { max_history_tokens } : {}),
    ...(compression_threshold !== undefined ? { compression_threshold } : {}),
    ...(display_count !== undefined ? { display_count } : {}),
  };
}

function resolveTools(
  flags: ParsedFlags,
  fileApps: Record<string, unknown>,
): LauncherConfig['apps']['tools'] {
  const f = pickObject(fileApps['tools']);
  const tool_history_count = pick(
    asNumber(flags['tool-history-count']),
    asNumber(f['tool_history_count']),
  );
  const enabled_tools = pick(asStringArray(flags['enabled-tools']), asStringArray(f['enabled_tools']));
  return {
    enabled: appEnabled(flags, f, 'no-tools'),
    ...(tool_history_count !== undefined ? { tool_history_count } : {}),
    ...(enabled_tools !== undefined ? { enabled_tools } : {}),
  };
}
