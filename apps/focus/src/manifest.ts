/**
 * apps/focus — the `focus` BlockApp: the agent's WORKING-STATE & TRAJECTORY manager.
 *
 * Authoritative design: ai_com/design/agent-working-state-and-trajectory.md (D5),
 * §3 (the 4 carriers), §3.3/§3.4 (working-state block + goal block), §6 (invariants),
 * §7 (multi-window + cold-start), §10 (P1.5a landing order), and the validation
 * amendments A1 (staleness cue + degrade) / A2 (cold-start seed + completion hint).
 *
 * THE GAP THIS CLOSES (§0): nothing in the tree carries the agent's live "what am I
 * doing, which step am I on, what did my last action produce, why was I woken this
 * turn". This app owns THREE of D5's carriers (the fourth, the off-screen ledger
 * substrate, is the separate `turn_log` app):
 *   ③ GOAL / intent (why)   — `focus.set_goal`, AGENT-written (intent is unobservable;
 *      "inference is not recovery"); rendered by GoalBlock.
 *   ④ RECENT-ACTION WINDOW  — verbatim tail (`volatile`) + folded summary
 *      (`slow_changing`), the messages:recent + messages:summary window+fold shape.
 *   ⑤ WORKING STATE         — distilled "now" (cursor / last-outcome pointer / wake
 *      reason), rendered by WorkingStateBlock (`slow_changing`).
 *
 * THE TWO WRITERS (D5 §5 — why two blocks, not one block with two fields):
 *   - The working-state block + recent window are written by the DISTILLER, a
 *     DETERMINISTIC, clock-free, LLM-free fold over each turn's `TurnRecord` (carried
 *     into `focus.record`, `allowed_invokers:['app']` — runtime/cli-fired). It folds
 *     the OBSERVABLE trajectory, so it can never forge intent and never lie about WHAT
 *     happened (the verbatim tail is the correctness floor, §3.2).
 *   - The goal block is written ONLY by the agent via `focus.set_goal`
 *     (`allowed_invokers:['agent','user']`, EXCLUDING 'app'). Excluding 'app' is the
 *     anti-injection property: an injected / foreign source can never set the agent's
 *     intent (the same `allowed_invokers` "who, not what" gate as `agent_identity.set`).
 *
 * STALENESS (A1): the distiller runs post-turn, fire-and-forget — so the working-state
 * block is ALWAYS ≥1 turn stale by design. Two defenses, both inside this block:
 *   (ii) the block header writes "distilled as of turn K · recent window authoritative"
 *        so the LLM treats the verbatim tail (④) as the priority source, and
 *   (iii) when `fresh=false` the block DEGRADES to "(working-state unavailable — read
 *        recent window)", handing authority explicitly back to ④.
 *
 * MULTI-WINDOW (§3.3 / §7): state is a PER-FOCUS keyed map; the builders render ONLY
 * the active focus's slice. N foci in state, 1 rendered. Switching focus is a legal
 * `slow_changing` re-render, not cache corruption.
 *
 * INVARIANTS held here:
 *   #1 / #16  builders are PURE: read `state` only, no clock / random / env. The fold
 *             (the non-determinism, such as it is) happens in the COMMAND path
 *             (`focus.record` / `focus.set_goal`), never in `build`. Same state →
 *             byte-identical bytes. Structurally isomorphic to messages' summarize →
 *             SummaryBlockBuilder (state written by a command, pure builder renders).
 *    #4       builder owner is `system` (`agent` is illegal).
 *   #13       intent is unobservable → it must be agent-written (③); the working-state
 *             block only renders the OBSERVABLE trajectory, never re-feeds reasoning.
 *   #14       state is bounded JSON (per-focus recent window is capped; the full
 *             trajectory lives in the ledger / focus jsonl, never unbounded in state).
 *   #15       block names are `<app_id>:<name>` (`focus:working_state` etc).
 *
 * House style (§0.5): block-world nouns get the `Block` prefix (`WorkingStateBlock`,
 * `GoalBlock`); the App itself is `FocusApp`. Block names use a COLON.
 */

import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Block, BlockName, WakeEvent } from '@block-agent/core/core/types.js';
import type {
  AppContext,
  AppManifest,
  BuildContext,
  BuilderManifest,
  CommandManifest,
  CommandResult,
  JsonSchema,
} from '@block-agent/core/app/types.js';

// ============================================================================
// Identity & block names
// ============================================================================

/** App id + tree namespace (§4.2). */
const APP_ID = 'focus' as const;
const TREE_NAMESPACE = '/focus' as const;

/** The three blocks this App renders (INV #15). All key off the ACTIVE focus's slice. */
export const WORKING_STATE_BLOCK: BlockName = 'focus:working_state';
export const RECENT_ACTION_BLOCK: BlockName = 'focus:recent';
export const ACTIONS_SUMMARY_BLOCK: BlockName = 'focus:summary';
export const GOAL_BLOCK: BlockName = 'focus:goal';

/** jsonl file under `.block-agent/apps/focus/` (§12.1 / §12.2). */
const FOCUS_FILE = 'focus.jsonl' as const;

/** §12.2: each jsonl line MUST be ≤ 64KB. */
const MAX_LINE_BYTES = 64 * 1024;

/** Timeout (ms) spinning for the advisory lock before giving up. */
const LOCK_TIMEOUT_MS = 5_000;

/** The degraded working-state text rendered when the active focus is not fresh (A1 iii). */
const DEGRADED_WORKING_STATE = '(working-state unavailable — read recent window)';

// ============================================================================
// Config (bounded recent window)
// ============================================================================

/**
 * FocusConfig — tunable knobs. `recent_limit` bounds the verbatim recent-action window
 * (the rest folds into `actions_summary`), keeping state bounded (INV #14).
 */
export interface FocusConfig {
  recent_limit: number;
}

const DEFAULT_CONFIG: FocusConfig = {
  recent_limit: 8,
};

/** Clamp config to sane ranges (defends against bad input). */
function clampConfig(cfg: FocusConfig): FocusConfig {
  return { recent_limit: Math.max(1, Math.min(100, Math.floor(cfg.recent_limit))) };
}

// ============================================================================
// State (bounded projection — INV #14)
// ============================================================================

/**
 * RecentAction — one verbatim entry in the recent-action window (④). Deterministic:
 * every field is copied off the `TurnRecord` (the `turn_id` is the runtime's
 * monotonic `${wake_seq}.${turn_index}`, never a wall-clock — INV #16).
 */
export interface RecentAction {
  /** The turn that produced this action (TurnRecord.turn_id; monotonic, not a clock). */
  turn_id: string;
  /** Which branch ended the turn (TurnRecord.ended_by) — the observable outcome class. */
  ended_by: string;
  /** The wake reason that opened the turn (off WakeEvent), human-readable. */
  wake: string;
}

/**
 * FocusSlice — one focus's working state (⑤ + ③ + ④ for that window). Per-focus keyed
 * so multiple windows coexist; only the ACTIVE slice renders (§3.3 / §7).
 */
export interface FocusSlice {
  /** ③ The agent's stated intent for this focus. Agent-written via `focus.set_goal`. */
  goal: string;
  /** ⑤ The step cursor + a free note (e.g. the A2 completion hint). */
  cursor: { step: number; note: string };
  /** ④ The verbatim recent-action window (bounded by config.recent_limit). */
  recent_actions: RecentAction[];
  /** ④ The folded summary of actions older than the window (a count + trace). */
  actions_summary: string;
  /** ⑤ Pointer (NOT a copy) into the recent window: the last action's turn_id, or ''. */
  last_outcome_ptr: string;
  /** ⑤ The distilled wake reason for this focus ("why am I here this turn"). */
  wake_reason: string;
  /** ⑤ The turn this slice was last distilled as of (TurnRecord.turn_id). */
  distilled_as_of: string;
  /** A1: false until the distiller has run at least once → the block DEGRADES (A1 iii). */
  fresh: boolean;
}

/**
 * FocusState — bounded projection of every focus (INV #14). `active_focus` selects the
 * one slice the builders render; `foci` is the per-focus keyed map. The full trajectory
 * is the ledger / focus jsonl, never unbounded in state.
 */
export interface FocusState {
  active_focus: string;
  foci: Record<string, FocusSlice>;
  config: FocusConfig;
}

/** A schema-valid empty slice (used for cold-start seeding + defaults). */
function emptySlice(): FocusSlice {
  return {
    goal: '',
    cursor: { step: 0, note: '' },
    recent_actions: [],
    actions_summary: '',
    last_outcome_ptr: '',
    wake_reason: '',
    distilled_as_of: '',
    fresh: false,
  };
}

/** INV #14: declare every state key so set_state is schema-checked. */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['active_focus', 'foci', 'config'],
  properties: {
    active_focus: { type: 'string' },
    foci: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: [
          'goal',
          'cursor',
          'recent_actions',
          'actions_summary',
          'last_outcome_ptr',
          'wake_reason',
          'distilled_as_of',
          'fresh',
        ],
        properties: {
          goal: { type: 'string' },
          cursor: {
            type: 'object',
            required: ['step', 'note'],
            properties: { step: { type: 'number' }, note: { type: 'string' } },
          },
          recent_actions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['turn_id', 'ended_by', 'wake'],
              properties: {
                turn_id: { type: 'string' },
                ended_by: { type: 'string' },
                wake: { type: 'string' },
              },
            },
          },
          actions_summary: { type: 'string' },
          last_outcome_ptr: { type: 'string' },
          wake_reason: { type: 'string' },
          distilled_as_of: { type: 'string' },
          fresh: { type: 'boolean' },
        },
      },
    },
    config: {
      type: 'object',
      required: ['recent_limit'],
      properties: { recent_limit: { type: 'number' } },
    },
  },
};

// ============================================================================
// Deterministic fold helpers (the DISTILLER — clock-free, LLM-free, INV #16)
// ============================================================================

/**
 * Identify the focus a wake belongs to (§7). A focus id keys a window: for an
 * app_event we key off the `source` (e.g. all `messages` wakes share one focus, all
 * `task` wakes another); the other wake variants key off their own kind. The `ref`
 * (e.g. a message id) deliberately does NOT split the focus — a window persists across
 * many messages. Pure + total.
 */
export function focusIdOf(wake: WakeEvent): string {
  switch (wake.kind) {
    case 'app_event':
      return `${wake.source}`;
    case 'scheduled_tick':
      return `cron:${wake.cron_id}`;
    case 'builder_completed':
      return 'builder';
    case 'sub_agent_returned':
      return `sub:${wake.sub_id}`;
  }
}

/**
 * A human-readable wake reason (⑤). Deterministic projection of the WakeEvent — the
 * runtime owns this fact (the agent cannot infer "who woke me", §0). Used both for the
 * cold-start seed (§7) and for each recorded action's `wake`.
 */
export function wakeReasonOf(wake: WakeEvent): string {
  switch (wake.kind) {
    case 'app_event': {
      const reason = wake.reason !== undefined && wake.reason.length > 0 ? wake.reason : 'event';
      const ref = wake.ref !== undefined && wake.ref.length > 0 ? ` (${wake.ref})` : '';
      return `${wake.source}: ${reason}${ref}`;
    }
    case 'scheduled_tick':
      return `scheduled tick (${wake.cron_id})`;
    case 'builder_completed':
      return `builder completed (${wake.output_block_id})`;
    case 'sub_agent_returned':
      return `sub-agent returned (${wake.sub_id})`;
  }
}

/** A TurnRecord seen by the distiller — only the fields the fold reads (decoupled). */
export interface DistillerTurnRecord {
  turn_id: string;
  wake_event: WakeEvent;
  ended_by: string;
}

/** Narrow loosely-typed `focus.record` args to a DistillerTurnRecord, or null. */
function readTurnRecord(args: unknown): DistillerTurnRecord | null {
  if (typeof args !== 'object' || args === null) return null;
  const rec = (args as { turn_record?: unknown }).turn_record;
  if (typeof rec !== 'object' || rec === null) return null;
  const r = rec as Record<string, unknown>;
  const turn_id = typeof r['turn_id'] === 'string' ? r['turn_id'] : null;
  const ended_by = typeof r['ended_by'] === 'string' ? r['ended_by'] : null;
  const wake = r['wake_event'];
  if (turn_id === null || ended_by === null || !isWakeEvent(wake)) return null;
  return { turn_id, ended_by, wake_event: wake };
}

/** Minimal structural guard for a WakeEvent (the fold only branches on `kind`). */
function isWakeEvent(v: unknown): v is WakeEvent {
  if (typeof v !== 'object' || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  return (
    kind === 'app_event' ||
    kind === 'scheduled_tick' ||
    kind === 'builder_completed' ||
    kind === 'sub_agent_returned'
  );
}

/**
 * Append an action to a slice's recent window and fold the overflow into the summary —
 * the messages:recent + messages:summary window+fold shape (§3.2). Pure: returns a NEW
 * slice. Folds everything older than `recent_limit` into a running count+trace summary.
 */
function appendAndCompact(
  slice: FocusSlice,
  action: RecentAction,
  recent_limit: number,
): FocusSlice {
  const grown = [...slice.recent_actions, action];
  if (grown.length <= recent_limit) {
    return { ...slice, recent_actions: grown };
  }
  const foldCount = grown.length - recent_limit;
  const folded = grown.slice(0, foldCount);
  const kept = grown.slice(foldCount);
  const trace = folded.map((a) => `${a.turn_id}:${a.ended_by}`).join(' | ');
  const note = `[${folded.length} earlier action${folded.length === 1 ? '' : 's'} folded] ${trace}`;
  const actions_summary =
    slice.actions_summary.length === 0 ? note : `${slice.actions_summary}\n${note}`;
  return { ...slice, recent_actions: kept, actions_summary };
}

/**
 * Heuristic: does this turn's outcome suggest the active goal is complete? (A2). A
 * `reply`-ended turn (the agent said its final word to the user) is the observable
 * signal we have. Deterministic; only ever sets a HINT the agent confirms — the
 * distiller is structurally barred from clearing the goal itself (③ is agent-only).
 */
function looksComplete(ended_by: string): boolean {
  return ended_by === 'reply';
}

/**
 * The DETERMINISTIC fold for one turn (the distiller body, §3.3 A1(i)). Reads only the
 * TurnRecord — NO clock, NO random, NO LLM. Returns the next FocusState:
 *   - select active_focus from the wake event (§7);
 *   - cold-start seed wake_reason on a brand-new focus (§7 / A2) — overwritten below;
 *   - append to the recent window + compact (④);
 *   - step++, set last_outcome_ptr + distilled_as_of, mark fresh (⑤);
 *   - (A2) on a completion-looking outcome, set a confirm hint in cursor.note.
 * Same TurnRecord sequence → same FocusState (determinism), exported for direct testing.
 */
export function foldTurn(state: FocusState, record: DistillerTurnRecord): FocusState {
  const id = focusIdOf(record.wake_event);
  const reason = wakeReasonOf(record.wake_event);
  // Cold-start (§7): a brand-new focus is seeded with its wake reason so the FIRST
  // render is not blind to "why am I awake"; the fold below then overwrites it with the
  // real distilled value this same turn.
  const prior = state.foci[id] ?? { ...emptySlice(), wake_reason: reason };

  const action: RecentAction = {
    turn_id: record.turn_id,
    ended_by: record.ended_by,
    wake: reason,
  };
  const withWindow = appendAndCompact(prior, action, state.config.recent_limit);

  const note = looksComplete(record.ended_by) && withWindow.goal.length > 0
    ? 'goal looks complete? — confirm or update via focus.set_goal'
    : '';

  const nextSlice: FocusSlice = {
    ...withWindow,
    cursor: { step: prior.cursor.step + 1, note },
    last_outcome_ptr: record.turn_id,
    wake_reason: reason,
    distilled_as_of: record.turn_id,
    fresh: true,
  };

  return {
    ...state,
    active_focus: id,
    foci: { ...state.foci, [id]: nextSlice },
  };
}

// ============================================================================
// Builders — render ONLY the active focus's slice (§3.3). All PURE (INV #1 / #16).
// ============================================================================

/** Narrow an AppContext's state to FocusState; null if missing / wrong shape. */
function focusStateOf(app_ctx: AppContext | undefined): FocusState | null {
  if (app_ctx === undefined) return null;
  const s = app_ctx.state;
  if (typeof s !== 'object' || s === null) return null;
  const cand = s as Partial<FocusState>;
  if (typeof cand.active_focus !== 'string' || cand.foci == null || cand.config == null) return null;
  return s as FocusState;
}

/** The active focus's slice, or null if there is none yet (nothing to render). */
function activeSliceOf(state: FocusState): FocusSlice | null {
  return state.foci[state.active_focus] ?? null;
}

/**
 * WorkingStateBlock — owner of `focus:working_state` (⑤). Renders the ACTIVE focus's
 * distilled "now": wake reason, step cursor, last-outcome pointer (NOT a copy — it
 * points into the recent window), plus the A1(ii) staleness + priority cue. When the
 * slice is not `fresh` (A1 iii) it DEGRADES to a one-line "read the recent window"
 * notice, handing authority explicitly back to ④. cache_tier `slow_changing`. Pure.
 */
const WorkingStateBlock: BuilderManifest = {
  name: 'WorkingStateBlock',
  version: '1.0.0',
  owner: 'system', // INV #4: 'agent' illegal.
  app_id: APP_ID,
  inputs: [],
  outputs: [WORKING_STATE_BLOCK],
  cache_tier: 'slow_changing',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = focusStateOf(app_ctx);
    if (state === null) return null;
    const slice = activeSliceOf(state);
    if (slice === null) return null;
    return {
      id: WORKING_STATE_BLOCK,
      name: WORKING_STATE_BLOCK,
      children: [],
      content_text: renderWorkingState(slice),
      content_blob: null,
    };
  },
};

/** Deterministic text projection of the active working-state slice (⑤ / A1). */
function renderWorkingState(slice: FocusSlice): string {
  // A1 (iii): degrade when the distiller has not produced a fresh value — hand
  // authority to the verbatim recent window rather than render a stale-and-lying block.
  if (!slice.fresh) {
    return ['# Working state', DEGRADED_WORKING_STATE].join('\n');
  }
  const lines = [
    '# Working state',
    // A1 (ii): explicit staleness + priority cue so the LLM treats ④ as authoritative.
    `(distilled as of turn ${slice.distilled_as_of} · recent window is authoritative)`,
    `Wake reason: ${slice.wake_reason}`,
    `Step: ${slice.cursor.step}`,
    slice.last_outcome_ptr.length > 0
      ? `Last outcome: turn ${slice.last_outcome_ptr} (see recent window)`
      : 'Last outcome: (none yet)',
  ];
  if (slice.cursor.note.length > 0) lines.push(`Note: ${slice.cursor.note}`);
  return lines.join('\n');
}

/**
 * RecentActionWindow — owner of `focus:recent` (④, the verbatim tail). cache_tier
 * `volatile`: changes most turns → renders at the prompt tail. This is the correctness
 * floor (§3.2): when the distilled working-state block and this tail disagree, this
 * wins. Pure: reads the active slice's `recent_actions` only.
 */
const RecentActionWindow: BuilderManifest = {
  name: 'RecentActionWindow',
  version: '1.0.0',
  owner: 'system',
  app_id: APP_ID,
  inputs: [],
  outputs: [RECENT_ACTION_BLOCK],
  cache_tier: 'volatile',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = focusStateOf(app_ctx);
    if (state === null) return null;
    const slice = activeSliceOf(state);
    if (slice === null || slice.recent_actions.length === 0) return null;
    const lines = slice.recent_actions.map((a) => `- turn ${a.turn_id}: ${a.ended_by} — woke by ${a.wake}`);
    return {
      id: RECENT_ACTION_BLOCK,
      name: RECENT_ACTION_BLOCK,
      children: [],
      content_text: ['# Recent actions', ...lines].join('\n'),
      content_blob: null,
    };
  },
};

/**
 * ActionsSummary — owner of `focus:summary` (④, the folded older tail). cache_tier
 * `slow_changing`: changes only when a fold runs, so it sits mid-prompt and stays
 * cache-warm. Pure: reads the active slice's `actions_summary` only. Renders nothing
 * until the first fold.
 */
const ActionsSummary: BuilderManifest = {
  name: 'ActionsSummary',
  version: '1.0.0',
  owner: 'system',
  app_id: APP_ID,
  inputs: [],
  outputs: [ACTIONS_SUMMARY_BLOCK],
  cache_tier: 'slow_changing',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = focusStateOf(app_ctx);
    if (state === null) return null;
    const slice = activeSliceOf(state);
    if (slice === null || slice.actions_summary.length === 0) return null;
    return {
      id: ACTIONS_SUMMARY_BLOCK,
      name: ACTIONS_SUMMARY_BLOCK,
      children: [],
      content_text: `# Earlier actions (folded)\n${slice.actions_summary}`,
      content_blob: null,
    };
  },
};

/**
 * GoalBlock — owner of `focus:goal` (③, the intent). A SEPARATE block from the
 * working-state block because it has a DIFFERENT WRITER (the agent, via
 * `focus.set_goal`), not the distiller (D5 §5). cache_tier `slow_changing`. Pure: reads
 * the active slice's `goal` only. Renders nothing when no goal is set.
 */
const GoalBlock: BuilderManifest = {
  name: 'GoalBlock',
  version: '1.0.0',
  owner: 'system',
  app_id: APP_ID,
  inputs: [],
  outputs: [GOAL_BLOCK],
  cache_tier: 'slow_changing',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = focusStateOf(app_ctx);
    if (state === null) return null;
    const slice = activeSliceOf(state);
    if (slice === null || slice.goal.length === 0) return null;
    return {
      id: GOAL_BLOCK,
      name: GOAL_BLOCK,
      children: [],
      content_text: `# Goal\n${slice.goal}`,
      content_blob: null,
    };
  },
};

// ============================================================================
// Commands — set_goal (③, agent/user) + record (the distiller, app-only)
// ============================================================================

/**
 * focus.set_goal({ text }) — set the ACTIVE focus's goal (③). `allowed_invokers:
 * ['agent','user']` EXCLUDES 'app': intent is agent-written, and barring 'app' means
 * an injected / foreign source can never set the agent's goal (the anti-injection
 * property, §3.4 — same "who, not what" gate as `agent_identity.set`). Writes only the
 * goal field of the active slice (cold-starting an empty slice if none exists yet) so
 * the distiller's working-state fields are untouched.
 */
function setGoalCommand(): CommandManifest<FocusState> {
  return {
    name: 'set_goal',
    description: 'Set your current goal / intent for the active focus. Put it in `text`.',
    capabilities: [{ name: 'block:write' }],
    // Anti-injection: agent + user may state intent; 'app' (injected/foreign) may NOT.
    allowed_invokers: ['agent', 'user'],
    args_schema: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string', description: 'The goal / intent text.' } },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const text = (args as { text?: unknown } | undefined)?.text;
      if (typeof text !== 'string' || text.length === 0)
        return { ok: false, error: 'set_goal requires a non-empty string `text`' };
      ctx.set_state((s) => {
        const st = s as FocusState;
        const id = st.active_focus;
        const prior = st.foci[id] ?? emptySlice();
        // Setting (or clearing) the goal also clears any stale "goal looks complete?"
        // hint — the agent has just spoken to its intent, so the A2 prompt is resolved.
        return {
          ...st,
          foci: {
            ...st.foci,
            [id]: { ...prior, goal: text, cursor: { ...prior.cursor, note: '' } },
          },
        };
      });
      return { ok: true, data: { focus: (ctx.state as FocusState).active_focus } };
    },
  };
}

/**
 * focus.record({ turn_record }) — the DISTILLER entry point. `allowed_invokers:['app']`
 * (runtime/cli-fired from `AgentRuntime.onTurn`, NOT the agent and NOT the user). Runs
 * the DETERMINISTIC, clock-free, LLM-free fold (`foldTurn`): selects the active focus
 * from `turn_record.wake_event`, cold-start seeds a new focus's wake reason, appends to
 * the recent window + compacts, steps the cursor, sets the last-outcome pointer +
 * distilled_as_of, marks the slice fresh, and (A2) sets a completion hint when the
 * outcome suggests it. Also durably appends the action to the focus jsonl. NO clock, NO
 * random — purely a function of the TurnRecord (INV #16).
 */
function recordCommand(app: FocusApp): CommandManifest<FocusState> {
  return {
    name: 'record',
    description: 'Distill one turn into the working-state block (app/runtime only).',
    capabilities: [{ name: 'block:write' }],
    // App-only: this is the runtime's post-turn distiller, never an agent/user action.
    allowed_invokers: ['app'],
    args_schema: {
      type: 'object',
      required: ['turn_record'],
      properties: { turn_record: { type: 'object' } },
    },
    invoke: async (args, ctx): Promise<CommandResult> => {
      const record = readTurnRecord(args);
      if (record === null)
        return { ok: false, error: 'record requires a `turn_record` with turn_id/ended_by/wake_event' };
      ctx.set_state((s) => foldTurn(s as FocusState, record));
      // Durable append (the focus jsonl substrate; restart-restore reads it back).
      app.store.append({
        turn_id: record.turn_id,
        ended_by: record.ended_by,
        focus: focusIdOf(record.wake_event),
        wake: wakeReasonOf(record.wake_event),
      });
      return { ok: true, data: { focus: (ctx.state as FocusState).active_focus } };
    },
  };
}

// ============================================================================
// jsonl store — append-only, ≤64KB/line, advisory lock 'wx', startup tail-truncate
// ============================================================================

/** One durable focus-action record in the jsonl substrate. */
export interface FocusRecord {
  turn_id: string;
  ended_by: string;
  focus: string;
  wake: string;
}

/**
 * FocusStore — one append-only jsonl file under `.block-agent/apps/focus/` (§12.1 /
 * §12.2): each line ≤ 64KB, an exclusive advisory lock around every append, startup
 * tail-truncate of a crash-torn last line. The full trajectory lives here; state holds
 * only the bounded projection (INV #14). `readAll` seeds restart-restore.
 */
export class FocusStore {
  private readonly path: string;
  private readonly lockPath: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, FOCUS_FILE);
    this.lockPath = `${this.path}.lock`;
    this.truncateIncompleteTail();
  }

  /** Append one record as a single jsonl line under an exclusive advisory lock. */
  append(record: FocusRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_LINE_BYTES)
      throw new Error(
        `focus jsonl line is ${bytes}B, exceeds the ${MAX_LINE_BYTES}B/line limit (§12.2)`,
      );
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

  /** Read every complete record currently in the file (used by restart-restore/tests). */
  readAll(): FocusRecord[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const out: FocusRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as FocusRecord);
      } catch {
        continue; // skip unparseable (shouldn't happen after tail-truncate)
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
      if (Date.now() > deadline)
        throw new Error(`focus jsonl lock timeout on ${lockPath} (held too long)`);
      // Tight spin: appends are sub-millisecond; staying synchronous avoids async.
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
// Restart-restore — rebuild a bounded FocusState from the durable jsonl (§6 / D5 §6)
// ============================================================================

/**
 * Rebuild a bounded FocusState by replaying the durable jsonl through the SAME
 * deterministic fold the live path uses — so restart-restore and live distillation
 * agree by construction (D5 §6: "the fold can even be re-distilled from the recovered
 * ledger"). A restored slice is marked `fresh` (its trajectory IS the recovered fact);
 * the goal is NOT in the jsonl (③ is agent-written, not part of the action substrate),
 * so a restored goal starts empty until the agent restates it. Total + never throws.
 */
export function restoreState(records: readonly FocusRecord[], config: FocusConfig): FocusState {
  let state: FocusState = { active_focus: '', foci: {}, config };
  for (const rec of records) {
    // Reconstruct a minimal WakeEvent from the stored focus id is lossy, so replay
    // directly against the stored focus rather than re-deriving it from a wake event.
    state = replayRecord(state, rec);
  }
  return state;
}

/** Replay one durable record into state (the restore-time twin of `foldTurn`). */
function replayRecord(state: FocusState, rec: FocusRecord): FocusState {
  const id = rec.focus;
  const prior = state.foci[id] ?? { ...emptySlice(), wake_reason: rec.wake };
  const action: RecentAction = { turn_id: rec.turn_id, ended_by: rec.ended_by, wake: rec.wake };
  const withWindow = appendAndCompact(prior, action, state.config.recent_limit);
  const note = looksComplete(rec.ended_by) && withWindow.goal.length > 0
    ? 'goal looks complete? — confirm or update via focus.set_goal'
    : '';
  const nextSlice: FocusSlice = {
    ...withWindow,
    cursor: { step: prior.cursor.step + 1, note },
    last_outcome_ptr: rec.turn_id,
    wake_reason: rec.wake,
    distilled_as_of: rec.turn_id,
    fresh: true,
  };
  return { ...state, active_focus: id, foci: { ...state.foci, [id]: nextSlice } };
}

// ============================================================================
// FocusApp — the BlockApp
// ============================================================================

/** Options for constructing a FocusApp. */
export interface FocusAppOptions {
  /** Storage dir (defaults to `.block-agent/apps/focus/`). */
  dir?: string;
  /** Config override (defaults to the compiled defaults). */
  config?: Partial<FocusConfig>;
  /** Injectable store for testing (overrides the jsonl store). */
  store?: FocusStore;
}

/** `.block-agent/apps/focus` under cwd — the default storage dir (§12.1). */
const DEFAULT_DIR = join(process.cwd(), '.block-agent', 'apps', 'focus');

/**
 * FocusApp — the concrete working-state / trajectory BlockApp. `manifest()` produces the
 * AppManifest the AppRegistry installs. At construction it reads the focus jsonl and
 * replays it into `initial_state` (restart-restore, §6) so a restart resumes the
 * distilled trajectory; it NEVER throws at boot (a missing / torn file restores empty).
 * The App captures its AppContext in `on_install`.
 */
export class FocusApp {
  readonly store: FocusStore;
  private readonly config: FocusConfig;
  private readonly initialState: FocusState;
  private ctx: AppContext<FocusState> | null = null;

  constructor(opts: FocusAppOptions = {}) {
    const dir = opts.dir ?? DEFAULT_DIR;
    this.store = opts.store ?? new FocusStore(dir);
    this.config = clampConfig({ ...DEFAULT_CONFIG, ...opts.config });
    // Restart-restore (§6): replay the durable jsonl into a bounded initial state.
    // Guarded so a read/parse failure never blocks boot (start empty instead).
    let restored: FocusState;
    try {
      restored = restoreState(this.store.readAll(), this.config);
    } catch {
      restored = { active_focus: '', foci: {}, config: this.config };
    }
    this.initialState = restored;
  }

  /**
   * The AppManifest to hand to `AppRegistry.install`. Returned widened to the bare
   * `AppManifest` per the team's locked TS2379 convention. Four builders (working-state,
   * recent window, actions summary, goal) + two commands (set_goal, record).
   */
  manifest(): AppManifest {
    const app = this;
    const manifest: AppManifest<FocusState> = {
      id: APP_ID,
      version: '1.0.0',
      depends_on: [],
      tree_namespace: TREE_NAMESPACE,
      initial_state: this.initialState,
      state_schema: STATE_SCHEMA,
      builders: [
        () => WorkingStateBlock,
        () => RecentActionWindow,
        () => ActionsSummary,
        () => GoalBlock,
      ],
      commands: [() => setGoalCommand(), () => recordCommand(app)],
      async on_install(ctx) {
        app.ctx = ctx as AppContext<FocusState>;
      },
    };
    return manifest as AppManifest;
  }
}

// Re-export names + defaults for tests / cross-app references.
export { DEFAULT_CONFIG, FOCUS_FILE, DEGRADED_WORKING_STATE, emptySlice };
