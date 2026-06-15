/**
 * cli/config.ts — multi-source launcher config loader (impl-cli-logic owned).
 *
 * Design: ai_com/block-agent-cli-design.md §3.
 *
 * loadConfig() resolves a LauncherConfig from, highest-wins: CLI flags > config
 * file (block-agent.config.json) > env > compiled defaults. The config file is
 * authoritative over ambient env vars (a project's pinned config should not be
 * silently overridden by a stray env var); only explicit CLI flags beat it. API key
 * is the ONE exception to this chain — it is read from env ONLY (never a flag, never
 * in the file, never returned in config, never logged). A minimal hand-rolled flag
 * parser — no commander/yargs dependency.
 *
 * Pure: no Ink/React, no console. Returns data; main.tsx decides what to print.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type {
  LauncherConfig,
  ProviderConfig,
  ProviderKind,
  ThinkingFormat,
  WelcomeConfig,
} from './types.js';

/**
 * Compiled defaults (design §3): anthropic; the three original apps + built-in
 * `memory` enabled; `memory_letta` DISABLED by default (it needs an external Letta
 * server, so a default boot must never try to connect to one).
 */
export const DEFAULTS: LauncherConfig = {
  provider: { kind: 'anthropic', model: 'claude-opus-4-7' },
  apps: {
    agent_identity: { enabled: true },
    messages: { enabled: true },
    tools: { enabled: true },
    memory: { enabled: true },
    // actions: the unified action/observation ledger (the agent's "did my command
    // succeed" floor). Trusted, default-ON like the other always-on apps — it takes over
    // the display role of tools:recent + runtime:command_error, so a default boot must
    // ship it. Runtime uninstall is guarded (F1, commands.ts); config-level disable at
    // boot stays allowed (sets enabled:false here).
    actions: { enabled: true },
    memory_letta: { enabled: false },
    // task: local jsonl tracker, zero dependency → on by default like memory.
    task: { enabled: true },
    // stats: pure consumer (message_count + task_count); off by default (§4.4) so a
    // default boot renders no `stats:summary` block unless the operator opts in.
    stats: { enabled: false },
    // Phase C platform-service proxies: each projects a BlockAI-team service (IM/OA/Task)
    // and needs that service running, so ALL off by default (like memory_letta).
    im_proxy: { enabled: false },
    oa_proxy: { enabled: false },
    task_proxy: { enabled: false },
  },
  welcome: { cube: true },
};

/** The config file consulted when `--config` is absent (design §3 / §11.4). */
export const DEFAULT_CONFIG_FILE = 'block-agent.config.json';

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
// .env file source — populate process.env from a repo-root .env (side-effecting)
// ============================================================================

/**
 * loadDotenv — load a `.env` file (KEY=VALUE lines) into `process.env`, OVERRIDING any
 * pre-existing variable of the same name (file > env, matching the config precedence and the
 * operator's intent: a project's pinned `.env` must not be silently shadowed by a stray shell
 * var).
 *
 * This is the ONE side-effecting export in this module (it mutates process.env); `loadConfig`
 * itself stays pure. Every entry point calls it ONCE at startup BEFORE `loadConfig`/`launch` —
 * the Ink CLI (`main.tsx`) AND the headless `block-agent-serve` bin (which fronts the web
 * inspector) — so a repo-root `.env` takes effect EVERYWHERE, not just for `npm start`. Without
 * this, `block-agent-serve` only saw the ambient shell env and a `.env`-only key looked like a
 * "missing key" (the web appeared to force a hard-set provider key).
 *
 * The API key still flows the SAME way: `launch.ts` reads `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
 * from `process.env`, which `.env` has now populated — the key is never a flag, never a config
 * field (the KEY iron law holds). Defensive: a missing or malformed file is a no-op — startup
 * never throws. `#` comment lines and surrounding single/double quotes are handled.
 */
export function loadDotenv(path = '.env'): void {
  if (!existsSync(path)) return;
  try {
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.replace(/\r$/, '').trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key.length > 0) process.env[key] = val; // override (file > env)
    }
  } catch {
    // A bad .env must never crash startup — fall back to the ambient environment.
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
 * loadConfig — merge flags ⊕ file ⊕ env ⊕ DEFAULTS into a resolved LauncherConfig
 * (highest-wins: flags > file > env > defaults, design §3). The config file is
 * authoritative over ambient env vars; only explicit CLI flags beat it.
 *
 * The API key is the ONE exception to that chain — it is NOT part of LauncherConfig:
 * `launch.ts` reads it straight from env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
 * This loader never touches a key, so it can never echo or persist one.
 *
 * Each field is resolved with `pick(flagVal, fileVal, envVal, defaultVal)`; a source
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
      asProviderKind(fileProvider['kind']),
      asProviderKind(env['BLOCK_AGENT_PROVIDER']),
      DEFAULTS.provider.kind,
    ) ?? DEFAULTS.provider.kind;

  const model: string =
    pick(
      asString(flags['model']),
      asString(fileProvider['model']),
      asString(env['BLOCK_AGENT_MODEL']),
      DEFAULTS.provider.model,
    ) ?? DEFAULTS.provider.model;

  // base_url: flag > file > the provider-specific env. anthropic and openai-compat
  // read different env vars; after the file we offer whichever matches the resolved
  // kind first, then fall back to the other so a misconfigured pair still surfaces.
  const base_url = pick(
    asString(flags['base-url']),
    asString(fileProvider['base_url']),
    kind === 'openai-compat'
      ? asString(env['OPENAI_BASE_URL'])
      : asString(env['ANTHROPIC_BASE_URL']),
    asString(env['ANTHROPIC_BASE_URL']),
    asString(env['OPENAI_BASE_URL']),
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

  // Storage dir: flag > file > env > (undefined → launch defaults to cwd).
  const storage_dir = pick(
    asString(flags['storage-dir']),
    asString(file['storage_dir']),
    asString(env['BLOCK_AGENT_STORAGE_DIR']),
  );

  const max_turns_per_wake = pick(
    asNumber(flags['max-turns-per-wake']),
    asNumber(file['max_turns_per_wake']),
    asNumber(env['BLOCK_AGENT_MAX_TURNS_PER_WAKE']),
  );

  // allow_purge: gate for the destructive `/app purge` command (flag `--allow-purge`
  // or file `allow_purge:true`). DISABLED unless explicitly set, so a stray boot can
  // never enable irrecoverable deletion. Not an env var (too easy to leave globally on).
  const allow_purge = pick(asBool(flags['allow-purge']), asBool(file['allow_purge'])) ?? false;

  // contract_bindings: optional operator overrides (C-API-7). A top-level
  // `Record<string,string>` in the file; absent / malformed → undefined (nothing in
  // the default path reads it). Only string→string entries survive the narrowing.
  const contract_bindings = resolveContractBindings(file['contract_bindings']);

  return {
    provider,
    apps: {
      agent_identity: resolveIdentity(flags, fileApps),
      messages: resolveMessages(flags, fileApps),
      tools: resolveTools(flags, fileApps),
      memory: resolveMemory(flags, fileApps),
      actions: resolveActions(flags, fileApps),
      memory_letta: resolveMemoryLetta(flags, fileApps, env),
      task: resolveTask(flags, fileApps),
      stats: resolveStats(flags, fileApps),
      im_proxy: resolveServiceProxy('im_proxy', flags, fileApps),
      oa_proxy: resolveServiceProxy('oa_proxy', flags, fileApps),
      task_proxy: resolveServiceProxy('task_proxy', flags, fileApps),
    },
    ...(storage_dir !== undefined ? { storage_dir } : {}),
    ...(max_turns_per_wake !== undefined ? { max_turns_per_wake } : {}),
    ...(allow_purge ? { allow_purge } : {}),
    ...(contract_bindings !== undefined ? { contract_bindings } : {}),
    // The file `loadConfig` actually consulted — so `/app *` write-backs target it
    // (not a re-guessed default). Always defined here (default file name when no flag).
    config_path: configPath,
    welcome: resolveWelcome(flags, file),
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

/**
 * resolveMemory — the built-in `memory` app config. Enabled by default (zero
 * dependency, offline). `--no-memory` disables it. notes/user char limits and the
 * recall limit are non-file overrides (flag > file); the app's own config.json seed +
 * compiled Hermes defaults remain the fallback. The agent can never retune these at
 * runtime (`memory.set_config` is user-only), so the operator pins them here.
 */
function resolveMemory(
  flags: ParsedFlags,
  fileApps: Record<string, unknown>,
): LauncherConfig['apps']['memory'] {
  const f = pickObject(fileApps['memory']);
  const notes_char_limit = pick(asNumber(flags['notes-char-limit']), asNumber(f['notes_char_limit']));
  const user_char_limit = pick(asNumber(flags['user-char-limit']), asNumber(f['user_char_limit']));
  const recall_limit = pick(asNumber(flags['memory-recall-limit']), asNumber(f['recall_limit']));
  return {
    enabled: appEnabled(flags, f, 'no-memory'),
    ...(notes_char_limit !== undefined ? { notes_char_limit } : {}),
    ...(user_char_limit !== undefined ? { user_char_limit } : {}),
    ...(recall_limit !== undefined ? { recall_limit } : {}),
  };
}

/**
 * resolveTask — the built-in `task` app config (§4.2). Enabled by default
 * (local jsonl store, zero dependency, offline). `--no-task` disables it.
 * `list_limit` (the open-task projection cap) is a non-file override (flag > file);
 * the app's own config seed + compiled defaults remain the fallback. The agent can
 * never retune it at runtime (`task.set_config` is user-only), so the operator pins it.
 */
function resolveTask(
  flags: ParsedFlags,
  fileApps: Record<string, unknown>,
): LauncherConfig['apps']['task'] {
  const f = pickObject(fileApps['task']);
  const list_limit = pick(asNumber(flags['task-list-limit']), asNumber(f['list_limit']));
  return {
    enabled: appEnabled(flags, f, 'no-task'),
    ...(list_limit !== undefined ? { list_limit } : {}),
  };
}

/**
 * resolveActions — the `actions` ledger app config. DEFAULT-ENABLED (like task/memory):
 * on unless `--no-actions` or file `apps.actions.enabled:false`. Only the boot toggle
 * lives here; the app's own knobs (window_size / command_detail / input_detail / char
 * limits) are seeded inside the app, not the launcher config. Runtime uninstall is
 * separately guarded (F1, commands.ts) — config-level disable at boot is allowed.
 */
function resolveActions(
  flags: ParsedFlags,
  fileApps: Record<string, unknown>,
): LauncherConfig['apps']['actions'] {
  const f = pickObject(fileApps['actions']);
  return {
    enabled: appEnabled(flags, f, 'no-actions'),
  };
}

/**
 * resolveStats — the `stats` app config (§4.4). DISABLED by default: it is a pure
 * consumer whose `stats:summary` block only renders when enabled AND `show_block` is
 * true. Enable via `--stats` / file `apps.stats.enabled:true`; `--no-stats` forces off
 * (an explicit no always wins). `show_block` resolves flag (`--stats-show-block`) >
 * file; the app's own seed is the fallback.
 */
function resolveStats(
  flags: ParsedFlags,
  fileApps: Record<string, unknown>,
): LauncherConfig['apps']['stats'] {
  const f = pickObject(fileApps['stats']);
  // Default-disabled: enabled ONLY when a positive flag or file value says so;
  // `--no-stats` also forces off (so an explicit no always wins).
  const fileEnabled = asBool(f['enabled']) ?? false;
  const flagOn = flags['stats'] === true || flags['stats'] === 'true';
  const flagOff = flags['no-stats'] === true || flags['no-stats'] === 'true';
  const enabled = flagOff ? false : flagOn || fileEnabled;
  const show_block = pick(asBool(flags['stats-show-block']), asBool(f['show_block']));
  return {
    enabled,
    ...(show_block !== undefined ? { show_block } : {}),
  };
}

/**
 * resolveContractBindings — narrow the file's optional top-level `contract_bindings`
 * (C-API-7) into a `Record<string,string>` (string keys → string provider ids). A
 * non-object, or one with any non-string value, yields `undefined` (the field drops
 * out of the resolved config). No flag form in v1 — file-only.
 */
function resolveContractBindings(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && val.length > 0) out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * resolveWelcome — the welcome screen config. `--no-cube` (boolean flag, spec §3.1)
 * sets `cube = false`. Config file `{ "welcome": { "cube": false } }` is the file
 * equivalent. Precedence: flags > file > defaults (`cube: true`).
 */
function resolveWelcome(
  flags: ParsedFlags,
  file: Record<string, unknown>,
): WelcomeConfig {
  const fileWelcome = pickObject(file['welcome']);
  // `--no-cube` is the spec-locked flag name. A bare `--no-cube` → `true` in ParsedFlags.
  const noCubeFlag = flags['no-cube'] === true || flags['no-cube'] === 'true';
  const fileCube = asBool(fileWelcome['cube']);
  const cube = noCubeFlag ? false : (fileCube ?? DEFAULTS.welcome!.cube);
  return { cube };
}

// ============================================================================
// writeAppConfig — minimal JSON patch write-back (design §3.2)
// ============================================================================

/**
 * writeAppConfig — patch `apps.<id>.enabled` in a block-agent.config.json, preserving
 * every other field (read-modify-write). Spec: ai_com/block-agent-app-lifecycle-impl-
 * split.md §3.2.
 *
 * - Missing file → create with just the patched apps section (no other keys).
 * - Unreadable / malformed existing file → throw (do NOT silently clobber the
 *   operator's file; surface the error so the operator can fix it).
 * - API keys are NEVER written here (key only lives in env — the KEY iron law).
 * - JSON comments are lost on write (acceptable: the format is JSON, not JSONC).
 */
export function writeAppConfig(
  path: string,
  patch: { apps: Record<string, { enabled: boolean }> },
): void {
  let base: Record<string, unknown> = {};

  if (existsSync(path)) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(
        `writeAppConfig: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `writeAppConfig: ${path} contains malformed JSON — fix it before writing: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`writeAppConfig: ${path} root is not a JSON object`);
    }
    base = parsed as Record<string, unknown>;
  }

  // Deep-merge only apps.<id>.enabled; all other keys are preserved untouched.
  const existingApps: Record<string, unknown> =
    typeof base['apps'] === 'object' && base['apps'] !== null && !Array.isArray(base['apps'])
      ? { ...(base['apps'] as Record<string, unknown>) }
      : {};

  for (const [id, update] of Object.entries(patch.apps)) {
    const existingApp: Record<string, unknown> =
      typeof existingApps[id] === 'object' &&
      existingApps[id] !== null &&
      !Array.isArray(existingApps[id])
        ? { ...(existingApps[id] as Record<string, unknown>) }
        : {};
    existingApps[id] = { ...existingApp, enabled: update.enabled };
  }

  const result: Record<string, unknown> = { ...base, apps: existingApps };
  writeFileSync(path, JSON.stringify(result, null, 2), 'utf8');
}

/**
 * resolveMemoryLetta — the `memory_letta` app config. DISABLED by default (needs an
 * external Letta server). Enable it explicitly via `--memory-letta` / file
 * `apps.memory_letta.enabled: true`. base_url resolves flag > file > env
 * (`LETTA_BASE_URL`); the app default `http://localhost:8283` applies when none is set.
 * The API key is NEVER read here — `LETTA_API_KEY` is consumed only inside the Letta
 * store at request time (the ANTHROPIC_API_KEY rule).
 */
function resolveMemoryLetta(
  flags: ParsedFlags,
  fileApps: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): LauncherConfig['apps']['memory_letta'] {
  const f = pickObject(fileApps['memory_letta']);
  // Default-disabled: enabled ONLY when a positive flag or file value says so;
  // `--no-memory-letta` also forces off (so an explicit no always wins).
  const fileEnabled = asBool(f['enabled']) ?? false;
  const flagOn = flags['memory-letta'] === true || flags['memory-letta'] === 'true';
  const flagOff = flags['no-memory-letta'] === true || flags['no-memory-letta'] === 'true';
  const enabled = flagOff ? false : flagOn || fileEnabled;

  const base_url = pick(
    asString(flags['letta-base-url']),
    asString(f['base_url']),
    asString(env['LETTA_BASE_URL']),
  );
  const recall_limit = pick(asNumber(flags['letta-recall-limit']), asNumber(f['recall_limit']));
  return {
    enabled,
    ...(base_url !== undefined ? { base_url } : {}),
    ...(recall_limit !== undefined ? { recall_limit } : {}),
  };
}

/**
 * resolveServiceProxy — the shared resolver for the Phase C platform-service proxies
 * (`im_proxy` / `oa_proxy` / `task_proxy`). ALL DISABLED by default (each needs a running
 * BlockAI-team service): `enabled` is on ONLY when a positive flag (`--im-proxy`) or the
 * file says so; `--no-<id>` forces off. This resolver carries ONLY the enable gate — the
 * endpoint + token are read from ENV inside each proxy's client (`*_SERVICE_URL` /
 * `*_SERVICE_TOKEN`, the token env-only per the ANTHROPIC_API_KEY rule), never config/flag.
 */
function resolveServiceProxy(
  id: 'im_proxy' | 'oa_proxy' | 'task_proxy',
  flags: ParsedFlags,
  fileApps: Record<string, unknown>,
): LauncherConfig['apps']['im_proxy'] {
  const f = pickObject(fileApps[id]);
  const flagId = id.replace('_', '-'); // im_proxy → im-proxy
  const fileEnabled = asBool(f['enabled']) ?? false;
  const flagOn = flags[flagId] === true || flags[flagId] === 'true';
  const flagOff = flags[`no-${flagId}`] === true || flags[`no-${flagId}`] === 'true';
  return { enabled: flagOff ? false : flagOn || fileEnabled };
}
