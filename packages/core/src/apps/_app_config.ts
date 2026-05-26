/**
 * apps/_app_config.ts — shared BlockApp config-file mechanism (architect-owned).
 *
 * A reusable helper both `messages` and `tools` (and future apps) use to seed their
 * tunable config from a per-App JSON file, plus the convention for the commands that
 * change that config at runtime.
 *
 * Two halves of ONE mechanism (lead directive 2026-05-26):
 *
 * 1. **File seed (this module's `readAppConfig`)** — at construction/install an App
 *    reads `.block-agent/apps/<id>/config.json`; any keys present there OVERRIDE the
 *    App's compiled defaults. The merged config is stored INTO App state (so it is
 *    schema-validated, INV #14, and projected deterministically by builders). The
 *    file is the operator's static seed; missing file / bad JSON → just use defaults
 *    (never throw at boot).
 *
 * 2. **Runtime config commands (a convention, NOT code here)** — an App MAY expose a
 *    command that changes its config at runtime (e.g. `messages.set_config`,
 *    `tools.set_config`). Such a command MUST declare **`allowed_invokers: ['user']`**
 *    (the reusable PolicyEngine "who, not what" gate — same as `agent_identity.set`)
 *    so the AGENT can never retune its own token budget / thresholds / display counts
 *    (anti-self-modification). The handler validates + clamps the incoming values and
 *    commits via `ctx.set_state`. See ARCHITECTURE.md "BlockApp config mechanism".
 *
 * This is a plain helper (no contract change): config is per-App local state seeded
 * from a file, which an App can do itself; we centralize the read+merge so the three
 * apps don't each reinvent it. It is NOT on the App hot path (read once at install),
 * so a synchronous file read is fine and keeps `initial_state` ready before install.
 *
 * House style: leading underscore marks an apps-internal shared util (not a BlockApp).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Root under which each App keeps its files: `.block-agent/apps/<id>/`. (§12.1) */
export const APPS_DIR = join('.block-agent', 'apps');

/** The per-App config file name (lives under that App's dir). */
export const CONFIG_FILE = 'config.json';

/**
 * Resolve an App's config-file path: `.block-agent/apps/<app_id>/config.json`.
 * Exposed so an App (or a test) can point at a custom base dir.
 */
export function appConfigPath(app_id: string, base: string = APPS_DIR): string {
  return join(base, app_id, CONFIG_FILE);
}

/**
 * Read an App's config file and merge it OVER the supplied defaults (shallow, by
 * top-level key). Returns a NEW object; `defaults` is never mutated.
 *
 * Robustness (never throws at boot):
 *   - file absent            → return a copy of `defaults`.
 *   - unreadable / bad JSON  → return a copy of `defaults` (the bad file is ignored;
 *                              a real boot would log it, out of scope here).
 *   - JSON not a plain object→ ignored (defaults win).
 *
 * Only keys that ALREADY exist in `defaults` are taken from the file, and only when
 * the file value's runtime type matches the default's — so a config file can tune a
 * declared knob but cannot inject arbitrary/typed-wrong keys into App state (which
 * would later trip the state_schema validation anyway). Unknown keys are dropped.
 * The caller is responsible for clamping ranges (e.g. a 0..1 threshold).
 */
export function readAppConfig<T extends Record<string, unknown>>(
  app_id: string,
  defaults: T,
  base: string = APPS_DIR,
): T {
  const merged: T = { ...defaults };
  const path = appConfigPath(app_id, base);
  if (!existsSync(path)) return merged;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return merged; // unreadable / malformed → defaults win, never throw at boot.
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return merged;
  }

  const fileObj = parsed as Record<string, unknown>;
  for (const key of Object.keys(defaults)) {
    if (!(key in fileObj)) continue;
    const fileVal = fileObj[key];
    const defVal = defaults[key];
    // Only accept a file value whose runtime type matches the default's (objects
    // and arrays compared structurally enough for the flat config knobs we use:
    // number/string/boolean/array). This keeps a config file from smuggling a
    // wrong-typed value into state ahead of schema validation.
    if (sameKind(fileVal, defVal)) {
      (merged as Record<string, unknown>)[key] = fileVal;
    }
  }
  return merged;
}

/** Runtime-kind match for config values (number/string/boolean/array/object). */
function sameKind(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b);
  if (Array.isArray(b)) return false;
  return typeof a === typeof b;
}
