# block-agent

**English** · [简体中文](./README.md)

[![CI](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> capability = f(weights, context). You can't change the weights; the context is entirely yours. The premise of block-agent: make context a **modular structure that can evolve independently** — an agent advances by recomposing its context, not by rewriting its architecture.

An agent's behavior is set by two variables: the trained weights (fixed), and the context handed to it each turn (malleable). Only the latter can be improved. Most frameworks treat context as a stretch of text stitched together on the fly, where one change ripples through everything — and gets harder to maintain the further you go. block-agent treats it as a system to be managed: structured, bounded, composable.

## The premise

- What can be improved is the context, not the weights. The question therefore becomes: how do you let context **keep evolving without decaying**.
- The answer is modularity — split the context into independent units, each owning one slice of capability: the **BlockApp**.
- Iterating on an agent means adding, removing, replacing, and recomposing these units, without touching its core.

## Modular context that evolves independently

- Each BlockApp encapsulates one slice of capability (conversation, memory, tools, identity, tasks…), developed independently, replaced independently, with no entanglement between them.
- Modules connect **through the interfaces each one declares**, never reaching into one another's internals. Replace a module's implementation and the modules depending on it need no change — swap one memory implementation for another, for instance, and the agent side changes nothing.
- Built-in modules and the ones you write are **the same shape**. There is no privileged core.

## A path toward self-evolution

Put the two ideas together — the malleable part of capability lives entirely in the context, and that context is a set of modules you can add, remove, or replace — and an agent's "getting stronger" reduces to one well-defined operation: recompose its own modules, rather than rewrite its own architecture.

- The agent already reshapes its own context continuously: through the operations modules expose, it writes memories, registers tasks, and adjusts the world it sees next turn. This is the early form of self-evolution.
- The natural extension: since adding a new capability is just adding a module, the end of this path is an agent that produces modules and extends itself.
- The hard part was never "letting it write" — it is "letting it write within bounds." The bounds — a single entry point for state, uniform authorization, an agent that cannot rewrite its own constraints — are a premise of the design, not a patch on top. Safe self-extension is solved as a structural problem, and that is exactly what modularity and constrained operations are meant to buy.

## BlockApp: a stateful context program

A BlockApp is not static content; it is a small program. To build one, you describe four things:

1. **State and its evolution** — what state it holds, and how that state changes under operations.
2. **Presentation** — how that state becomes the context the agent sees.
3. **Operations** — which operations it exposes; this is the active face of its interface, used jointly by the user, the agent, other modules, or external systems.
4. **Contract** — what it depends on and what it provides; other modules connect to it on that basis, not by knowing its identity or its internals.

> Example: a stats module declares that it needs "message count" and "task count"; the messages module and the task module each declare that they provide one of those. The framework wires them up by what they declared. Replace the messages module's implementation, and the stats module is unaffected.

## Built-in modules

| Module | Role |
|---|---|
| identity | The agent's identity and constraints; the agent cannot rewrite itself |
| messages | Conversation history with automatic compaction |
| tools | A set of built-in tools |
| memory | Local memory |
| memory_letta | External semantic memory (same interface as memory, interchangeable) |
| task | Task list; writable by the agent or by external systems |
| stats | Cross-module statistics (an example of modules cooperating) |

To build your own module, see the [documentation](./doc/README.md).

## Quick start (DeepSeek as the example)

```bash
npm install
```

The API key is read only from the environment — never written to config, never committed. Put a gitignored `.env` at the repo root:

```bash
# openai-compat providers (including DeepSeek / Bailian) all read OPENAI_API_KEY
OPENAI_API_KEY=sk-your-key
```

Pick a model and start:

```bash
npm start -- --provider openai-compat --model deepseek-chat --base-url https://api.deepseek.com

# To watch it run without a key (offline, no network):
npm start -- --dry-run
```

Interactive terminal: plain input = send a message to the agent; a leading `/` = a command (`/help`, `/apps`). You can also hard-code configuration in `block-agent.config.json` at the repo root; precedence is flags > config file > env > defaults. Switching to Anthropic or any OpenAI-compatible endpoint (Ollama / vLLM / Bailian) only requires changing the provider and base_url.

## Principles

- Every change to state goes through a single entry point with uniform authorization — what the agent can do is a finite set, auditable and constrainable.
- The agent's actions can only be constrained operations, never free text; this is also the floor of injection resistance.
- Context presentation is deterministic: the same input yields the same result, so it can be cached and reused.
- The agent cannot rewrite its own constraints, nor load or unload modules.
- Model-agnostic: Anthropic and any OpenAI-compatible endpoint work out of the box.

## Structure and documentation

`packages/core` (core + built-in modules, zero runtime dependencies) · `packages/cli` (interactive terminal) · `packages/memory-letta` (external memory integration, isolated as a dependency) · `doc/` (usage and development docs). Stack: Node 24 · TypeScript · vitest.

## Status

Implemented: the core loop, built-in modules, the interactive terminal, the module lifecycle (including hot unload), cross-module cooperation via contracts (declared interfaces + fetching data by contract before rendering), and external memory integration (verified live against Letta / Bailian DashScope). Tests all green: core 274 · cli 88 · memory-letta 44.

## License

[MIT](./LICENSE) © 2026 zzer and BlockAgent contributors
