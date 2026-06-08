# block-agent

**English** · [简体中文](./README.md)

[![CI](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> Capability = f(weights, context). You can't change the weights; the context is entirely yours. block-agent takes that one controllable variable — context — and makes it a modular, independently-evolvable structure: **you iterate an agent by recomposing its context, not by rewriting its architecture.**

What an agent can do comes down to two things: the trained weights (fixed — out of your hands), and the context you feed it each turn (fully malleable). Only the latter is yours to work on. Yet most frameworks treat context as a hand-assembled string — add a piece, change a line, and it ripples everywhere; over time it becomes a black box no one dares touch. block-agent does the opposite: it runs context as a **structured, bounded, composable** system.

The unit of that system is a **BlockApp**. Conversation history is a BlockApp; tools are one; memory is one; the agent's own identity is one. Adding a capability means writing a BlockApp and installing it; swapping an implementation means replacing one BlockApp with another — neither touches the core. Crucially, there is **no privileged kernel module**: built-in capabilities and the ones you write take the same shape, the same entry, the same constraints. The runtime grows block by block instead of stiffening as it grows.

## Three core ideas

- **Context is composed of modules, each evolving on its own.** Every module owns its slice — developed, replaced, independent. Swap one memory implementation for another and the modules that depend on it don't change a word.
- **Modules collaborate through declared contracts, not by naming each other.** One module says "I provide a message count," another says "I need a message count" — neither has to know who the other is. Replace the provider and the consumer is unaffected. Flexibility comes from binding to a contract, not an identity.
- **The agent can only act through a constrained operation.** Plain text isn't an action — it's rejected and fed back as a correction. Every write converges on a single authorization gate; nobody has a back door. This is also the floor against prompt injection.

## A path toward self-evolution

Put it together: the malleable part of capability lives entirely in context, and context is a set of modules you can add to, remove, and replace — so "making the agent stronger" reduces to one clear act: recomposing its modules, not rewriting its architecture.

The agent already reshapes its own context: through the operations modules expose, it writes memories, logs tasks, adjusts what it will see next turn. That is the early form of self-evolution. One step further — since adding a capability is just adding a module — the end of this path is an agent that produces modules and extends itself. The hard part was never "letting it write," but "letting it write within bounds"; and the bounds (a single state entry, unified authorization, an agent that cannot rewrite its own constraints) are a premise of this design, not an afterthought. **Safe self-extension is treated as a structural problem** — which is exactly what modularity and constrained operations buy.

## BlockApp: a stateful context program

A BlockApp isn't static content; it's a small program. To write one, you describe four things:

1. **State, and how it evolves** — what the module holds, and how that changes under operations.
2. **Presentation** — how that state becomes the slice of context the agent sees.
3. **Operations** — what it exposes; the active face of its interface, used alike by the user, the agent, other modules, and external systems.
4. **Contracts** — what it declares it needs and provides; other modules connect through that, not through its identity or internals.

> A working example: an "overview" module declares it needs a "message count" and a "task count"; the conversation and task modules each declare they provide them. The framework wires them up and feeds the latest figures in each turn. Replace the conversation module wholesale — as long as the new one also provides a "message count," the overview module doesn't change a line.

## Built-in modules

| Module | Role |
|---|---|
| identity | the agent's identity and constraints; the agent can't rewrite itself |
| messages | conversation history with automatic compaction |
| tools | a set of built-in tools |
| memory | local memory |
| memory_letta | external semantic memory (same interface as memory, interchangeable) |
| task | a task list; writable by the agent or by an external system |
| stats | cross-module statistics (an example of module-to-module collaboration) |

To write a capability of your own, see the [usage & development docs](./doc/README.md).

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

You land in an interactive terminal: type to message the agent; lines starting with `/` are commands (`/help` for the full list, `/apps` for the modules). The two ways mix freely; precedence is flags > config file > env > defaults. Switching to Anthropic or any OpenAI-compatible endpoint (Ollama / vLLM / DashScope) is just a change of provider and base_url.

## What it buys you

Flexible, because modules bind to contracts rather than identities. Safe, because every write converges on a single gate, and the agent can neither rewrite its own constraints nor install or remove modules. Clear, because context is rendered deterministically — the same state always yields the same content, so the context cache holds. Together, those three are the structured, legible context block-agent sets out to hand the model. It is model-agnostic: Anthropic and any OpenAI-compatible endpoint work out of the box.

## Layout & docs

`packages/core` (runtime + built-in modules, zero runtime dependencies) · `packages/cli` (the interactive terminal) · `packages/memory-letta` (external-memory integration, dependency-isolated) · `doc/` ([usage & development docs](./doc/README.md)). Stack: Node 24 · TypeScript · vitest.

## Status

In place: the core loop, the built-in modules, the interactive terminal, module discovery and (un)installation (including hot-uninstall), contract-based collaboration between modules (declared interfaces + a pre-render pull by contract), and external semantic-memory integration (verified against a live Letta / DashScope). Tests green: core 274 · cli 88 · memory-letta 44.

## License

[MIT](./LICENSE) © 2026 zzer and BlockAgent contributors
