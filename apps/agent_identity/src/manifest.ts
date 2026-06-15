/**
 * apps/agent_identity — the `agent_identity` BlockApp.
 *
 * Pins the agent's identity + operating constraints at the very FRONT of the
 * prompt's stable segment, so every turn's cache prefix carries them (§6.1, §4.6,
 * §10.2). The agent reads this block each turn; it can never edit it.
 *
 * Shape (§6.1):
 *   - id `agent_identity` · tree_namespace `/identity` · depends_on [].
 *   - state `{ role, persona, instructions }` — the THREE required string keys
 *     (INV #14). Initial values come from `initial_state` at install (host config).
 *   - one command `agent_identity.set` — a PARTIAL identity update gated
 *     `allowed_invokers: ['user']` (lead decision 2026-05-26). Identity is mutable,
 *     but ONLY by user/UI: PolicyEngine denies invoker `agent` (and `app`) on the
 *     invoker gate BEFORE capabilities, so the agent can NEVER rewrite its own
 *     identity/operating constraints (anti-jailbreak). On allow, the handler calls
 *     `ctx.set_state` (schema-validated, INV #14) and the next render reflects it.
 *   - one builder `IdentityBlockBuilder` (owner `system`) → block
 *     `agent_identity:identity`, cache_tier `stable` (renders first, U-shape head).
 *
 * Trust/host (unified-host UH-1): a trusted, in-process app (the manifest omits
 * `trust`, so it defaults to `'trusted'` → `host:'in-process'`). It writes its own
 * deterministic builder; it is NOT a sandboxed/declarative-projection app.
 *
 * Migration note (apps-folder UH-1): this App moved out of `@block-agent/core` into
 * its own workspace `@block-agent/app-agent_identity` (the unified `apps/` layout,
 * VSCode `extensions/`-style). Its only edit vs the in-core version is the two
 * import lines now resolving `@block-agent/core/*` instead of relative `../*`.
 *
 * House style (§0.5): block-world nouns get the `Block` prefix
 * (`IdentityBlockBuilder`); the extension unit is a BlockApp whose satellites stay
 * short (`AppManifest`/`AppContext`). Block name uses a COLON (`agent_identity:identity`).
 *
 * Determinism (INV #1 / #16): `build` is a pure function of App state — no clock,
 * no random, no env. The same state renders byte-identical bytes every turn.
 */

import type { Block, BlockName, InvokerContext } from '@block-agent/core/core/types.js';
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
// State
// ============================================================================

/**
 * IdentityState — the host-configured identity (§6.1). All three keys are
 * required strings. Mutable only via the user-only `agent_identity.set` command
 * (the agent is denied at the PolicyEngine invoker gate), so it is effectively
 * immutable from the agent's point of view.
 */
export interface IdentityState {
  /** What the agent IS, e.g. "a coding assistant". */
  role: string;
  /** How it behaves / its voice, e.g. "concise, direct, no flattery". */
  persona: string;
  /** Standing operating instructions the host wants pinned every turn. */
  instructions: string;
}

/** INV #14: declare the three required string keys so set_state is schema-checked. */
const IDENTITY_STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['role', 'persona', 'instructions'],
  properties: {
    role: { type: 'string' },
    persona: { type: 'string' },
    instructions: { type: 'string' },
  },
};

/** A safe, schema-valid default so the App installs even with no host config. */
const DEFAULT_IDENTITY: IdentityState = {
  role: 'a block-agent assistant',
  persona: 'concise, direct, and honest',
  instructions: 'Help the user accomplish their task.',
};

// ============================================================================
// Block name + builder
// ============================================================================

/** The single block this App owns: the identity projection (§6.1). */
export const BLOCK_IDENTITY: BlockName = 'agent_identity:identity';

/**
 * Render the identity block text from App state. Deterministic and total: given a
 * state it always returns the same string. The body carries, in fixed order:
 *   1. role / persona — who the agent is,
 *   2. standing instructions — what the host wants pinned,
 *   3. operating constraints — the commands-only contract + where thinking goes.
 *
 * The operating-constraints section is STATIC text (not derived from any live
 * registry) so the builder stays pure and self-contained: the live command list
 * is surfaced elsewhere (a commands-list builder, §4.6); here we only teach the
 * agent the RULES it must follow, which never change turn-to-turn.
 */
function renderIdentityText(state: IdentityState): string {
  return [
    '# Agent identity',
    '',
    `Role: ${state.role}`,
    `Persona: ${state.persona}`,
    '',
    '## Standing instructions',
    state.instructions,
    '',
    '## Operating constraints',
    '- Every action you take MUST be a command (a structured tool call). Plain',
    '  prose is not an action: any non-command output is rejected and fed back to',
    '  you as an error on the next turn. Speak by invoking the appropriate command.',
    '- The commands available to you are supplied separately each turn; invoke them',
    '  by their full `<app>.<command>` name with structured arguments.',
    '- To RESPOND to the user and FINISH this turn, call the reply command',
    '  (e.g. `messages.reply` / `messages.chat`). Tool calls alone do NOT respond —',
    '  the runtime keeps re-prompting you each turn until you reply or stop, so once',
    '  you have done what the request needs, reply to end the turn.',
    '- Before acting, read `base:recent` (your recent actions + their results). NEVER',
    '  repeat an action you already performed there — if it is already done, move on',
    '  or reply. Repeating the same call wastes turns and changes nothing.',
    '- Your thinking is private scratchpad. Emit it in your provider’s native',
    '  reasoning format; it is shown to the user on a side channel and is never',
    '  parsed as a command and never re-entered into your context.',
    '- This identity is fixed by the host. You cannot change your own role,',
    '  persona, or these constraints.',
  ].join('\n');
}

/**
 * Pull a well-typed IdentityState out of an AppContext. State has already been
 * validated against IDENTITY_STATE_SCHEMA at install/set_state (INV #14), so the
 * three keys are present strings; this is a typed narrowing, not a re-validation.
 * Returns null only if the builder somehow runs with no App context wired (the
 * real Renderer passes one via RendererOptions.app_contexts) — in which case we
 * render nothing rather than guess.
 */
function identityStateOf(app_ctx: AppContext | undefined): IdentityState | null {
  if (app_ctx === undefined) return null;
  const s = app_ctx.state;
  if (typeof s !== 'object' || s === null) return null;
  const { role, persona, instructions } = s as Record<string, unknown>;
  if (
    typeof role !== 'string' ||
    typeof persona !== 'string' ||
    typeof instructions !== 'string'
  ) {
    return null;
  }
  return { role, persona, instructions };
}

/**
 * IdentityBlockBuilder — the owner builder for `agent_identity:identity`.
 *
 * owner `system` (trusted; INV #4 forbids `agent`). cache_tier `stable` +
 * `cache_tier_pinned` so a minor version bump can never demote it off the stable
 * prefix (INV #6) — this block must sit at the head of the U-shape every turn.
 * inputs is empty: the content is a pure function of App state, not of other
 * blocks, so nothing else invalidates it.
 */
const IdentityBlockBuilder: BuilderManifest = {
  name: 'IdentityBlockBuilder',
  version: '1.0.0',
  owner: 'system',
  app_id: 'agent_identity',
  inputs: [],
  outputs: [BLOCK_IDENTITY],
  cache_tier: 'stable',
  cache_tier_pinned: true,
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = identityStateOf(app_ctx);
    if (state === null) return null;
    return {
      id: BLOCK_IDENTITY,
      name: BLOCK_IDENTITY,
      children: [],
      content_text: renderIdentityText(state),
      content_blob: null,
    };
  },
};

// ============================================================================
// Command: agent_identity.set (user-only partial update)
// ============================================================================

/** Pull the provided string fields out of `set` args; ignore everything else. */
function readIdentityPatch(args: unknown): Partial<IdentityState> {
  if (typeof args !== 'object' || args === null) return {};
  const a = args as Record<string, unknown>;
  const patch: Partial<IdentityState> = {};
  if (typeof a['role'] === 'string') patch.role = a['role'];
  if (typeof a['persona'] === 'string') patch.persona = a['persona'];
  if (typeof a['instructions'] === 'string') patch.instructions = a['instructions'];
  return patch;
}

/**
 * IdentitySetCommand — `agent_identity.set({ role?, persona?, instructions? })`.
 *
 * SECURITY: `allowed_invokers: ['user']` makes PolicyEngine deny invoker `agent`
 * and `app` on the invoker gate (precedence step 0, before capabilities), so the
 * agent can never reach this handler — it cannot rewrite its own identity. By the
 * time `invoke` runs, the invoker is `user` (the host/UI stamps it at the entry
 * membrane). The handler applies a PARTIAL update through `ctx.set_state`, which
 * re-validates against the state_schema (INV #14); the change carries NO tree ops
 * of its own — the stable identity block re-renders from the new state next turn.
 */
const IdentitySetCommand: CommandManifest = {
  name: 'set',
  description: 'Set the agent identity (role / persona / instructions). User/UI only.',
  args_schema: {
    type: 'object',
    properties: {
      role: { type: 'string' },
      persona: { type: 'string' },
      instructions: { type: 'string' },
    },
  },
  capabilities: [{ name: 'block:write' }],
  // The "who, not what" gate: only the user/UI may change identity (anti-jailbreak).
  allowed_invokers: ['user'],
  async invoke(
    args: unknown,
    ctx: AppContext,
    _invoker: InvokerContext,
  ): Promise<CommandResult> {
    const patch = readIdentityPatch(args);
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: 'agent_identity.set: no valid field (role/persona/instructions) provided' };
    }
    // set_state re-validates against IDENTITY_STATE_SCHEMA (INV #14); a bad patch
    // throws AppStateViolation, which AppRegistry.route surfaces as ok:false.
    ctx.set_state((s) => ({ ...(s as IdentityState), ...patch }));
    return { ok: true, data: { updated: Object.keys(patch) } };
  },
};

// ============================================================================
// AppManifest
// ============================================================================

/**
 * Build the `agent_identity` manifest. `initial_state` is the host's identity
 * config (defaults to a safe schema-valid identity); the App carries one stable
 * builder and one user-only `set` command. Install it via `AppRegistry.install`.
 */
export function makeAgentIdentityApp(
  initial_state: IdentityState = DEFAULT_IDENTITY,
): AppManifest {
  // Returned as AppManifest<unknown> (the type AppRegistry.install consumes): the
  // builder reads its typed state via `app_ctx` at render time, so the factories
  // never close over IdentityState and the manifest stays assignable.
  return {
    id: 'agent_identity',
    version: '1.0.0',
    depends_on: [],
    tree_namespace: '/identity',
    initial_state,
    state_schema: IDENTITY_STATE_SCHEMA,
    // The builder reads its state at render time via app_ctx, so the factory does
    // not close over the install-time snapshot — it returns the shared manifest.
    builders: [() => IdentityBlockBuilder],
    // One command: the user-only `set` (the agent is denied at the invoker gate).
    commands: [() => IdentitySetCommand],
  };
}
