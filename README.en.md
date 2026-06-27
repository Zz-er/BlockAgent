# block-agent

**English** · [Simplified Chinese](./README.md)

[![CI](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> Assemble the LLM's context like building blocks

## Introduction

An LLM's capabilities are determined by two things: its **trained weights** and the **input context**. To enhance an LLM's capabilities, the trained weights are fixed, but we can modify the context provided to it. According to internal research from Anthropic, good context management can increase an agent's capability by up to 29% and reduce token consumption by up to 84%. Currently, common agent projects, like Claude Code, typically structure their context into several modules: system prompts, tool information, and multi-turn message history, often with compression applied to the message history. block-agent treats context construction as a **runtime problem**: the context is a structured, bounded, and composable system managed by the runtime, broken down into independently evolving **Blocks**. Here, a "Block" is literal: like building blocks, they are pieced together, and each block can be replaced and evolved independently.

The differences between the various popular agent projects today lie in their architecture and context. In theory, by developing blocks related to Claude Code, one could assemble a block-agent version of Claude Code. Similarly, by developing blocks for Hermes, a block-agent version of Hermes could be created.

### Context is the Interface for the Model

APIs are for programs, GUIs are for humans. When it comes to models, their interface is the **context**—the agent's entire perception of the world comes from the content fed in each turn. Interfaces deserve to be designed, yet the context of most agents has never been designed: it's an ever-growing transcript of calls—appending a result for every tool call, re-fetching a full representation for every action (the most extreme example being a browser agent re-capturing the entire page snapshot at every step). Several nearly identical pieces of content are piled up, and effective information is gradually drowned out by outdated information. This problem now has a name: **context rot**. Deleting outdated tool results afterward is one solution; block-agent postpones the handling of these issues, allowing users to independently optimize various context modules during use.

The block-agent project proposes not just simple fixed text, but a **BlockApp** with a state machine where blocks can pass information to each other: a Block, coupled with the logic to operate it. The conversation history is a Block, tools are a Block, memory is a Block, and the agent's identity is also a Block. Adding a new capability to the agent is equivalent to adding a new Block; changing an implementation is equivalent to swapping one Block for another—all without touching its core.

When writing a Block, you describe four things: **State** (what it holds, how it changes with operations), **Presentation** (how the state becomes the interface slice the agent sees), **Operations** (which actions are exposed externally; users, the agent, other Blocks, and external systems all use the same set), and **Contract** (declaring what it depends on and what it provides; other Blocks connect based on this, without depending on who it is).

### Built-in Blocks

| Block | Function |
|---|---|
| agent_identity | The agent's identity and constraints; the agent cannot modify itself |
| messages | Conversation history with automatic compression |
| tools | A set of built-in tools |
| memory | Local memory |
| memory_letta | External semantic memory (interchangeable with 'memory' as it shares the same interface) |
| task | Task list; can be written to by the agent or external systems |
| stats | Cross-Block statistics (an example of contract-based collaboration) |

## Quick Start (with DeepSeek as an example)

```bash
npm install
```

The API key is only read from environment variables, never written into configuration files or stored in a database. There are two equivalent ways to start; choose either one.

**Method 1: Command-line flags**—This is the most convenient for temporary runs or quick model changes. Set the key in your shell and start directly:

```bash
export OPENAI_API_KEY=sk-your-key   # openai-compat providers (including DeepSeek / Bailian) all read this variable
npm start -- --provider openai-compat --model deepseek-chat --base-url https://api.deepseek.com
```

**Method 2: `.env` + configuration file**—Write both the key and the model into files, then you only need `npm start` to launch.

① Place the API key—create a gitignored `.env` file in the repository root. It will be loaded automatically on startup (and will override shell environment variables with the same name):

```bash
# .env (in the repository root, ignored by .gitignore)
# Note: openai-compat providers (including DeepSeek / Bailian) all read OPENAI_API_KEY
OPENAI_API_KEY=sk-your-key
```

② Select DeepSeek—create a `block-agent.config.json` file in the repository root (also ignored by gitignore):

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

# If you want to see it run without a key (offline, no network):
npm start -- --dry-run
```

After starting, you will be in an interactive terminal: typing directly sends a message to the agent; starting with `/` is a command (`/help` to see all, `/apps` to see Blocks). The two methods can be mixed, with the priority being: flags > config file > .env > defaults. To switch to Anthropic or any OpenAI-compatible endpoint (Ollama / vLLM / Bailian), just change the provider and base_url.

## Web Conversation (Browser, Optional)

Besides the terminal, you can also chat with the agent in a browser. It is split into two layers: a headless backend `block-agent-serve` (which exposes the same agent via WebSocket), and a Vite + React web frontend (the chat interface). The recognition rules for `.env` and `block-agent.config.json` are **exactly the same** as for `npm start` (it's the same loading logic), so the DeepSeek/key configured above can be reused directly here.

Open two terminals and run the commands **from the repository root directory**:

```bash
# Terminal 1 — Start the backend (port 4317 must match the web's default)
npm run serve -- --name web --port 4317
# When you see "listening on ws://127.0.0.1:4317", it's ready (has loaded .env + block-agent.config.json)

# Terminal 2 — Start the web frontend
npm run web
# Vite will print an address like http://localhost:5173, open it in your browser to start chatting
```

A few points to note:

- **Must use `--port 4317`**—the web frontend connects to `ws://localhost:4317` by default. If you want to change the port, set `VITE_WS_URL` when running the web command, e.g.: `VITE_WS_URL=ws://localhost:7345 npm run web`.
- Use the root script `npm run serve`, **do not** use `npm run serve -w @block-agent/server`—the latter will change the working directory to the package directory, and it won't be able to find the `.env` and config files in the repository root.
- Localhost loopback only: The backend unconditionally stamps all input with the "user" identity, which is only safe on `localhost`. Do not bind to `0.0.0.0` before authentication is added.

## Working Directory (root_dir, Optional)

By default, `.env`, `block-agent.config.json`, and all BlockApp data (`.block-agent/apps/<id>/`) are located in the directory where you start the process (the current working directory, cwd). **When no new parameters are passed, the behavior is byte-for-byte identical to before**—existing users do not need to make any changes.

If you want to pin all the state of an agent process to a specific root directory (for container volumes, multiple agents on one machine, or decoupling data from cwd), use `--root-dir`:

```bash
npm start -- --root-dir /srv/agent-a
# Equivalent: BLOCK_AGENT_ROOT_DIR=/srv/agent-a npm start
```

After this, the process's `.env`, configuration file, and app data will all be under `/srv/agent-a`. Two processes pointing to different `--root-dir`s will not interfere with each other. A second process pointing to the **same** root will be refused to start (and the PID of the process holding the lock will be printed) to prevent data corruption from interleaved writes.

Key points:

- **`BLOCK_AGENT_ROOT_DIR` must be a true shell/container environment variable** (ambient env), and **cannot be written into `.env`**—because the root must be determined *before* `.env` is loaded (since `.env` itself lives inside the root). Putting it in `.env` will have no effect, which is contrary to the usual intuition that "files override env" and is a common pitfall.
- **The root must already exist**: Pointing `--root-dir` to a non-existent directory will **cause an immediate error and exit** (to prevent silent creation of an empty directory, which would mean agent amnesia, if the path is mistyped). If you really need to create it, add `--create-root` (e.g., for the first launch of a container where the root volume is empty but valid). The `.block-agent/apps` directory underneath it will be created automatically as needed.
- **Pointing to a brand new root will not automatically move old data**. If you were previously running in the cwd and now explicitly switch to a new root, the old `.block-agent` / `.env` / configuration will not be migrated automatically—you'll need to manually `mv` them if needed (e.g., `mv ./.block-agent ./.env ./block-agent.config.json /srv/agent-a/`).
- The old `--storage-dir` / `BLOCK_AGENT_STORAGE_DIR` is kept as a **deprecated** alias: if `--root-dir` is not explicitly given, it can still redirect app data within the root; once `--root-dir` is explicitly given, the root takes precedence.
- `--config <path>` is not affected by root redirection: absolute paths are used as is, and relative paths are still resolved relative to the cwd (the file you are pointing to).

## Tutorials and Documentation

If you want to build a Block yourself, start with the [BlockApp Development Guide](./doc/blockapp-development.md)—it starts by explaining the project's directory structure, tells you where `apps/` is, what files a Block is composed of, and then guides you file by file to write your first usable Block. For complete usage and development documentation, see [`doc/`](./doc/README.md).

Code Structure: `packages/core` (core runtime, zero runtime dependencies) · `packages/cli` (interactive terminal) · `apps/*` (built-in BlockApps, including `apps/memory_letta` for external memory integration and dependency isolation). Tech Stack: Node 24 · TypeScript · vitest.

## License

[MIT](./LICENSE) © 2026 zzer and BlockAgent contributors