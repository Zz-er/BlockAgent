/**
 * cli/commands.ts — the slash-command registry + dispatcher (impl-cli-logic owned).
 *
 * Design: ai_com/block-agent-cli-design.md §5.
 *
 * A central registry keyed by name (NOT a switch). Commands (all local in v3.0):
 *   /cmd <full_name> [json]  — operations.invoke_command(fn, args, {invoker:'user'})
 *   /context                 — abbreviated RenderedPrompt (tier·bytes·boundary·preview)
 *   /context --full <file> | /dump <file> — full RenderedPrompt written to file
 *   /apps                    — registry.list() + per-app blocks/commands (+ user_only flag)
 *   /status                  — runtime state / provider id / app count / turn count
 *   /help                    — list commands
 *   /quit (/exit)            — exit the process (code 0)
 *
 * Each command's result is pushed to the UI via the `setView` sink (CtxView). The
 * view BUILDING lives here; the RENDERING lives in ui/ContextView.tsx (design §5 "实现
 * 落点"). Read-only commands never mutate the tree; /cmd is the only mutating path and
 * always invoker=user (chokepoint intact — the CLI never forges invoker:'agent'/'app').
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import type { DispatchFn, LaunchedAgent, SetView, SlashCommand } from './types.js';
import { summarize, dumpFull, appsView, installedApps } from './context_view.js';
import { BUILTIN_APP_CATALOG } from './app_catalog.js';
import { writeAppConfig, DEFAULT_CONFIG_FILE } from './config.js';

/**
 * Per-session turn counter for /status. The runtime exposes its current state but not a
 * cumulative turn count, so the dispatcher tallies each user-driven wake here. Kept
 * module-local + incremented only on the chokepoint paths the CLI owns (see noteTurn).
 */
let turnCount = 0;

/** Called by the App on each plain-text submission so /status can report turns run. */
export function noteTurn(): void {
  turnCount += 1;
}

/**
 * /cmd <full_name> [json] — run any registered runtime command as invoker=user. The
 * args after the full name are parsed as ONE JSON value (empty → {}). We resolve the
 * command first so an unknown name gives a helpful local message rather than a deny, and
 * a malformed JSON arg fails locally WITHOUT issuing a call (design §5).
 */
const cmdCommand: SlashCommand = {
  name: 'cmd',
  summary: 'Run a runtime command as the user, e.g. /cmd agent_identity.set {"role":"x"}',
  usage: '<full_name> [json-args]',
  async run(agent, argv, setView) {
    const full_name = argv[0];
    if (full_name === undefined || full_name.length === 0) {
      setView({ kind: 'command_result', ok: false, text: 'usage: /cmd <app.command> [json-args]' });
      return;
    }
    // Validate the command exists before invoking (helpful message, not a deny).
    if (agent.registry.resolve_command(full_name) === null) {
      setView({
        kind: 'command_result',
        ok: false,
        text: `unknown command '${full_name}'. Try /apps to list available commands.`,
      });
      return;
    }
    // Parse the remaining tokens as one JSON value; empty → {}.
    const jsonText = argv.slice(1).join(' ').trim();
    let args: unknown = {};
    if (jsonText.length > 0) {
      try {
        args = JSON.parse(jsonText);
      } catch (err) {
        setView({ kind: 'command_result', ok: false, text: `bad JSON args: ${errorText(err)}` });
        return;
      }
    }
    // Chokepoint: invoker=user. Operations runs PolicyEngine then routes the command.
    const result = await agent.operations.invoke_command(full_name, args, { invoker: 'user' });
    setView({
      kind: 'command_result',
      ok: result.ok,
      text: result.ok
        ? `ok${result.data !== undefined ? `: ${safeJson(result.data)}` : ''}`
        : `error: ${result.error ?? 'command failed'}`,
    });
  },
};

/** /context — abbreviated current context, or `--full <file>` to dump the full prompt. */
const contextCommand: SlashCommand = {
  name: 'context',
  summary: 'Show the abbreviated rendered context (or --full <file> to dump it).',
  usage: '[--full <file>]',
  async run(agent, argv, setView) {
    if (argv[0] === '--full') {
      const file = argv[1];
      if (file === undefined || file.length === 0) {
        setView({ kind: 'command_result', ok: false, text: 'usage: /context --full <file>' });
        return;
      }
      await dumpToFile(agent, file, setView);
      return;
    }
    setView(await summarize(agent));
  },
};

/** /dump <file> — write the full RenderedPrompt to a file (alias of /context --full). */
const dumpCommand: SlashCommand = {
  name: 'dump',
  summary: 'Write the full rendered context to a file.',
  usage: '<file>',
  async run(agent, argv, setView) {
    const file = argv[0];
    if (file === undefined || file.length === 0) {
      setView({ kind: 'command_result', ok: false, text: 'usage: /dump <file>' });
      return;
    }
    await dumpToFile(agent, file, setView);
  },
};

/** /apps — list installed apps (blocks/commands) + available catalog entries. */
const appsCommand: SlashCommand = {
  name: 'apps',
  summary: 'List installed apps, their blocks and commands, plus installable catalog entries.',
  run(agent, _argv, setView) {
    const { installed, available } = appsView(agent);
    setView({ kind: 'apps', installed, available });
  },
};

/**
 * /app <sub-command> — BlockApp lifecycle operations (invoker=user only, never agent).
 *
 * Sub-commands: info / install / uninstall / swap / purge.
 * NOT in tool_catalog — slash commands are never exposed to the agent.
 * All writes go through writeAppConfig; hot-uninstall goes through agent.hotUninstall.
 *
 * Design: ai_com/block-agent-app-lifecycle-impl-split.md §3.3.
 */
const appCommand: SlashCommand = {
  name: 'app',
  summary: 'Manage BlockApps: info / install / uninstall / swap / purge.',
  usage: '<info|install|uninstall|swap|purge> [args]',
  async run(agent, argv, setView) {
    const sub = argv[0];

    if (sub === undefined || sub.length === 0) {
      setView({
        kind: 'command_result',
        ok: false,
        text: [
          'usage: /app <sub-command> [args]',
          '  /app info <id>             — show info for an app (installed or catalog)',
          '  /app install <id>          — write config enabled:true (restart to apply)',
          '  /app uninstall <id>        — hot-uninstall + write config enabled:false',
          '  /app swap <current> <next> — plan: uninstall current, install next (restart)',
          '  /app purge <id>            — delete local app data (requires allow_purge + confirm)',
        ].join('\n'),
      });
      return;
    }

    // Resolve the config file `/app install|uninstall|swap` write back to. launch.ts
    // threads the resolved path onto LaunchedAgent.config_path (the file loadConfig
    // actually consulted); fall back to the default name when absent (e.g. a test
    // agent that did not set it). [integration #5: was `(agent as {_configPath}).…`]
    const configPath: string = agent.config_path ?? DEFAULT_CONFIG_FILE;

    // ── info ────────────────────────────────────────────────────────────────
    if (sub === 'info') {
      const id = argv[1];
      if (id === undefined || id.length === 0) {
        setView({ kind: 'command_result', ok: false, text: 'usage: /app info <id>' });
        return;
      }
      // Check registry first (installed).
      const installed = installedApps(agent).find((a) => a.id === id);
      if (installed !== undefined) {
        const lines: string[] = [
          `app: ${id}  [installed]`,
          `version: ${installed.version}`,
          `blocks: ${installed.blocks.join(', ') || '(none)'}`,
          `commands: ${installed.commands.map((c) => `${c.full_name}${c.user_only ? ' (user-only)' : ''}`).join(', ') || '(none)'}`,
        ];
        const catalogEntry = BUILTIN_APP_CATALOG.find((e) => e.id === id);
        if (catalogEntry !== undefined) {
          lines.push(`summary: ${catalogEntry.summary}`);
          if (catalogEntry.requires !== undefined) lines.push(`requires: ${catalogEntry.requires}`);
        }
        setView({ kind: 'message', text: lines.join('\n') });
        return;
      }
      // Not installed — look up catalog.
      const entry = BUILTIN_APP_CATALOG.find((e) => e.id === id);
      if (entry !== undefined) {
        const lines: string[] = [
          `app: ${id}  [not installed]`,
          `summary: ${entry.summary}`,
          `default_enabled: ${entry.default_enabled}`,
        ];
        if (entry.requires !== undefined) lines.push(`requires: ${entry.requires}`);
        setView({ kind: 'message', text: lines.join('\n') });
        return;
      }
      setView({
        kind: 'command_result',
        ok: false,
        text: `unknown app id '${id}'. Run /apps to see the catalog.`,
      });
      return;
    }

    // ── install ─────────────────────────────────────────────────────────────
    if (sub === 'install') {
      const id = argv[1];
      if (id === undefined || id.length === 0) {
        setView({ kind: 'command_result', ok: false, text: 'usage: /app install <id>' });
        return;
      }
      if (!BUILTIN_APP_CATALOG.some((e) => e.id === id)) {
        setView({
          kind: 'command_result',
          ok: false,
          text: `unknown app id '${id}'. Run /apps to see installable apps.`,
        });
        return;
      }
      try {
        writeAppConfig(configPath, { apps: { [id]: { enabled: true } } });
      } catch (err) {
        setView({ kind: 'command_result', ok: false, text: `install failed: ${errorText(err)}` });
        return;
      }
      setView({
        kind: 'command_result',
        ok: true,
        text: `Wrote apps.${id}.enabled=true to ${configPath}.\n⚠ Restart to take effect.`,
      });
      return;
    }

    // ── uninstall ────────────────────────────────────────────────────────────
    if (sub === 'uninstall') {
      const id = argv[1];
      if (id === undefined || id.length === 0) {
        setView({ kind: 'command_result', ok: false, text: 'usage: /app uninstall <id>' });
        return;
      }
      if (agent.registry.get(id) === null) {
        setView({
          kind: 'command_result',
          ok: false,
          text: `app '${id}' is not installed. Run /apps to see installed apps.`,
        });
        return;
      }

      let hotResult: string | undefined;

      if (typeof agent.hotUninstall === 'function') {
        // Hot-uninstall: safe-window + unseed + uninstall + catalog rebuild (HotMutator).
        const r = await agent.hotUninstall(id);
        if (!r.ok) {
          const reason = r.reason ?? 'error';
          if (reason === 'busy') {
            setView({
              kind: 'command_result',
              ok: false,
              text: `Cannot uninstall '${id}' right now: a turn is in flight. Wait for the agent to finish and retry.`,
            });
            return;
          }
          if (reason === 'not_installed') {
            // Unusual: registry said installed but HotMutator disagrees — still write config.
            hotResult = `(hot-uninstall: not_installed, writing config anyway)`;
          } else {
            setView({
              kind: 'command_result',
              ok: false,
              text: `hot-uninstall failed for '${id}': ${r.error ?? reason}`,
            });
            return;
          }
        } else {
          const removed = r.removed_blocks?.length ? ` Removed blocks: ${r.removed_blocks.join(', ')}.` : '';
          hotResult = `Hot-uninstalled '${id}'.${removed}`;
        }
      }

      // Write config enabled:false so the app stays off after a restart.
      try {
        writeAppConfig(configPath, { apps: { [id]: { enabled: false } } });
      } catch (err) {
        setView({ kind: 'command_result', ok: false, text: `config write failed: ${errorText(err)}` });
        return;
      }

      const lines: string[] = [];
      if (hotResult !== undefined) lines.push(hotResult);
      else lines.push(`No hot-uninstall hook available.`);
      lines.push(`Wrote apps.${id}.enabled=false to ${configPath}.`);
      if (hotResult === undefined) lines.push(`⚠ Restart to fully take effect.`);
      setView({ kind: 'command_result', ok: true, text: lines.join('\n') });
      return;
    }

    // ── swap ─────────────────────────────────────────────────────────────────
    if (sub === 'swap') {
      const idA = argv[1];
      const idB = argv[2];
      if (idA === undefined || idA.length === 0 || idB === undefined || idB.length === 0) {
        setView({ kind: 'command_result', ok: false, text: 'usage: /app swap <current-id> <new-id>' });
        return;
      }
      if (agent.registry.get(idA) === null) {
        setView({
          kind: 'command_result',
          ok: false,
          text: `app '${idA}' is not installed. Nothing to swap out.`,
        });
        return;
      }
      if (!BUILTIN_APP_CATALOG.some((e) => e.id === idB)) {
        setView({
          kind: 'command_result',
          ok: false,
          text: `unknown app id '${idB}'. Run /apps to see installable apps.`,
        });
        return;
      }
      try {
        writeAppConfig(configPath, {
          apps: { [idA]: { enabled: false }, [idB]: { enabled: true } },
        });
      } catch (err) {
        setView({ kind: 'command_result', ok: false, text: `swap failed: ${errorText(err)}` });
        return;
      }
      setView({
        kind: 'command_result',
        ok: true,
        text: [
          `Plan: uninstall '${idA}', install '${idB}'.`,
          `Wrote apps.${idA}.enabled=false, apps.${idB}.enabled=true to ${configPath}.`,
          `⚠ Restart to take effect.`,
        ].join('\n'),
      });
      return;
    }

    // ── purge ─────────────────────────────────────────────────────────────────
    if (sub === 'purge') {
      const id = argv[1];
      if (id === undefined || id.length === 0) {
        setView({ kind: 'command_result', ok: false, text: 'usage: /app purge <id>' });
        return;
      }

      // allow_purge capability gate (from config, threaded onto LaunchedAgent by
      // launch.ts). Default: purge is DISABLED — operator must explicitly set
      // allow_purge:true in config. [integration #5: was `(agent as {_allowPurge}).…`]
      const allowPurge: boolean = agent.allow_purge === true;

      if (!allowPurge) {
        setView({
          kind: 'command_result',
          ok: false,
          text: [
            `/app purge is disabled. Set allow_purge:true in ${configPath} to enable it.`,
            `WARNING: purge deletes ALL local data for the app and cannot be undone.`,
          ].join('\n'),
        });
        return;
      }

      // Second-factor confirmation: require argv[2] === 'yes' OR --confirm flag.
      const confirmed = argv[2] === 'yes' || argv.includes('--confirm');
      if (!confirmed) {
        setView({
          kind: 'command_result',
          ok: false,
          text: [
            `WARNING: /app purge ${id} will delete ALL local data for app '${id}' (this cannot be undone).`,
            `Re-run with confirmation: /app purge ${id} yes`,
          ].join('\n'),
        });
        return;
      }

      // Resolve the app's local data directory: <storage_dir>/.block-agent/apps/<id>/.
      // storage_dir is the project root (threaded onto LaunchedAgent by launch.ts);
      // default to cwd. [integration #5: was `(agent as {_storageDir}).…`]
      const storageDir: string = agent.storage_dir ?? process.cwd();
      const appDir = join(storageDir, '.block-agent', 'apps', id);

      try {
        rmSync(appDir, { recursive: true, force: true });
      } catch (err) {
        setView({
          kind: 'command_result',
          ok: false,
          text: `purge failed: could not delete ${appDir}: ${errorText(err)}`,
        });
        return;
      }

      setView({
        kind: 'command_result',
        ok: true,
        text: [
          `Purged ALL local data for '${id}': deleted ${appDir}.`,
          `WARNING: this operation deleted all local data for the app and cannot be undone.`,
        ].join('\n'),
      });
      return;
    }

    // Unknown sub-command.
    setView({
      kind: 'command_result',
      ok: false,
      text: `unknown /app sub-command '${sub}'. Try /app (no args) for usage.`,
    });
  },
};

/** /status — read-only runtime/provider/app snapshot for this session. */
const statusCommand: SlashCommand = {
  name: 'status',
  summary: 'Show runtime state, provider, installed app count, and turns run this session.',
  run(agent, _argv, setView) {
    setView({
      kind: 'status',
      runtime_state: agent.runtime.state.kind,
      provider_id: agent.provider_id,
      app_count: agent.registry.list().length,
      turns: turnCount,
    });
  },
};

/** /help — list every slash command (built from the final registry). */
const helpCommand: SlashCommand = {
  name: 'help',
  summary: 'List the available slash commands.',
  run(_agent, _argv, setView) {
    const lines = SLASH_COMMANDS.map(
      (c) => `/${c.name}${c.usage ? ` ${c.usage}` : ''} — ${c.summary}`,
    );
    lines.push('');
    lines.push('Plain text (no leading /) is sent to the agent as a message.');
    setView({ kind: 'message', text: lines.join('\n') });
  },
};

/** /quit (/exit) — exit the process with code 0 (design §5). */
const quitCommand: SlashCommand = {
  name: 'quit',
  summary: 'Exit block-agent.',
  run() {
    process.exit(0);
  },
};

/** /exit — alias of /quit. */
const exitCommand: SlashCommand = {
  name: 'exit',
  summary: 'Exit block-agent (alias of /quit).',
  run() {
    process.exit(0);
  },
};

/**
 * SLASH_COMMANDS — the central registry (design §5). Order is the /help display order.
 * The dispatcher looks commands up by name here; SlashHint completes against the same
 * list. Adding a command is one entry — no switch to touch.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  cmdCommand,
  contextCommand,
  dumpCommand,
  appsCommand,
  appCommand,
  statusCommand,
  helpCommand,
  quitCommand,
  exitCommand,
];

/** O(1) name → command lookup over the registry. */
const BY_NAME: ReadonlyMap<string, SlashCommand> = new Map(
  SLASH_COMMANDS.map((c) => [c.name, c]),
);

/**
 * dispatch — parse a `/line`, look up the command, run it. The line INCLUDES the leading
 * '/'; we strip it, split on whitespace, take the first token as the command name and
 * the rest as argv handed to `run`. An unknown command reports a helpful message via
 * setView rather than throwing, so a typo never crashes the UI. Typed as the `DispatchFn`
 * contract so the UI (App.tsx) calls it with no cast.
 */
export const dispatch: DispatchFn = async (
  agent: LaunchedAgent,
  line: string,
  setView: SetView,
): Promise<void> => {
  const tokens = line.trim().slice(1).split(/\s+/).filter((t) => t.length > 0);
  const name = tokens[0];
  if (name === undefined) {
    setView({ kind: 'command_result', ok: false, text: 'empty command. Try /help.' });
    return;
  }
  const command = BY_NAME.get(name);
  if (command === undefined) {
    setView({ kind: 'command_result', ok: false, text: `unknown command '/${name}'. Try /help.` });
    return;
  }
  await command.run(agent, tokens.slice(1), setView);
};

/** Shared /context --full + /dump file write with a confirmation view (design §5). */
async function dumpToFile(agent: LaunchedAgent, file: string, setView: SetView): Promise<void> {
  try {
    await dumpFull(agent, file);
    setView({ kind: 'command_result', ok: true, text: `wrote full context to ${file}` });
  } catch (err) {
    setView({ kind: 'command_result', ok: false, text: `dump failed: ${errorText(err)}` });
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** JSON-stringify a command's data payload defensively (never throws on a cycle). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
