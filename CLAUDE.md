# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

block-agent is a single-agent runtime where **all of the agent's context is a Block tree**, behavior lives **outside** blocks (in builders), and **commands are the only mutation entry point**. The thesis: iterate an agent by recomposing its context (modular `BlockApp`s), not by rewriting its architecture. There are no privileged "kernel" modules — built-in capabilities and third-party ones use the same shape, the same entry point, the same constraints.

Authoritative design docs live in `ai_com/` (notably `ai_com/block-agent-architecture-v3.1.md`). Source files cite the relevant section (e.g. `§4.2`, `INV #1`) in their header comments — those citations are accurate and worth reading before changing behavior. User-facing docs are in `doc/` and `README.md` (Chinese primary, `README.en.md` English).

## Commands

Node **24+** required. npm workspaces monorepo; run from the repo root.

```bash
npm install                       # install all workspaces
npm start                         # run the interactive CLI (tsx, no build step)
npm start -- --dry-run            # run offline with the scripted mock provider (no key, no network)
npm run typecheck                 # typecheck every workspace (tsc --noEmit per package)
npm run test                      # core test suite only (alias for -w @block-agent/core)

# Per-workspace — packages (core | cli) and apps (app-<id>, e.g. app-messages | app-memory_letta):
npm run test -w @block-agent/core
npm run typecheck -w @block-agent/cli
npm run test -w @block-agent/app-memory_letta
npm run test:watch -w @block-agent/core   # vitest watch

# Run a single test file or filter by name (vitest):
npm run test -w @block-agent/core -- test/policy.test.ts
npm run test -w @block-agent/core -- -t "commands-only"
```

Tests live in each workspace's `test/**/*.test.ts` (vitest, node environment). CI (`.github/workflows/ci.yml`) runs typecheck + test for `core` / `cli` / `app-memory_letta`, an `apps-typecheck` job over all workspaces, plus a **core-closure check**: `@block-agent/core` must have **zero runtime dependencies** (Letta/Ink/React/apps must never enter core's runtime closure — apps are devDeps only). Keep it that way.

There is **no build step for development** — `tsx` runs the TypeScript sources directly, and the package `exports` maps (`./core/*`, `./app/*`, `./apps/*`, etc.) point at `src/`. NodeNext requires `.js` extensions on relative/subpath imports even though the files are `.ts`.

## Workspaces

npm workspaces = `packages/*` + `apps/*`.

- `packages/core` (`@block-agent/core`) — the **pure runtime**: Block tree, Operations + PolicyEngine, Renderer, the App framework, providers, AgentRuntime. **Zero runtime dependencies.** It no longer bundles the BlockApps (they moved to `apps/`); it still exports shared, manifest-less utilities under `@block-agent/core/apps/*` (`_app_config`, `memory_store`). `src/index.ts` is a self-running demo boot (`npm run dev`), not a library entry — no `.` export; import via subpaths like `@block-agent/core/core/block.js`.
- `packages/cli` (`@block-agent/cli`) — interactive Ink/React terminal. A **ChannelAdapter** that submits user input as `invoker: 'user'`. Ink/React isolated here so core stays dependency-free.
- `apps/<id>/` — **every BlockApp is a self-contained workspace** (`@block-agent/app-<id>`), VSCode-`extensions/`-style: own `package.json` (with a `blockAgent` block declaring `trust`/`host`), `tsconfig`, `vitest`, and `src/manifest.ts` exporting the app factory. The 7 apps: `agent_identity`, `messages`, `tools`, `memory`, `task`, `stats`, `memory_letta` (the last carries its own Letta SDK dep, isolated from core). Apps are `cli` runtime deps + `core` **dev**Deps (core's integration tests import them; core's *runtime* closure stays empty). Imported as `@block-agent/app-<id>/manifest.js`.

This `apps/` layout is the **unified-host model (UH-1)**: one BlockApp shape, with in-process vs cross-process as config (`trust`/`host` on the manifest, resolved by `app/host.ts` `resolveHost`). Only `in-process` is wired today; the cross-process carrier + sandboxed apps are UH-2. Design: `ai_com/design/blockapp-unified-host-architecture.md` (gitignored, local-only).

## Architecture: the big picture

The data flow each turn is a closed loop. Understanding these five actors and the three invariants below explains most of the codebase.

```
WakeEvent → AgentRuntime → Renderer(snapshot) → Provider(LLM) → tool_calls
              → Operations.invoke_command → PolicyEngine.check → AppRegistry.route
              → App command → ops/set_state → BlockTree → (next snapshot)
```

1. **BlockTree** (`core/block.ts`) — the one mutable data structure. A `Block` is passive data: `content_text | content_blob` + ordered `children`, addressed by a namespaced `BlockName` of the form `<app_id>:<name>` (colon). The block has **no** `type`/`metadata`/`owner`/`cache_tier` fields (INV #2) — all of that is keyed by name in the registries.
2. **Operations** (`core/operations.ts`) — THE single mutation chokepoint. `invoke_command` runs `PolicyEngine.check` first, then routes to the owning App, then applies the returned `ops`. `invoke_query` is the read-only twin (drops ops) used by consume-refresh. Even the runtime's own bookkeeping writes go through `Operations.apply({invoker:'app'})` — no bypass.
3. **PolicyEngine** (`core/policy.ts`) — the unbypassable, O(1), no-IO security check inside Operations. Keys strictness off `InvokerContext.invoker` (`user` > `agent` > `app`). It reads each command's `capabilities` and `allowed_invokers` via injected resolvers, so it stays decoupled from the manifest.
4. **Renderer** (`core/renderer.ts`) — flattens a frozen `BlockSnapshot` into a `RenderedPrompt`, segmented by `cache_tier` (`stable` → `slow_changing` → `volatile`, stable first for prompt-cache hits). Rendering MUST be **byte-identical** for the same snapshot (INV #1).
5. **AgentRuntime** (`runtime/agent_runtime.ts`) — the heartbeat. Idle (zero tokens) until a `WakeEvent`; then loops render→send→extract→process until a turn produces no commands and no new event. Stops when a command sets `end_turn` (e.g. `messages.reply`).

### BlockApp — the unit of capability

Everything the agent can do is a `BlockApp` (manifest type in `app/types.ts`; each app a workspace under `apps/<id>/`). An app declares: **state + state_schema** (bounded, pure JSON — big data goes to disk, not state), **builders** (render state → a block; pure & deterministic), **commands** (the only way to mutate), **contracts** (`provides`/`consumes`), and (UH-1) optional **`trust`/`host`**. The canonical minimal example is `apps/agent_identity/src/manifest.ts`; richer ones are `apps/messages`, `apps/tools`, `apps/memory`, `apps/task`. Authoring guides: `doc/blockapp-development.md` (trusted apps) + `doc/blockapp-sandboxed-development.md` (sandboxed apps).

- **Commands** are shared by all invokers — there is no separate agent channel. Per-invoker differences are decided by PolicyEngine, not by `if (invoker)` in the command. `allowed_invokers: ['user']` is how the agent is barred from rewriting things (e.g. `agent_identity.set`, every `*.set_config`) — this is the anti-jailbreak gate. `capabilities` is orthogonal ("what permission token", e.g. `block:write`, `block:delete_physical`).
- **Builders** must be pure and deterministic: `Date.now`/`Math.random`/`crypto.randomUUID`/`process.env`/`new Date` are **forbidden** inside `build` — use the `BuildContext` substitutes (`deterministic_clock`, `deterministic_random(seed)`, `content_addressed_id`, `ctx.config`). `owner: 'agent'` is illegal — render builders must be trusted code (INV #4).
- **Contracts** (`app/contracts.ts`) decouple apps by *type*, not identity. A provider declares `provides: [{contract, via}]` (a `readonly` command returning the contract's `output_schema`); a consumer declares `consumes: [{contract, as}]` and the merged provider outputs land in `state[as]`. The runtime's **consume-refresh** pass (in `agent_runtime.ts`, before each snapshot) pulls providers via `invoke_query`, validates, `combine`s (`sum`/`list`/`first`), and folds into consumer state — so swapping a provider needs zero consumer changes. Do **not** use `depends_on` to express a data dependency (it's deprecated for that; it couples on app-id). Example: `stats` consumes `message_count` + `task_count`; `messages`/`task` provide them, none names the other.

### Built-in apps

`agent_identity` (agent's identity/constraints; agent can't rewrite it) · `messages` (history + compression) · `tools` · `memory` (local) · `memory_letta` (external semantic, same interface, swappable, default-disabled) · `task` (provides `task_count`) · `stats` (pure consumer, default-disabled).

### Core invariants (don't break these)

- **INV #1 — byte-identical rendering.** Same snapshot → same bytes. This is why builders are pure, snapshots are frozen copy-on-write, and the registry/tree are never mutated mid-render (the CLI's hot-uninstall parks wakes during the mutation window to honor this).
- **Commands-only (INV #9/#13).** Agent output that isn't a structured tool_call is rejected; the runtime writes a feedback block the agent sees next turn. Thinking/reasoning text is **opaque** — emitted to a UI-only thinking channel (`onThinking`), never written to the tree, never re-parsed for commands, never fed back into the prompt.
- **Delete = archive (INV #5).** Uninstalling an app or deleting a block archives in place; physical deletion is a separate, capability-gated path (`block:delete_physical`, CLI `/app purge`). `on_uninstall` does graceful teardown only — it must never delete durable data.

## Wiring & config

`packages/cli/src/launch.ts` builds the whole object graph (the generalized form of `core/src/index.ts`) and is the best file to read to see how everything connects: BlockTree → AppRegistry (install enabled apps + register contracts) → PolicyEngine → Operations → Renderer → Provider → AgentRuntime → wake seam → seed projection blocks.

Config precedence (`packages/cli/src/config.ts`): **CLI flags > `block-agent.config.json` > env > compiled defaults**. The **API key is the one exception** — read from env only (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), never from a flag or the config file, never logged. A `.env` at the repo root is auto-loaded. Providers: `anthropic`, `openai-compat` (DeepSeek, Ollama, vLLM, 百炼 — all read `OPENAI_API_KEY` and need a `base_url`), `mock` (`--dry-run`).

In the CLI: plain text = a message to the agent; `/`-prefixed = a command (`/help`, `/apps`, `/app`).

## House style

- Block-world nouns get the `Block` prefix (`Block`, `BlockTree`, `BlockName`, `BlockSnapshot`, `BlockOp`); actors get bare role names (`Operations`, `PolicyEngine`, `Renderer`). The headline extension type is `BlockApp`; its satellites stay short (`AppManifest`, `AppContext`, `AppRegistry` — not `BlockAppContext`). This is intentional; don't "fix" it.
- Block names use a **colon** (`todo:list`); command full-names use a **dot** (`todo.add`). Different namespaces.
- `core` is a reserved app-id (runtime primitives); installing it auto-renames to `core_2` with a warning, as does any id collision.
- App factories type their manifest internally as `AppManifest<TState>` and widen to bare `AppManifest` on return.
- `core/types.ts` and `app/types.ts` are **contract files** — import-only for everyone but the architect. Core depends on the *interfaces* in `app/types.ts` (CommandRegistry/BuilderRegistry), never on the concrete `app/registry.ts` — this breaks the core↔app cycle. Don't add a core→registry import.
