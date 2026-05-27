# block-agent v3.0 — Implementation Architecture

> Paths note (2026-05-27 workspaces move): this file now lives at
> `packages/core/src/ARCHITECTURE.md`. All `ai_com/…` references below are
> **repo-root-relative** (i.e. `../../../ai_com/…` from this file); the core source
> files it describes (`core/`, `app/`, `apps/`, `provider/`, `runtime/`) are this
> file's siblings under `packages/core/src/`, and the `../core/types.js`-style import
> examples remain correct as intra-package relative imports.

> Scope: **v3.0 core loop only**. Authoritative design lives in
> `ai_com/block-agent-architecture-v3.1.md` (read §3, §4, §5, §5b, §7, §8, §9,
> §10, §11, §16) and the implementation-level diagrams in
> `ai_com/block-agent-v3.1-impl.md`. This file is the contract-and-ownership map
> the four implementers work against. The architect owns the contract files; this
> doc tells everyone else where their code goes and which invariants they must hold.

## What v3.0 builds (and what it does NOT)

We build the **App FRAMEWORK** plus the core loop that runs it:

- `core/` — Block tree + Operations (the one mutation door) + PolicyEngine + Renderer
- `app/` — the App framework: AppRegistry + BuilderRegistry + CommandRegistry + types
- `provider/` — ModelProvider abstraction + Mock/Thinking/Anthropic/OpenAI-compat
- `runtime/` — AgentRuntime state machine + `index.ts` demo boot

We do **NOT** implement any predefined standard app. `src/apps/` stays empty
(do not create it). No `agent_identity` / `thoughts` / `messages` / `tools`.
The loop is proven end-to-end with a **one-off fixture app written in `test/`**,
clearly labeled as a test stub, not a standard app. The user will later say which
standard apps to build.

> Note: `ai_com/block-agent-v3.1-impl.md` (p.1) lists 4 standard apps under
> `apps/`. The team-lead's scope **overrides** that: framework only, no standard
> apps in v3.0. Fixture apps live in `test/`.

## Tech stack

- Node 24 + TypeScript **strict** + **ESM** (`"type":"module"`)
- Module system: **NodeNext** (`moduleResolution: NodeNext`); intra-repo imports
  use explicit `.js` extensions (NodeNext requirement), e.g.
  `import type { Block } from '../core/types.js'`.
- `verbatimModuleSyntax: true` → type-only imports MUST use `import type`.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are ON — be deliberate
  about optional fields and array indexing.
- Run: `tsx` · Test: `vitest` · Typecheck: `tsc --noEmit` · Package mgr: `npm`
- Scripts: `npm run typecheck` · `npm test` · `npm run dev`

## Module dependency graph (text)

```
                          ┌────────────────────┐
                          │   runtime/          │
                          │   agent_runtime.ts  │
                          │   index.ts (boot)   │
                          └─────────┬──────────┘
              uses Operations / Renderer / ModelProvider
            ┌───────────────┬───────────────┬──────────────┐
            ▼               ▼               ▼              ▼
   ┌──────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐
   │ core/        │  │ core/      │  │ provider/  │  │ app/         │
   │ operations.ts│  │ renderer.ts│  │ mock.ts    │  │ registry.ts  │
   │  has Policy  │  │            │  │ anthropic  │  │ (AppRegistry │
   │  Engine,     │  │            │  │ openai_cmp │  │  +Builder    │
   │  BlockTree   │  │            │  │ thinking   │  │  Registry    │
   └──────┬───────┘  └─────┬──────┘  └─────┬──────┘  │  +Command    │
          │                │               │         │  Registry)   │
          ▼                ▼               ▼         └──────┬───────┘
   ┌─────────────────────────────────────────────┐         │
   │  CONTRACT FILES (architect-owned, type-only) │◄────────┘
   │  core/types.ts · app/types.ts · provider/types.ts
   └─────────────────────────────────────────────┘
```

### Dependency rules (enforced by review + topology)

1. **core/ never imports a concrete app, nor `app/registry.ts`.** core depends only
   on the **interfaces** in `app/types.ts` (`CommandRegistry`, `BuilderRegistry`,
   `AppContext`, `CommandManifest`). This is the seam that breaks the core↔app cycle.
2. **Operations routes commands via the `CommandRegistry` interface**, implemented
   by AppRegistry. Operations calls `PolicyEngine.check` BEFORE
   `CommandRegistry.route`. Renderer reads `cache_tier` via the `BuilderRegistry`
   interface, also implemented by AppRegistry.
3. **Contract files are import-only for implementers.** If a contract needs to
   change, the architect changes it and broadcasts; implementers do not edit
   `*/types.ts`.
4. **Imports point down/inward**: `runtime → {core, provider, app} → contracts`.
   Nothing imports `runtime`. provider does not import app or core impls (only
   `core/types.ts` for `RenderedPrompt`).
5. **Intra-repo imports carry `.js` extensions** (NodeNext). Type-only imports use
   `import type`.

## Contract summary (architect-owned; DO NOT EDIT — import only)

### `src/core/types.ts`
- `Block` (passive data: text|blob + ordered children; NO metadata fields, INV #2)
- `BlockName = \`${string}:${string}\`` (namespaced, INV #15) · `BlockNamePattern` · `BlockRef` · `Blob` (supports `blob://<sha256>` handle)
- **reserved `runtime:` namespace** (consts, import as values not types): `RUNTIME_APP_ID='runtime'` · `BLOCK_COMMANDS_ONLY_FEEDBACK='runtime:commands_only_feedback'`. The one owner-less system block the runtime writes (§4.2) is well-formed (INV #15) + single-owned (INV #3) under `runtime`. **There is NO `runtime:thoughts_sink`** — thinking is emitted on a UI channel, never written to the tree (see "thinking-channel" below). See "System-block ownership" below.
- **`ThinkingEvent`** (interface) — one promoted block of LLM reasoning emitted on the runtime's UI thinking channel; `{ text, spawn_depth }`. The runtime EMITS these and does nothing else with thinking (never tree, never prompt).
- `CacheTier = 'stable'|'slow_changing'|'volatile'`
- `BlockSnapshot` (frozen COW capture; byte-identical source, INV #1) · `BlockView` (trusted zero-copy view, INV #18)
- `BlockOp` (discriminated union: create|update|delete|move|append; delete has `physical?` for INV #5)
- `InvokerContext` · `OperationCall` · `PolicyDecision` (allow|deny|pending)
- `RenderedPrompt` (+ `ContentPart`) · `AgentState` · `WakeEvent`
- branded types: `ValidatedBlock` / `PublicBlock` / `PrivateBlock` / `PinnedBlock`
- **ACTOR INTERFACES (wave 2 — concrete classes `implements` these):**
  - `BlockTree` — `applyOp` / `applyOps` / `get` / `snapshot()→BlockSnapshot` / `view`. Ctor: `new BlockTree()` (EMPTY start; optional `(initialRoot?)` for sub-agent subtrees).
  - `PolicyEngine` — `check(call, ctx)→PolicyDecision`, O(1) no-IO (INV #19). Ctor: `new PolicyEngine(policyTable?)` (defaults to §9.4 table).
  - `Operations` — `invoke_command(full_name, args, invoker_ctx)→Promise<CommandResult>` · `apply(ops, invoker_ctx)→Promise<PolicyDecision>` (owner-less system writes: commands-only feedback + thoughts sink, STILL policy-checked, no bypass) · `has(name)→boolean` · `snapshot()`. Ctor: `new Operations(tree, policy, commands)`. (The concrete class also exposes policy-aware low-level primitives `find`/`read`/`view`/`create`/`update`/`delete`/`move` under reserved `core.*` command names — impl-internal/test surface, deliberately not in this cross-module contract.)
  - `Renderer` — `render(snapshot)→Promise<RenderedPrompt>` (byte-identical, INV #1). Ctor: `new Renderer(builders: BuilderRegistry)` — registry injected ONCE at construction, NOT per render.
  - core→app dependency here is **type-only** (CommandRegistry/BuilderRegistry/CommandResult interfaces); does NOT violate "core never imports app/registry.ts".

### `src/app/types.ts`
- `AppManifest` (id, depends_on, tree_namespace, initial_state, **state_schema** INV #14, builders, commands, lifecycle hooks)
- `AppContext` (state + `set_state` Proxy-validated; `list_*`; three cross-App channels `invoke_command`/`read`/`on`+`emit`; `spawn_system_agent`)
- `Builder` / `BuilderManifest` (owner is `system|plugin|tool` — **'agent' illegal**, INV #4; cache_tier + `cache_tier_pinned`; `latency_p95_ms`; `build(ctx, app_ctx?)`) · `BuildContext` (deterministic substitutes, INV #16)
- `CommandManifest` (name, description, capabilities, **`allowed_invokers?`** invoker-allowlist gate, `invoke(args, ctx, invoker)`) · `CommandResult` (ops + data + error)
- `AppContext.wake?(event)` — messages-wake seam (§8.2); `AppContext` also carries the three cross-App channels + `spawn_system_agent`
- **`CommandRegistry` interface** (`resolve_command` + `route`) — the core↔app decoupling seam
- `BuilderRegistry` interface (`resolve_builder` + `tier_of` + `list_builders`)
- `AppRegistry` interface (`install`/`uninstall`/`list`/`get`) · `InstallResult`
- **Registry method names are distinct across all three** (`resolve_command` / `resolve_builder` / `list` vs `list_builders`) so ONE class (`AppRegistry` impl) `implements AppRegistry, CommandRegistry, BuilderRegistry` directly — NO adapter accessors. Pass it typed as `CommandRegistry` to Operations, as `BuilderRegistry` to Renderer.
- `Capability` · `JsonSchema` · `TokenBudget` · `AppEvent` · `SystemAgentHandle`

### `src/provider/types.ts`
- `ModelProvider` (id, capabilities, `send` → `AsyncIterable<ProviderChunk>`, `estimateTokens`, `cache_hint`, `thinking_adapter`)
- `ModelCapabilities` (vision/audio, cache_control, tool_dispatch, thinking_format)
- `ThinkingAdapter` (`extract` → `{thoughts, tool_calls, raw_text}` — INV #13: thoughts/raw_text are NEVER commands; only `tool_calls` are)
- `ProviderResponse` · `ProviderChunk` · `ToolCall` · `SendOpts` · `CacheHint`
- **CONCRETE CLASSES (impl-provider, all done + typecheck-clean):**
  - `MockProvider` — Ctor: `new MockProvider(script: MockTurn[], opts?: MockProviderOpts)`. `MockTurn = {thinking?: string[], tool_calls?: ToolCall[], text?: string, usage?}` emitted thinking*→tool_call*→text?→usage?→done. `done` carries the assembled ProviderResponse (default Anthropic content[] shape). Defaults: id `mock`, AnthropicThinkingAdapter, chars_per_token 4, max_breakpoints 4. Exposes `turns_consumed` / `last_prompt` / `last_opts` for assertions. **`send()` throws past script length** (anti-runaway-loop guard). (use this in `index.ts` + tests)
  - `AnthropicProvider` / `OpenAiCompatibleProvider` — real backends (fetch + SSE, no SDK). Not needed for the deterministic demo/tests.
  - Convention notes (blessed): `CacheHint.max_breakpoints=0` means "implicit/prefix caching, no explicit breakpoints" (OpenAI-compat, §11.3). Assembled response arrives in the `done` chunk → runtime accumulates chunks, then `provider.thinking_adapter.extract(doneChunk.response)`.

## Task split & file ownership (for the 4 implementers)

Each implementer **owns** these files (writes the classes; imports the contracts).
No two implementers edit the same file. Contracts are off-limits.

### impl-core
- `src/core/block.ts` — `BlockTree` class: holds root Block, `applyOp(BlockOp)`,
  `snapshot()` → frozen `BlockSnapshot` (COW), `view(name)` → `BlockView`, name
  helpers (split/validate `<app>:<name>`). Single-writer + atomic swap (§8.5).
- `src/core/operations.ts` — `Operations`: the ONLY mutation entry. `invoke_command`
  resolves the command via `CommandRegistry`, calls `PolicyEngine.check` (no bypass,
  §9.1), then `CommandRegistry.route`, then applies returned `BlockOp`s to the
  `BlockTree`. Also `find`/`read`/`create`/`update`/`delete`/`move` primitives.
- `src/core/policy.ts` — `PolicyEngine` impl + the default per-invoker policy table
  (§9.4). `check(call, ctx)` → allow|deny|pending; O(1) in-memory (INV #19).

### impl-render
- `src/core/renderer.ts` — `Renderer`: read a `BlockSnapshot`, look up each block's
  `cache_tier` via `BuilderRegistry`, segment into 3 tiers, run owner builders,
  produce a **byte-identical** `RenderedPrompt` (INV #1). U-shape ordering (§10).
- `src/app/registry.ts` — `AppRegistry` class that ALSO implements `BuilderRegistry`
  + `CommandRegistry`. Install/uninstall, topo-sort by `depends_on`, namespace
  collision auto-rename (§5.3), bootstrap, name→owner O(1) resolution (§3.1).

### impl-provider
- `src/provider/mock.ts` — `MockProvider`: scripted, deterministic output to drive
  the loop in tests (emit canned tool_calls / thinking / text per turn).
- `src/provider/thinking.ts` — the 3 `ThinkingAdapter`s (Anthropic blocks / OpenAI
  reasoning / XML tag). Enforce INV #13 at the seam: thoughts ≠ commands.
- `src/provider/anthropic.ts` — `AnthropicProvider`.
- `src/provider/openai_compat.ts` — `OpenAiCompatibleProvider` (DeepSeek/Ollama/vLLM
  via `{base_url, model, api_key?, thinking_format}`).

### impl-runtime
- `src/runtime/agent_runtime.ts` — `AgentRuntime`: state machine (idle ⇄ running ⇄
  waiting_external ⇄ paused_for_approval), `on_wake(WakeEvent)`, commands-only main
  loop (§4.2: tool_use→invoke_command; **thinking→emit on the UI channel, opaque**;
  raw_text→reject+feedback block), `spawn_depth`. Exposes `onThinking(cb)→unsubscribe`
  (the UI thinking channel).
- `src/index.ts` — demo boot: build empty tree → install a fixture app → feed a
  message → run 1 turn with `MockProvider` → print the `RenderedPrompt` + result.
- `test/*.test.ts` — vitest: (a) commands-only rejects plain text;
  (b) byte-identical rendering; (c) invoke_command + policy allow/deny;
  (d) app install. Fixture apps live HERE, labeled as test stubs.

## thinking-channel (decision 2026-05-26 — user-ratified)

Promoted LLM thinking is **emitted to a UI-only channel and never enters the agent
context.** The runtime exposes `AgentRuntime.onThinking(cb)→unsubscribe`; for each
block of reasoning the ThinkingAdapter extracts, the runtime emits a
`ThinkingEvent { text, spawn_depth }` to every subscriber. That is the ONLY thing
it does with thinking:

- **never written to the BlockTree** (there is no `runtime:thoughts_sink`),
- **never rendered into the next prompt** (so it does not survive into context),
- **never parsed for commands** (INV #13 — commands come ONLY from `tool_calls`).

This replaces the prior `ThoughtsSink` + `runtime:thoughts_sink` design: the
`ThoughtsSink` interface, the `thoughts_sink` option, `last_unsunk_thoughts`, and
the `BLOCK_THOUGHTS_SINK` const are all **deleted**. A faulty listener is isolated
(try/catch) so the UI never breaks the turn loop. `commands_only_feedback` is
**kept** — it is the agent's self-correction signal and MUST stay in context.

> Rationale: thinking is the model's private scratchpad; persisting it into context
> bloats the prompt, leaks reasoning across turns, and risks treating reasoning as
> durable state. A UI subscription gives observability without any of that.

## System-block ownership (the `runtime:` namespace)

The runtime writes ONE block no App owns (§4.2): the commands-only rejection
feedback. It STILL satisfies INV #15 (`<app_id>:<name>`) and INV #3 (single owner)
by living under a reserved `runtime` app-id:

- `runtime:commands_only_feedback` — the next-turn feedback when agent output
  fails commands-only validation.

Ownership: the **runtime registers ONE built-in system builder** (`owner:'system'`,
`app_id:'runtime'`) that owns the whole `runtime:*` namespace and declares
`cache_tier:'volatile'` (the block changes most turns → render at the tail). The
runtime writes it via `Operations.apply(ops, {invoker:'app'})`, which still passes
PolicyEngine (no bypass, §9.1). The name is an exported CONST in `core/types.ts` so
all implementers reference the same string — no drift.

- **impl-runtime**: register the `runtime:*` system builder at boot (before
  installing any fixture app); write feedback via `Operations.apply` using the
  `BLOCK_COMMANDS_ONLY_FEEDBACK` const. Do NOT invent ad-hoc names.
- **impl-render**: the registry must accept this builder like any other
  (`owner:'system'`, namespace `runtime`); `resolve_builder('runtime:...')` and
  `tier_of` resolve to it; no special-casing.
- **`runtime` is a reserved app-id**: AppRegistry should refuse to install a
  third-party App with `id:'runtime'` (collision with the reserved namespace).

### Reserved app-ids: `runtime` and `core`

Two app-ids are reserved; **AppRegistry.install must refuse a third-party App
using either** (deny with a clear error):

- **`runtime`** — the system-block namespace above (`runtime:commands_only_feedback`).
- **`core`** — Operations' low-level primitives run PolicyEngine under reserved
  command full-names `core.find` / `core.read` / `core.create` / `core.update` /
  `core.delete` / `core.move` (so the chokepoint covers primitive tree access too,
  §9.1). Command names use a DOT (`core.find`); block names use a COLON — different
  namespaces, no clash — but the `core` app-id is reserved so no App can shadow
  these primitive command names.

### messages-wake seam (AppContext.wake → AgentRuntime, §8.2) — LOCKED

How an App moves the runtime out of idle after it has durably recorded the
triggering fact (e.g. the messages App appends `inbox.jsonl`, then wakes).

- **Contract:** `AppContext.wake?(event: WakeEvent): void` (added to
  `src/app/types.ts`). Optional + fire-and-forget: it returns immediately, carries
  NO tree mutation (a scheduling signal, not a command → NOT routed through
  PolicyEngine), and an App MUST tolerate it being inert (guard `ctx.wake?.(...)`).
- **Wiring (late-injection, same pattern as `commandRouter`/`blockReader`):** the
  registry exposes a setter `wakeHook?: (event: WakeEvent) => void`; `AppContext.wake`
  forwards to it. The runtime sets it at boot:
  `registry.wakeHook = (e) => void runtime.on_wake(e);` (see `index.ts`). Until set,
  `ctx.wake` is a no-op (installing an App with no running runtime never throws).
- **Re-entrancy:** `on_wake` already guards against a second concurrent loop — a
  wake that arrives mid-`running` is ignored; the in-flight loop sees tree changes
  on its next turn. So an App may wake freely; it never spawns a parallel loop.
- **For impl-messages:** after appending to `inbox.jsonl`, call
  `ctx.wake({ kind: 'sync_message_arrived' | 'async_message_arrived', msg_id })`.
  This is your only dependency on the runtime — no direct import of AgentRuntime.

### live-AppContext projection seam (Renderer ↔ AppRegistry) — LOCKED 2026-05-26

State-driven render-builders (`messages:summary` / `messages:recent` / `tools:recent`)
project from `app_ctx.state`. The Renderer must read the SAME live AppContext the
App's commands mutate, or it renders stale/empty after a `set_state`. The gap: the
Renderer only had a STATIC `RendererOptions.app_contexts` Map (captured at
construction → goes stale as Apps install/mutate), and `AppRegistry` did not expose
its live contexts at all.

- **`AppRegistry.get_app_context(app_id): AppContext | null`** — returns the LIVE
  context instance (the same one handed to commands/hooks; `ctx.state` is a
  read-through getter over the App's mutable cell, so it always reflects the latest
  committed state). Builders only READ it (INV #16).
- **`RendererOptions.app_context_provider?: (app_id) => AppContext | null`** — a
  LIVE lookup resolved at EACH render (preferred over the static `app_contexts` Map,
  which tests still use). `appContextFor` tries the Map first, then the provider.
- **Boot wiring (`index.ts`):** `new Renderer(registry, { app_context_provider: (id)
  => registry.get_app_context(id) })`.
- Additive only — no `*/types.ts` contract change (`RendererOptions` is impl-render's
  own type; the accessor is a new public method on AppRegistry).
- **ACCEPTANCE GATE — `test/projection_e2e.test.ts`** (lead-mandated): proves the seam
  on the REAL Renderer+Registry path (NOT injected app_ctx) for all three projections —
  `messages:recent` after `ingest`, `tools:recent` after `tools.read_file` via
  Operations, `agent_identity:identity` after `agent_identity.set` via Operations —
  plus a NEGATIVE guard (no seam wired ⇒ body absent) so the test can't false-pass.
  This is the standing regression guard for the "green unit tests but broken real loop"
  class. Apps that need a temp dir construct `new MessagesApp({dir})` / `new ToolsApp(dir)`
  so the suite never writes the repo's real `.block-agent`.

## Standard-app implementer split (wave-2 apps; `src/apps/`)

Three built-in apps now live under `src/apps/` (the dir exists). Each implementer
**owns exactly one file**, imports the contracts only (`app/types.ts`,
`core/types.ts`), and registers via `AppManifest` → `AppRegistry.install`.
**No `thoughts` app** — thinking is the UI channel above (DR-27). Spec source:
`ai_com/block-agent-architecture-v3.1.md` §6.1 / §6.3 / §6.7.

### impl-identity → `src/apps/agent_identity.ts` (§6.1)
- **id** `agent_identity` · **tree_namespace** `/identity` · **depends_on** `[]`.
- **state** `{ role: string; persona: string; instructions: string }` (+ `state_schema`
  declaring those three required string keys, INV #14). Initial values come from the
  manifest's `initial_state` (host/operator config; demo/tests pass them in).
- **command `agent_identity.set({ role?, persona?, instructions? })`** — partial update.
  Declares **`allowed_invokers: ['user']`** + `capabilities: [{name:'block:write'}]`.
  PolicyEngine DENIES invoker `agent` and `app` on the invoker gate (BEFORE the
  capability check), so **the agent can never rewrite its own identity/constraints**
  (anti-jailbreak — this is the security point). On allow (user/UI), the handler calls
  `ctx.set_state(s => ({ ...s, ...provided }))` (schema-validated, INV #14); the next
  render re-runs IdentityBlockBuilder with the new state. `initial_state` is the seed;
  this command is the runtime change path. **Mechanism is generic** (`allowed_invokers`
  on any CommandManifest, resolved by PolicyEngine) — `memory.pin` etc. reuse it.
- **builders** `IdentityBlockBuilder` → output block `agent_identity:identity`
  (house-style block name uses the app-id prefix; the §6.1 path `/identity/agent_identity`
  maps to this name). **cache_tier `stable`** (renders FIRST, in the U-shape head).
  `build` reads `app_ctx.state` and emits the role/persona/instructions text;
  deterministic (no clock/random, INV #16).
  - **command-list filtering:** if/when an IdentityBlockBuilder (or any builder)
    renders an "available commands" section, FILTER OUT commands the current invoker
    may not run, i.e. skip a command whose `allowed_invokers` is set and does not
    include `'agent'`. The agent must not see `agent_identity.set` (avoids it calling a
    command that will only be denied). v3.0 has no shared command-list builder yet;
    apply this rule wherever you list commands.
- Goal: pin agent identity + operating constraints at the front of the stable
  segment so every turn's cache prefix carries it.

### Shared mechanism — BlockApp config (file seed + user-only config commands) — LOCKED 2026-05-26

Reusable across `messages` / `tools` (and future apps). Helper:
`src/apps/_app_config.ts` (architect-owned, NOT a contract change).

- **File seed** — `readAppConfig(app_id, defaults)` reads
  `.block-agent/apps/<id>/config.json` and merges present keys OVER the App's compiled
  defaults (shallow, type-checked per key; unknown / wrong-typed keys dropped). Missing
  file / bad JSON → defaults (NEVER throws at boot). The merged config is stored INTO App
  state, so it is schema-validated (INV #14) and projected deterministically by builders.
  Read ONCE at construction/install (off the hot path), so a sync file read is fine.
- **Runtime config commands** — an App MAY expose a `set_config` command to retune at
  runtime; it MUST declare **`allowed_invokers: ['user']`** (the reusable PolicyEngine
  "who, not what" gate, same as `agent_identity.set`) so the AGENT can never change its
  own token budget / thresholds / display counts (anti-self-modification). Handler
  validates + clamps, then commits via `ctx.set_state`.
- Both apps store config INSIDE their App state (bounded JSON → INV #14-legal) and
  declare it in `state_schema`.

### impl-messages → `src/apps/messages.ts` (§6.3, §8.2) — REWRITE: conversation-history manager

Full rewrite (supersedes counts-only + the cancelled bounded-pending patch). messages
becomes a conversation-history manager with automatic incremental compaction.

- **id** `messages` · **tree_namespace** `/messages` · **depends_on** `[]`.
- **history (durable):** an ordered message log `{ role: 'user'|'agent'; id; content; ts }`
  — FULL history is durable in jsonl (append-only, §12.2 write rules UNCHANGED: lock-file
  'wx', ≤64KB/line, startup tail-truncate; writes only in command/ingest path, never in build).
- **config (in state; file-seeded + user-only command):**
  `max_history_tokens` · `compression_threshold` (0..1) · `display_count` (recent verbatim
  count). Seed via `readAppConfig('messages', DEFAULTS)`; change via
  `messages.set_config(...)` with `allowed_invokers:['user']`.
- **compaction trigger:** when history tokens ≥ `max_history_tokens × compression_threshold`,
  incrementally FOLD messages OLDER than the most-recent `display_count` into the summary.
  Token estimate: pluggable `estimate_tokens?: (text)=>number` defaulting to **char/4**
  (the app holds no provider in v3.0; a host injects `Provider.estimateTokens` later). The
  TRIGGER LOGIC is the deliverable, not summary quality.
- **summarize seam (placeholder, pluggable):** `summarize(msgs): string` — v3.0 ships a
  DETERMINISTIC placeholder (e.g. `"[N earlier messages folded]"` / naive concatenation or
  truncation), NOT a real LLM. Keep the seam clean + swappable (a real summarizer arrives
  later via `spawn_system_agent` / a runtime hook). Compaction (effectful) updates
  `state.summary`; `build` only renders state.
- **state (bounded projection):** holds the bounded recent messages (≤ `display_count`-ish
  window) + the current `summary` string + the config. JSON-serializable + bounded → INV #14.
- **two projection blocks (cache-tier-aware), REPLACING `messages:inbox`:**
  - `messages:summary` — the compacted older history, **cache_tier `slow_changing`**
    (changes only when compaction runs → mid prompt).
  - `messages:recent` — the most recent `display_count` messages VERBATIM, **cache_tier
    `volatile`** (changes most turns → tail). This is how the agent reads message bodies.
  - Both builders pure/deterministic: read `state` only, never jsonl, never clock (INV #16).
- **commands:** `reply(reply_to?, content)` (append an agent reply to history + outbox jsonl;
  needs `block:write`) · `ingest` (the §8.2 front door — append a user message to history +
  `ctx.wake?.(...)`; NOT a ChannelAdapter, direct method/command for demo/tests) ·
  `set_config(...)` (`allowed_invokers:['user']`) · peek/ack adapted to the history model
  (your call on exact shape; keep what's useful, drop counts-only semantics).
- **tests:** history accrues; threshold triggers compaction (placeholder summary folds older
  msgs); recent `display_count` kept verbatim; `messages:summary` slow_changing +
  `messages:recent` volatile; config via command (user-only: agent DENIED) + via file seed;
  **agent can read recent message bodies from `messages:recent`**; build byte-identical;
  jsonl stays full (compaction does not shrink the durable log).

### impl-tools → `src/apps/tools.ts` (§6.7) — recent-N projection (replaces per-id prefix-scan)

Keep the 4 tools + capability gating; CHANGE only the result projection.

- **id** `tools` · **tree_namespace** `/tools` · **depends_on** `[]`.
- **history (durable):** each tool call (request + result) is recorded in full to a durable
  jsonl/store (append-only). The full log is the store; the projection is a bounded window.
- **config (in state; file-seeded + user-only command):** `tool_history_count` (recent N to
  project). Seed via `readAppConfig('tools', DEFAULTS)`; change via `tools.set_config(...)`
  with `allowed_invokers:['user']`.
- **state:** `{ enabled: string[]; tool_history_count: number; recent: Array<{...request+result}> }`
  — `enabled` (array not Set, INV #14), config, and a BOUNDED recent-calls window. All
  JSON + bounded → INV #14. `state_schema` declares them.
- **commands:** the meta-app — each tool (`read_file` / `grep` / `bash` / `http_request`) is
  a `tools.<tool>` command; **capability gating UNCHANGED** (`bash`→`op:dangerous`→agent
  pending; `http_request`→`net:http`; all `block:write`; `enabled[]` gates independently).
  Plus `tools.set_config(...)` (`allowed_invokers:['user']`). A tool call appends to the
  durable store + updates `state.recent` (drop oldest beyond `tool_history_count`).
- **projection — ONE block `tools:recent` (cache_tier `volatile`), REPLACING per-id
  `tools:tool_result.<id>`:** renders the most recent `tool_history_count` calls
  (request + result). **This dissolves the v3.1 prefix-scan follow-up** (no more dynamic
  per-id block names / owner-index gap). build pure: reads `state.recent` only, no
  clock/random/jsonl. Attach the block to the live root `root:root` if any op-based write
  is needed (no namespace-root auto-creation in v3.0 — see the tools parent fix below).
- **tests:** recent N request+result rendered; over-bound deterministic drop-oldest;
  `tool_history_count` via command (user-only) + file seed; capability gates unchanged
  (bash→pending for agent, etc.); build byte-identical.

> All three: keep `build` deterministic (INV #16); declare every output block's
> owner builder (INV #3); use the app-id as the block-name prefix (INV #15);
> `owner` is `system`/`plugin`/`tool` only (`agent` illegal, INV #4). Run
> `npm run typecheck` + `npm test` before handing back; the architect does the
> final integration pass.

### TEAM CONVENTION — manifest factory return type (the TS2379 fix) — LOCKED

`AppManifest<TState>` is **invariant** in `TState` under `strictFunctionTypes`
(its `commands`/`builders` factories take `TState` in a contravariant position), so
a concrete `AppManifest<MyState>` is NOT assignable to `AppManifest` (=
`AppManifest<unknown>`), which is what `AppRegistry.install` consumes → TS2379.

**Convention (no contract change):** a manifest factory builds its manifest typed
as `AppManifest<MyState>` internally (keep the typed discipline in the
command/builder factories), then **returns it widened to the bare `AppManifest`**:

```ts
export function makeFooApp(): AppManifest {        // return type: bare AppManifest
  const manifest: AppManifest<FooState> = { /* …typed internals… */ };
  return manifest as AppManifest;                  // widen at the boundary
}
```

Soundness: `state_schema` + `initial_state` guarantee the runtime state shape, and
builders/commands re-narrow `ctx.state` to `FooState` at call time — so erasing the
generic at the install boundary loses no runtime guarantee. This is what
`agent_identity.ts` / `tools.ts` / `messages.ts` all do; **impl-messages: same
pattern.** We deliberately do NOT add a generic install helper — the single cast at
the factory's return is the minimal, readable fix.

### Commands-list builder filtering (answer to impl-identity's open Q) — LOCKED

The agent's `RenderedPrompt` is ALWAYS rendered FOR the agent, so a builder that
renders an "available commands" section filters **statically** by the command's
`allowed_invokers`:

```ts
const visibleToAgent = (cmd: CommandManifest): boolean =>
  cmd.allowed_invokers === undefined || cmd.allowed_invokers.includes('agent');
```

This is deterministic (no per-invoker runtime parameter, no clock/random → does NOT
break byte-identical, INV #1). The agent never sees `agent_identity.set` (user-only),
so it never calls a command that would only be denied. The **user's** UI command
panel is a SEPARATE path: the UI reads `CommandRegistry` directly (or
`AppContext.list_commands()`) and does NOT go through the agent's render pipeline.

**v3.0 status:** there is **no shared cross-app commands-list builder yet** —
`AppContext.list_commands()` returns only the owning App's own commands, and
`BuildContext` does not expose a cross-app command catalog. So for v3.0 nobody must
build one; **impl-identity does NOT add a commands-list builder.** IdentityBlockBuilder
keeps emitting only static operating-constraint text (it already does). When a
cross-app commands-list builder IS added (a later milestone), it MUST apply the
`visibleToAgent` filter above; the seam it needs is a read-only command catalog on
`BuildContext` (architect adds it then — flagged so it isn't forgotten).

### Capability-resolution seam (Operations ↔ PolicyEngine)

`OperationCall` is intentionally `{full_name, args}` only — it carries NO
capabilities. PolicyEngine gets a command's declared capabilities via an injected
**`capability_resolver: (full_name) => Capability[]`**, which `Operations` wires to
`registry.resolve_command(fn)?.capabilities` (O(1) map lookup → does NOT break INV
#19's no-IO rule). A host may inject its own PolicyEngine/resolver. This keeps
`OperationCall` minimal and PolicyEngine pure (deps injected, not ambient). No
contract change — it's a constructor-wiring convention.

### Invoker-allowlist gate (`allowed_invokers`) — the "who, not what" seam (2026-05-26)

A command may restrict WHICH invoker roles run it, independent of capabilities.
This is the reusable anti-jailbreak primitive (e.g. `agent_identity.set` is
user-only so the agent cannot rewrite its own identity; `memory.pin` may reuse it).

- **Contract:** `CommandManifest.allowed_invokers?: ('user'|'agent'|'app')[]`
  (added to `app/types.ts`). **Absent ⇒ no restriction** (every invoker allowed —
  prior behavior unchanged). Orthogonal to `capabilities` (which is "what permission
  tokens", this is "which role").
- **Engine:** PolicyEngine gets it via an injected
  **`allowed_invokers_resolver: (full_name) => invokers[] | null`** (parallel to
  `capability_resolver`; `null` = no restriction). It is checked as **precedence
  step 0** in `check()` — BEFORE the denied-capability / structural / approval /
  granted steps — so a forbidden invoker is denied regardless of what it holds.
  O(1) array membership (INV #19 intact). PolicyEngine never imports the manifest.
- **Wiring:** `Operations.with_default_policy` wires the resolver to
  `registry.resolve_command(fn)?.allowed_invokers ?? null`; `index.ts` and
  `test/fixtures.ts` (`TestCommandRegistry.allowedInvokersResolver()`) do the same.
- **UI/list filtering (builders):** when a builder renders an "available commands"
  list for the agent, skip any command whose `allowed_invokers` is set and excludes
  `'agent'` — the agent should not see commands it would only be denied.
- **Verified:** `policy.test.ts` — agent + app denied `demo.set` on the invoker gate
  (deny reason `not permitted`, even though agent holds `block:write`); user allowed.

## Key invariant checklist (everyone holds these — see v3.1.md §16)

- [ ] **commands-only** (INV #9): any agent text that fails commands-only is
      invalid → write an error feedback block for the next turn. (runtime)
- [ ] **thoughts never parsed as commands** (INV #13): promoted thinking text is
      opaque; commands come ONLY from structured tool_calls. (runtime + thinking adapters)
- [ ] **PolicyEngine is unbypassable** (§9.1): `check` is called INSIDE
      `invoke_command`, before routing. No path to the tree skips it. (operations)
- [ ] **byte-identical rendering** (INV #1): same (snapshot, tiers) → identical
      bytes. No `Date.now`/`Math.random`/`crypto.randomUUID`/`process.env` in
      build (INV #16) — use `ctx.deterministic_*`. (renderer + builders)
- [ ] **BlockName namespace** (INV #15): every name is `<app_id>:<name>`; at most
      one owner builder per name (INV #3). (block + registry)
- [ ] **owner='agent' is illegal** (INV #4): reject at runtime too, not just types. (registry)
- [ ] **App state schema** (INV #14): `set_state` Proxy-validates against
      `state_schema`; reject functions/credentials/Block refs → `AppStateViolation`. (registry/app ctx)
- [ ] **delete = archive by default** (INV #5): physical delete needs the capability
      via PolicyEngine. (operations + policy)
- [ ] **set_state does NOT pass PolicyEngine** (INV #10) but agent/user commands DO. (operations vs app ctx)
- [ ] **O(1) policy check & blob deref** (INV #19): no IO/network in `check`. (policy)

## Conventions recap (house style, §0.5)

- Block-world nouns → `Block` prefix; actors → role names (no prefix).
- Extension unit type = `BlockApp`; satellites stay short
  (`AppManifest`/`AppContext`/`AppRegistry`). This is intentional — do not rename.
- Command full name uses a **dot**: `<app_id>.<command>` (e.g. `chat.reply`).
  Block names use a **colon**: `<app_id>:<name>` (e.g. `chat:current_turn`).
  Different namespaces — do not conflate.

## v3.0 Integration Acceptance Record (2026-05-26)

Built by team `blockagent-v30` (architect + impl-core / impl-render / impl-provider
/ impl-runtime). Independently verified green by team-lead.

### ① Modules delivered
- **Contracts (architect-owned, import-only):** `core/types.ts` · `app/types.ts` ·
  `provider/types.ts` — incl. wave-2 actor interfaces `BlockTree`/`PolicyEngine`/
  `Operations`/`Renderer` (concrete classes `implements` them).
- **core/:** `block.ts` (BlockTree + COW snapshot + name-namespace helpers) ·
  `operations.ts` (Operations: single mutation door, PolicyEngine inside
  invoke_command, routes via CommandRegistry) · `policy.ts` (PolicyEngine: §9.4
  per-invoker table, O(1)) · `renderer.ts` (byte-identical tier-segmented Renderer).
- **app/:** `registry.ts` — one class implementing `AppRegistry` +
  `CommandRegistry` + `BuilderRegistry`; bootstrap topo-sort + cycle/missing-dep
  detect + namespace auto-rename; AppContext factory with schema-validated
  set_state.
- **provider/:** `types.ts` · `mock.ts` (MockProvider, deterministic) ·
  `thinking.ts` (3 ThinkingAdapters) · `anthropic.ts` · `openai_compat.ts`.
- **runtime/:** `agent_runtime.ts` (state machine + commands-only turn loop) ·
  `index.ts` (demo boot wiring the real classes).

### ② Verification (all EXIT 0)
- `npm run typecheck` → 0 errors.
- `npm test` → 43/43 pass across 5 files (policy 5 · app_install 4 ·
  byte_identical 4 · render_registry 25 · commands_only 5).
- `npm run dev` → full loop: empty tree → install `echo` fixture app → turn 1
  `echo.say` → writes `echo:last` = "echo: hi" (volatile segment, stable hashes) →
  turn 2 empty → idle.

### ③ Invariants & conventions held
commands-only rejection (#9) · thoughts never parsed as commands (#13) ·
PolicyEngine unbypassable inside invoke_command (§9.1) · byte-identical rendering
(#1) + deterministic BuildContext (#16) · BlockName `<app>:<name>` single-owner
(#15/#3) · `owner='agent'` rejected at runtime (#4) · state_schema Proxy validation
(#14) · delete=archive default, physical via capability (#5) · set_state skips
PolicyEngine while commands don't (#10) · O(1) policy check (#19).
House style intact: Block-prefixed nouns / bare-name actors / short App satellites;
dot for commands, colon for block names.

### ④ Explicitly NOT done (deferred) + extension points
- **No predefined standard app** — `src/apps/` intentionally absent. The only app
  is a one-off `echo` **test fixture** (in `test/` + the `index.ts` demo), clearly a
  stub, not a standard app.
- Deferred to later milestones (§13): PolicyEngine capability/credentials depth +
  memory / search / chat apps (v3.1); tasks / skills / mcp / sub_agents (v3.2); real
  cache-hit metrics (v3.4).
- **To add an app next:** author an `AppManifest` (id, tree_namespace,
  state_schema, builders, commands), install it via `AppRegistry.install`, and
  drive it through the `AppContext` handle. Owner-less system blocks use the
  reserved `runtime:` namespace (`BLOCK_*` consts); `runtime` and `core` are
  reserved app-ids.

### Wiring order & AppRegistry construction (LOCKED)

There is a genuine construction-order cycle: `Operations` needs the registry (as
`CommandRegistry`), but the registry's cross-App channels (`AppContext.list_blocks`
/ `read` / `invoke_command`) need to read the tree and re-enter PolicyEngine — i.e.
they need Operations/the tree. Requiring the tree at AppRegistry construction would
make it impossible to build either first.

**Decision (locked): late-injection.** `new AppRegistry(opts?)` is effectively
parameterless (`opts?: { configs? }`); the tree/Operations are injected AFTER both
exist, via optional setter seams on the instance: `commandRouter` (routes cross-App
`invoke_command` THROUGH Operations so PolicyEngine re-applies, INV #11),
`blockReader` (backs `list_blocks`), `blockReadCopies` (backs `read`, returns
copies, INV #22). Until set, `list_blocks`/`read` return `[]` and cross-App
`invoke_command` falls back to direct route — **harmless for v3.0 (framework-only,
no standard apps exercise these channels)**. Canonical boot order (see `index.ts`):

```
tree = new BlockTree()           registry = new AppRegistry()
policy = new PolicyEngine({ capability_resolver })   // or default table
ops  = new Operations(tree, policy, registry)        // registry as CommandRegistry
rend = new Renderer(registry)                         // registry as BuilderRegistry
registry.commandRouter = (fn,a,inv) => ops.invoke_command(fn,a,inv)   // optional
registry.bootstrap(manifests)    // topo-sort + cycle-check + collision-rename
```

> **v3.1 follow-up:** the `blockReader`/`blockReadCopies` seams need a
> namespace/prefix query (all blocks under `<app>:*`), which `BlockTree.get`
> (exact-name) does NOT provide. Before standard apps use `AppContext.list_blocks`/
> `read`, add a prefix-scan to BlockTree (or wire these seams to a snapshot walk).
> Not needed for v3.0; flagged so it isn't forgotten.

## Built-in App phase — Acceptance Record (2026-05-26)

Built by team `blockagent-apps` (architect/integration owner + impl-identity /
impl-messages / impl-tools). Verified green by the architect (independent re-run).

### ① Delivered
- **Three built-in apps** under `src/apps/`:
  - `agent_identity.ts` — block `agent_identity:identity` (stable, pinned);
    command `agent_identity.set` (user-only via `allowed_invokers:['user']`).
  - `messages.ts` — block `messages:inbox` (volatile); commands `peek_inbox` /
    `ack` / `reply`; jsonl store (lock-file 'wx' advisory lock, ≤64KB/line, startup
    tail-truncate); `ingest()` front door → durable append → `set_state` →
    `ctx.wake?.()` (the §8.2 seam).
  - `tools.ts` — meta-app; one command per tool (`tools.read_file` / `grep` /
    `bash` / `http_request`); owns `tools:tool_result.<id>` (volatile, owner `tool`);
    `bash`→`op:dangerous` (agent→pending), `http_request`→`net:http`; `enabled[]`
    gates a tool independent of policy.
- **thinking → UI channel** (DR-27): `AgentRuntime.onThinking` emits `ThinkingEvent`;
  never tree, never prompt. No `thoughts` app, no `runtime:thoughts_sink`.
- **`allowed_invokers` gate** (reusable "who, not what"): `CommandManifest.allowed_invokers?`
  + PolicyEngine `allowed_invokers_resolver` (precedence step 0). Anti-jailbreak.
- **messages-wake seam**: `AppContext.wake?(event)` → `AppRegistry.wakeHook` →
  `AgentRuntime.on_wake`.

### ② Verification (all EXIT 0)
`npm run typecheck` → 0 · `npm test` → **93/93** across 8 files (render_registry 26 ·
agent_identity 16 · messages 17 · tools 13 · policy 8 · commands_only 5 ·
byte_identical 4 · app_install 4) · `npm run dev` → full loop exit 0.

### ③ Integration review findings (architect, focused pass)
- **FIXED — tool_result write targeted a non-existent parent.** `tools.writeResult`
  created `tools:tool_result.<id>` under `parent: 'tools:root'`, but v3.0 has no
  namespace-root auto-creation (`AppRegistry` never touches the tree), so the op threw
  `BlockTreeError('create.parent: no live block named tools:root')` when actually
  applied. The tools test masked it (asserted on the returned op, never applied it).
  Fixed: result blocks now attach to the live root `root:root` (`RESULT_PARENT`), same
  parent the runtime's bookkeeping blocks use. Added an END-TO-END test that applies
  the op through a real `Operations`+`BlockTree` so it can't regress.
- **Consistency CLEAN** across all three apps: house-style names (Block-prefixed
  builders, short App satellites), block names `<app_id>:<name>` (first-colon split),
  `build()` deterministic (state/snapshot only, no clock/random/env), builder owners
  `system`/`tool` (never `agent`, INV #4), `state_schema` present + JSON-only state
  (messages counts-only, tools `enabled` as array not Set).

### ④ Flagged (NOT fixed — design calls, deferred; not v3.0-blocking)
- **messages restart count inflation:** `MessagesStore.pendingCounts()` counts ALL
  inbox jsonl lines, but `ack` does not persist (append-only, no tombstone/compaction).
  After a restart `inbox_pending_*` is re-seeded from total-ever-received, not unacked.
  Fix needs an ack-log / tombstone or an outbox-of-acks scan — a storage design choice.
- **messages stale lock:** `acquireLock` ('wx' lock-file) has no stale-holder reaping —
  a process that crashes holding the lock leaves `*.lock`, and every later append spins
  5s then throws until manual cleanup. A robust fix reaps by lock-file mtime/owner-pid.
- Both are single-process-correct for v3.0 (single writer, no crash-recovery target);
  they bite only multi-process / crash-restart, which v3.0 does not exercise.

### ⑤ Conventions ratified this phase
- **`flock` → portable lock-file** (`openSync(lock,'wx')`): Node has no portable
  `flock(2)` and Windows lacks it; the atomic exclusive lock-file is the blessed
  equivalent (single writer, no line interleaving). v3.1.md §12.2/§8.3 wording relaxed
  to "advisory write lock (POSIX flock / cross-platform lock-file)".
- **Manifest factory TS2379 fix** (LOCKED): build typed `AppManifest<TState>`
  internally, `return manifest as AppManifest` at the boundary. All three apps follow it.

## Memory apps phase — Acceptance Record (2026-05-27)

Built by team `blockagent-memory` (architect: contract + integration · impl-memory ·
impl-letta). Design: `ai_com/block-agent-memory-design.md` (+ `…-memory-impl-split.md`).
Independently verified green by the architect (full re-run).

### ① Delivered
- **Shared contract** (architect, single-writer): `src/apps/memory_store.ts` — the
  passive `MemoryStore` seam (`store`/`load`/`query`/`delete`, NO render/projection
  method — INV #20) + `MemoryRecord`/`MemoryProvenance`(deterministic, no wall-clock,
  INV #21)/`MemoryQuery`(required `limit` = the P3 result-set cap). Plus the **H1
  write-injection scanner** `scanMemoryContent` (1:1 port of Hermes
  `_scan_memory_content`: 10 threat regexes + 10 invisible/bidi code points written as
  explicit `String.fromCodePoint(0x…)` for reviewable ASCII source; default-on, NOT a
  config port) and the shared provenance fence (`fenceRecalledContent` +
  `MEMORY_CONTEXT_OPEN/CLOSE/NOTE`, §4.3). Zero external deps — stays in core.
- **Built-in `memory` app** (impl-memory): `src/apps/memory.ts` — Hermes-style notes +
  user profile, `JsonlMemoryStore` (§12.2 JSONL discipline; soft-delete tombstone folded
  on read, physical-delete file rewrite, INV #5), full-text/substring recall (no vectors,
  DR-21), four projection blocks `memory:pinned`(stable)/`memory:notes`(slow_changing)/
  `memory:user`(slow_changing)/`memory:recalled`(volatile, provenance-fenced). Commands
  remember/recall/pin/unpin/forget/set_config(user-only). 41 tests.
- **`memory_letta` package** (impl-letta): NEW `packages/memory-letta/` — `LettaMemoryStore
  implements MemoryStore` wrapping `@letta-ai/letta-client` (lazy-imported, DR-M4), and the
  `memory_letta` app (`memory_letta:core` slow_changing / `:recalled` volatile; commands
  remember/recall/set_block[read_only refused]/set_config[user-only]). Semantic recall +
  vectors live ENTIRELY in the Letta server (DR-M3 / DR-21). Graceful degrade when the
  server is unreachable (SETUP_NEEDED style). 44 tests (FakeMemoryStore / stub-client).
- **Integration** (architect): `packages/cli` `types.ts`(+`MemoryConfig`/`MemoryLettaConfig`)
  / `config.ts`(+`resolveMemory` enabled-by-default, `resolveMemoryLetta` DISABLED-by-default,
  `LETTA_BASE_URL` via config/env) / `launch.ts`(install both per config; `memory` via
  `seedProjectionBlocks` like tools; `memory_letta` import from `@block-agent/memory-letta`,
  core never imports it). cli `package.json` +`@block-agent/memory-letta` workspace dep;
  memory-letta `package.json` +`exports` map (mirrors core's `./*`→`./src/*` source map).

### ② Verification (all EXIT 0)
- `npm run typecheck` (all 3 workspaces) → 0.
- core **167** · memory-letta **44** · cli **28** (launch.test +1: memory app installed +
  `memory.remember`/`memory.recall` in tool_catalog, `memory.set_config` filtered as user-only).
- **Dependency isolation held**: `npm ls --omit=dev -w @block-agent/core` → closure is core
  only (no Letta); core source has NO `@letta-ai` import (only the string "Letta" in
  `memory_store.ts` doc comments).
- **Headless boot smoke**: `--dry-run` boot with memory on → installed + seeded, 3-segment
  prompt with identity, no crash. `--memory-letta` with an unreachable server → installs +
  boot survives (graceful degrade).

### ③ Key decisions (DR-M1..M6, design §11)
Two apps share ONE narrow `MemoryStore` contract, each its own BlockApp (DR-M1). Built-in
store = JSONL not `node:sqlite` (still experimental + needs `--experimental-sqlite` in Node
24) (DR-M2). RAG/vectors only in Letta → DR-21 core intact (DR-M3). Letta SDK isolated in
its own package (DR-M4). H1 scan + provenance fence default-on, not a config port (DR-M5).
Write commands open to all invokers (gated by capability + H1), only `*.set_config` user-only;
physical delete via `block:delete_physical` capability (DR-M6).

### ④ Flagged for follow-up (NOT v3.1-blocking)
- **`memory.forget` physical-delete gate** (impl-memory): physical delete is gated by a
  handler-internal `invoker==='agent' → deny`, NOT a manifest capability — because declaring
  `block:delete_physical` on `forget` would make PolicyEngine deny ALL forgets (incl. soft).
  Behavior is correct + tested, but it re-implements a policy decision inside the handler
  instead of going through the chokepoint. **Architect adjudication: split into `forget`
  (soft-only) + `forget_physical` (declares `block:delete_physical`)** so PolicyEngine gates
  it at the chokepoint (agent flatly denied per §9.4 table, user/app allowed) — INV #5 / §9.1.
  Small, contained; routed to impl-memory.
- **`memory_letta.remember` seed id uses `Date.now()`+`Math.random()`** (letta_store /
  app line ~277). It is overwritten by the Letta-assigned id (`store()` return) before
  reaching state/prompt, so it does NOT break byte-identical rendering (INV #16 constrains
  `build`, not commands). Still a latent hazard + a spec deviation (design said
  content-addressed id even for the seed). Low severity; recommend swapping to a
  content-addressed seed for hygiene.

### ⑤ Conventions reused
- §12.2 JSONL discipline (append-only / ≤64KB/line / lock-file 'wx' / startup tail-truncate)
  reused verbatim by `JsonlMemoryStore` (own copy, no sibling-app import).
- `LETTA_API_KEY` env-only (the `ANTHROPIC_API_KEY` rule) — never in config/state/file/log.
- New package `exports` map points at `.ts` SOURCE (no build step), mirroring core; tsx +
  NodeNext resolve via the workspace symlink.

## BlockApp lifecycle v1 phase — Acceptance Record (2026-05-27)

Built by team `blockagent-applifecycle` (architect: design + contract + integration ·
impl-core: registry · impl-cli: CLI). Design: `ai_com/block-agent-app-lifecycle-design.md`
(+ `…-app-lifecycle-impl-split.md`, + `…-app-lifecycle.drawio`). User-approved: all 6
recommendations + **v1 includes hot-uninstall** (hot-install stays phase 2). Independently
verified green by the architect (full re-run).

### ① Delivered
- **Contract** (architect, single-writer `app/types.ts`): `on_uninstall` comment narrowed to
  enforce INV #5 — graceful teardown only (flush/close/release), NEVER delete durable data;
  physical delete is the separate capability-gated `/app purge` path. Signature unchanged.
- **core registry** (impl-core, `app/registry.ts`): ① `unseedProjectionBlocks(app_id, has,
  apply)` — inverse of `seedProjectionBlocks`; computes the app's owned output names and
  emits **soft-delete** (`{kind:'delete', target}`, no `physical`) ops through the injected
  `apply` (Operations chokepoint, invoker=app — no bypass, INV #5/#9). Registry still never
  touches the tree (single-writer). Idempotent (`has` skips absent names; unknown app → `[]`).
  ② `ceiling_resolver?(trust: AppTrustLevel) → ReadonlySet<capName>` injected seam — install()
  checks each command/builder capability against the ceiling (O(1) set-membership, INV #19),
  **report-only** in v1 (warning, never reject; v1 resolves all apps as `'trusted'`). Unset ⇒
  skipped (zero regression). 14 new tests.
- **CLI** (impl-cli): `app_catalog.ts` `BUILTIN_APP_CATALOG` (5+1 metadata) · `config.ts`
  `writeAppConfig(path, patch)` minimal JSON patch (preserves all other keys, never writes
  keys) · `commands.ts` `appCommand` (one SlashCommand, invoker=user, sub-dispatch
  info/install/uninstall/swap/purge; install·swap = write-config + restart prompt; uninstall =
  `agent.hotUninstall` + write-config; purge = allow_purge gate + 'yes' confirmation + delete
  local dir) · `context_view.ts` `appsView` two-segment `{installed, available}` · `types.ts`
  `CtxView.apps` two-segment + `AvailableApp` + `HotUninstallResult` + `hotUninstall?`. 30 new tests.
- **Integration** (architect, `cli/launch.ts` + `config.ts` + `types.ts`):
  ① `installEnabledApps(config, registry, base)` — extracted the 5 inline install `if`s into one
  id→manifest factory (boot + future hot-install share ONE mapping). ② **tool_catalog mutable
  reference**: `let currentToolCatalog = buildToolCatalog(registry)` behind the runtime's
  unchanged `() => currentToolCatalog` thunk; rebuilt on hot-uninstall. ③ **HotMutator
  `hotUninstall`**: `awaitTurnsSettled(runtime)` → assert `runtime.state.kind==='idle'` (else
  `{ok:false, reason:'busy'}`) → set `mutating` so the wakeHook PARKS new wakes (queued, not
  dropped, not concurrent) → `unseedProjectionBlocks` (chokepoint soft-delete) → `registry.uninstall`
  (runs on_uninstall) → rebuild `currentToolCatalog` → clear `mutating` + replay parked wakes.
  ④ **typed LaunchedAgent fields** `config_path` / `storage_dir` / `allow_purge` (resolved by
  `loadConfig`, threaded by `launch`) — replaced impl-cli's `_configPath`/`_storageDir`/
  `_allowPurge`/`_config` underscore-cast hacks with proper typed fields (updated appCommand
  + the app_lifecycle test's fake agent to match).

### ② Verification (all EXIT 0)
- `npm run typecheck` (all 3 workspaces) → 0.
- core **181** (+14 app_lifecycle) · cli **58** (+30 app_lifecycle) · memory-letta **44** = 283.
- **Dependency isolation held**: `npm ls --omit=dev -w @block-agent/core` → core-only closure.
- **Headless hot-uninstall smoke** (`--dry-run`, temp storage): boot with tools enabled →
  `agent.hotUninstall('tools')` → ALL 11 assertions PASS: tools dropped from registry,
  `tools:recent` projection block soft-deleted from the tree, tool_catalog drops `tools.*`,
  `appsView` moves tools installed→available, `removed_blocks=['tools:recent']`, runtime stays
  `idle` (no crash).

### ③ Key decisions (DR-L1..L9, design §10; all 6 forks user-ratified)
discovery = config-list authoritative + static catalog + npm whitelist (never auto-scan-then-
install) · install timing = config+restart for the INSTALL side, **hot-uninstall in v1**, hot-
install phase 2 · swap = ordered uninstall+install (config write-back in v1) · uninstall =
archive-not-delete (INV #5), `on_uninstall` graceful-only · purge = separate `/app purge`,
allow_purge-gated + confirmation, deletes the app's local dir · `/app` = invoker=user slash,
never in tool_catalog (agent can't install/uninstall apps).

### ④ Flagged for follow-up (NOT v1-blocking)
- **Hot-install** is deferred to phase 2 (DR-L2): `/app install` and `/app swap` write config +
  prompt restart in v1; the `installEnabledApps` factory is already shared so hot-install can
  reuse it. tool_catalog is already a mutable reference; the safe-window/wake-parking machinery
  is already in place (hot-uninstall uses it) — hot-install mainly needs install-side seeding +
  the id→manifest factory call inside the same window.
- **`memory` catalog summary** says "向量记忆库…语义召回" but built-in memory is full-text/
  substring (no vectors, DR-21). Cosmetic copy fix in `app_catalog.ts` (impl-cli). Low severity.
- **capability ceiling is report-only** + v1 resolves everything as `'trusted'` and the launcher
  does not yet inject a `ceiling_resolver` (seam built, not wired). The `agent_authored` lane
  (reject + tightened ceiling) is the §5b out-of-process sandbox follow-up.
- **`/app purge` of `memory_letta`** deletes only the LOCAL dir; the external Letta server's
  agent/passages are untouched (by design — block-agent has no authority to delete external
  store data). "pinned immune" (§5b.6) is not selective in v1 — purge deletes the whole app dir;
  the warning text states this.
