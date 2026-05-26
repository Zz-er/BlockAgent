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

import type { DispatchFn, LaunchedAgent, SetView, SlashCommand } from './types.js';
import { summarize, dumpFull, appsView } from './context_view.js';

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

/** /apps — list installed apps with their block names + commands (user_only flagged). */
const appsCommand: SlashCommand = {
  name: 'apps',
  summary: 'List installed apps, their blocks, and their commands (user-only flagged).',
  run(agent, _argv, setView) {
    setView({ kind: 'apps', apps: appsView(agent) });
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
