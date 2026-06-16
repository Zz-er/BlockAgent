# block-agent

**English** · [简体中文](./README.md)

[![CI](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> Capability = f(weights, context). You can't change the weights; the context is entirely yours. block-agent takes that one controllable variable — context — and makes it a structure of independently-evolvable building blocks: **you iterate an agent by recomposing its context, not by rewriting its architecture.**

## Overview

What an agent can do comes down to two things: the trained weights, and the context you feed it each turn. The weights are fixed — out of your hands; the context is fully malleable — yours to shape. **There is exactly one place to do the work.** That work now has a name: **context engineering** — filling the context window with the right information for the next step. Most practice treats it as prompt-assembly craft, so context ends up a hand-assembled string: add a piece, change a line, and it ripples everywhere, hardening over time into a black box no one dares touch. block-agent treats it as a **runtime problem**: context is a structured, bounded, composable system, run by a runtime — made of independently-evolvable **building blocks**.

### Context is the model's interface

APIs were designed for programs; GUIs for humans. For a model, the interface is the **context** — everything the agent perceives of the world arrives in what you feed it each turn. An interface deserves to be designed, yet most agents' context never was: it's an append-only transcript of calls — every tool invocation appends another result, every action re-fetches the whole state all over again (browser agents re-snapshotting the entire page after each step are the extreme case), near-identical copies pile up side by side, and the signal slowly drowns in the stale. That disease now has a name too: **context rot**. Deleting stale tool results after the fact is one cure; block-agent takes the earlier step — **never writing them in to begin with**.

What it hands the agent is not a transcript but a **stateful screen**. Each block presents its state as one slice of the screen; when the state changes, that slice updates in place; each turn, the whole screen is re-rendered from current state. Tool results live in a bounded window — as new ones arrive, the oldest leave the view (the full history sits in an on-disk log; nothing is lost); conversation history folds into two slices, a summary plus the recent messages verbatim. What the agent sees is always **the world as it is now**, never a pile of past responses. And if the context changes every turn yet the prompt cache still hits, that's what deterministic rendering buys: the same state always renders the same bytes, blocks are laid out stable → slow-changing → volatile, and the stable prefix sits firmly in cache — **mutable state and cacheable context are not a trade-off here.**

### The interface is built from blocks

A screen can't be one undivided slab — that's the hand-assembled-string road all over again. block-agent cuts it into slices, each owned by an independent little program. That program is a **BlockApp** — "Block" meant literally: a **building block**. Conversation history is one block; tools are one; memory is one; the agent's own identity is one. Adding a capability means snapping in a new block; swapping an implementation means swapping one block for another — neither touches the core.

To write a block, you describe four things: **state** (what it holds, and how that changes under operations), **presentation** (how that state becomes the slice of the interface the agent sees), **operations** (what it exposes — the user, the agent, other blocks, and external systems all use the same set), and **contracts** (what it declares it needs and provides; other blocks connect through that, not through who it is).

Put together, this is what we mean by an **AI-native application**: a BlockApp is not a human-facing program with an API wrapped around it, but an application written for the AI from the start — its interface is its slice of the context, its buttons are the operations it exposes. Giving the agent a capability means installing an application for it, not handing it a stack of API docs. Blocks **bind to contracts, never to names**: one says "I provide a message count," another says "I need a message count" — neither has to know who the other is, and replacing the provider leaves the consumer untouched. And there is **no privileged kernel block** — the built-in blocks and the ones you write take the same shape, the same entry, the same constraints, so the runtime grows block by block instead of stiffening as it grows.

### Safety and self-extension

Every slice of the screen is backed by state; if anyone could casually rewrite that state, the rest is worthless. So **every write converges on a single gate**: for the agent to do anything, it must go through one constrained operation — plain text isn't an action; it's rejected and fed back as a correction. The user, the agent, and the blocks all use the same set of operations; the differences in privilege are decided by one unified authorization gate, and nobody has a back door. Add two deliberate asymmetries: the agent cannot rewrite its own identity constraints, and it cannot install or remove blocks. That is the floor against prompt injection — and these bounds are part of the structure itself, not patches applied after an incident.

The bounds are laid down first so the next step can be taken safely. The agent already reshapes its own context every day: it writes memories, logs tasks, adjusts what it will see next turn — the early form of self-evolution. Since adding a capability is just adding a block, the end of this road is an agent that produces blocks and extends itself. The hard part was never "letting it write" — it's "letting it write within bounds." The runtime prepares for this with a unified host model: trusted blocks run in-process; untrusted ones — third-party, or produced by the agent itself — are placed in a child-process sandbox, and a block declaring capabilities beyond its ceiling is rejected at install time. **Safe self-extension is solved as a structural problem, not gambled on as an alignment problem.**

### Built-in blocks

| Block | Role |
|---|---|
| agent_identity | the agent's identity and constraints; the agent can't rewrite itself |
| messages | conversation history with automatic compaction |
| tools | a set of built-in tools |
| memory | local memory |
| memory_letta | external semantic memory (same interface as memory, interchangeable) |
| task | a task list; writable by the agent or by an external system |
| stats | cross-block statistics (an example of contract-based cooperation) |

### Status

In place: the core loop, the built-in blocks, the interactive terminal, block discovery and (un)installation (including hot-uninstall), contract-based cooperation between blocks (declared interfaces + a pre-render pull by contract), external semantic-memory integration (verified against a live Letta / DashScope), and the unified trusted/sandboxed host model (the cross-process sandbox carrier has landed and is wired into boot, with end-to-end fork tests; no sandboxed block ships with the release yet). Tests green: core 471 · cli 88 · memory_letta 44.

## Quick start (DeepSeek as an example)

```bash
npm install
```

The API key is read only from the environment — never written to a config file, never committed. There are two equivalent ways to start; take either.

**Option 1: command-line flags** — handiest for a quick run or switching models on the fly. Set the key in your shell and start:

```bash
export OPENAI_API_KEY=sk-your-key   # openai-compat providers (incl. DeepSeek / DashScope) all read this variable
npm start -- --provider openai-compat --model deepseek-chat --base-url https://api.deepseek.com
```

**Option 2: `.env` + a config file** — put both the key and the model in files, and starting is just `npm start`.

① Drop the API key — create a gitignored `.env` at the repo root; it's loaded automatically at startup (and overrides shell variables of the same name):

```bash
# .env (repo root, ignored by .gitignore)
# Note: openai-compat providers (incl. DeepSeek / DashScope) all read OPENAI_API_KEY
OPENAI_API_KEY=sk-your-key
```

② Pick DeepSeek — create `block-agent.config.json` at the repo root (also gitignored):

```json
{
  "provider": {
    "kind": "openai-compat",
    "model": "deepseek-chat",
    "base_url": "https://api.deepseek.com",
    "thinking_format": "openai_reasoning"
  }
}
```

③ Run:

```bash
npm start

# No key, just want to see it run (offline, no network):
npm start -- --dry-run
```

You land in an interactive terminal: type to message the agent; lines starting with `/` are commands (`/help` for the full list, `/apps` for the blocks). The two ways mix freely; precedence is flags > config file > env > defaults. Switching to Anthropic or any OpenAI-compatible endpoint (Ollama / vLLM / DashScope) is just a change of provider and base_url.

## Web chat (browser, optional)

Besides the terminal, you can talk to the agent in a browser. It comes in two layers: a headless backend, `block-agent-serve` (it fronts the same agent over WebSocket), and a Vite + React web frontend (the chat UI). `.env` and `block-agent.config.json` are recognized **exactly as by `npm start`** (the same loader), so the DeepSeek/key you set above is reused as-is here.

Open two terminals, **both from the repo root**:

```bash
# Terminal 1 — start the backend (port 4317 must match the web default)
npm run serve -- --name web --port 4317
# "listening on ws://127.0.0.1:4317" means it's up (it loaded .env + block-agent.config.json)

# Terminal 2 — start the web frontend
npm run web
# Vite prints a URL like http://localhost:5173 — open it to chat
```

A few notes:

- **Use `--port 4317`** — the web frontend connects to `ws://localhost:4317` by default. To use another port, set `VITE_WS_URL` when starting the web, e.g. `VITE_WS_URL=ws://localhost:7345 npm run web`.
- Use the root script `npm run serve`, **not** `npm run serve -w @block-agent/server` — the latter runs in the package directory and won't find the repo-root `.env` / config file.
- Loopback only: the backend stamps input as the `user` invoker unconditionally, which is only safe on `localhost`. Don't bind `0.0.0.0` until an auth layer is in place.

## Working directory (root_dir, optional)

By default `.env`, `block-agent.config.json`, and all BlockApp data (`.block-agent/apps/<id>/`) live in the directory you launch from (the current working directory, cwd). **With no new flags the behavior is byte-for-byte identical to before** — existing users need to change nothing.

If you want to pin a process's entire state to an explicit root directory (a container volume, several agents on one machine, or just decoupling data from cwd), use `--root-dir`:

```bash
npm start -- --root-dir /srv/agent-a
# equivalent: BLOCK_AGENT_ROOT_DIR=/srv/agent-a npm start
```

From then on that process's `.env`, config file, and app data all live under `/srv/agent-a`. Two processes pointed at different `--root-dir`s are fully isolated; a second process pointed at the **same** root is refused at startup (and prints the holder's pid) so two processes can't interleave writes and corrupt the data.

A few notes:

- **`BLOCK_AGENT_ROOT_DIR` must be a real shell/container environment variable** (ambient env) — it **cannot live in `.env`**, because the root has to be decided *before* `.env` is loaded (the `.env` itself lives inside the root). Putting it in `.env` has no effect. This inverts the usual "file overrides env" intuition and is the most common footgun.
- **The root must already exist**: `--root-dir` pointing at a non-existent directory **fails fast and exits** (so a typo'd path can't silently create empty state = the agent's amnesia). To create it on purpose, add `--create-root` (e.g. a container's first boot with an empty root volume). The `.block-agent/apps` subtree below it is still created lazily.
- **Old data is not migrated when you point at a brand-new root.** If you used to run in cwd and now explicitly switch to a new root, the old `.block-agent` / `.env` / config are not moved automatically — `mv` them yourself when needed (e.g. `mv ./.block-agent ./.env ./block-agent.config.json /srv/agent-a/`).
- The old `--storage-dir` / `BLOCK_AGENT_STORAGE_DIR` remain as **deprecated** aliases: when no `--root-dir` is given they can still redirect app data within the root; once `--root-dir` is given explicitly, the root wins.
- `--config <path>` is not re-homed by the root: an absolute path is used as-is, a relative path still resolves against cwd (it's the file you explicitly pointed at).

## Tutorial & docs

To build a block of your own, start with the [BlockApp development guide](./doc/blockapp-development.md) — it begins from the project's directory layout (where `apps/` lives, which files make up a block), then walks you file by file through writing your first working block. Full usage & development docs are in [`doc/`](./doc/README.md).

Code layout: `packages/core` (the core runtime, zero runtime dependencies) · `packages/cli` (the interactive terminal) · `apps/*` (built-in BlockApps, including `apps/memory_letta` for dependency-isolated external-memory integration). Stack: Node 24 · TypeScript · vitest.

## License

[MIT](./LICENSE) © 2026 zzer and BlockAgent contributors
