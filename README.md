# block-agent

[English](./README.en.md) · **简体中文**

[![CI](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> 能力 = f(权重, 上下文)。权重你改不了，上下文你完全可控。block-agent 把这唯一可控的变量——上下文——做成可独立演化的 Block 结构：**迭代一个 agent，靠重组它的上下文，而不是重写它的架构。**

## 简介

一个 agent 能做成什么，由两样东西决定：训练好的权重，和每一轮喂给它的上下文。权重是固定的，你动不了；上下文完全可塑，你说了算——**能下功夫的地方只有一个**。这件事如今有了名字：**上下文工程**（context engineering），为下一步把恰当的信息放进上下文窗口。多数实践把它当成拼提示词的手艺，于是上下文成了一段手工拼出来的字符串——加一段、改一处，牵动全局，越往后越像一个谁也不敢动的黑盒。block-agent 把它当成**运行时问题**来解：上下文是一个有结构、有边界、可组合的系统，由运行时来经营，拆成一块块可独立演化的 **Block**——这里的 Block 就是字面意义上的"块"：像积木一样，一块块拼起来，每一块都能单独替换、单独演化。

### 上下文是给模型的界面

API 为程序而生，GUI 为人类而生。轮到模型，它的界面就是**上下文**——agent 对世界的全部感知，都来自每一轮喂进去的那段内容。界面值得被设计，而多数 agent 的上下文从未被设计过：它是一份只增不减的调用转录——每调一次工具追加一份结果，每动一次就重新拉一遍全量表述（浏览器 agent 每步重抓整页快照是最极端的样子），几份几乎相同的内容并排堆着，有效信息被过期信息一点点淹没。这个病如今也有了名字：**context rot**。事后再去删除过期的工具结果是一种解法；block-agent 选了更早的一步——**从一开始就不把它们写进去**。

它给 agent 的不是转录，而是一块**有状态的屏幕**。每个 Block 把自己的状态呈现成屏幕上的一片；状态变了，原地更新那一片；每一轮，整块屏幕从当前状态重新呈现。工具结果住在一个有界窗口里——新结果进来，最老的退出视野（全量历史在磁盘日志里，不丢）；对话历史折叠成"摘要 + 近期原文"两片。agent 看到的永远是**现在的世界**，而不是历史响应的堆叠。而上下文每轮都变、提示词缓存还能命中，靠的是确定性呈现：同样的状态总是呈现出同样的字节，块按"稳定 → 缓变 → 易变"排列，稳定的前缀稳稳躺在缓存里——**可变的状态与可缓存的上下文，在这里不是二选一。**

### 界面由 Block 拼成

一块屏幕不能是一坨整体——那正是手拼字符串的老路。block-agent 把它切成片，每一片交给一个独立的小程序。这个小程序叫 **BlockApp**：一个 Block，配上操作它的逻辑。对话历史是一个 Block，工具是一个，记忆是一个，agent 的身份也是一个。给 agent 添一种能力，等于拼上一个新 Block；换一种实现，等于把一个 Block 换成另一个——都不必动它的内核。

写一个 Block，你描述四件事：**状态**（它持有什么、怎样随操作改变）、**呈现**（状态如何变成 agent 看到的那一片界面）、**操作**（对外开放哪些动作；使用者、agent、别的 Block、外部系统都走同一组）、**契约**（声明依赖什么、提供什么；别的 Block 据此对接，而不依赖它是谁）。

合起来看，这就是我们对 **AI 原生应用**的理解：BlockApp 不是给人用的程序外面包一层 API，而是一开始就写给 AI 用的应用——它的界面就是它在上下文里的那一片，它的按钮就是它暴露的那组操作。给 agent 添能力，是给它装一个应用，不是丢给它一堆接口文档。Block 之间**绑契约、不点名**：一个说"我提供消息数"，另一个说"我需要消息数"，双方都不必知道对方是谁，换掉提供方、消费方一行不改。而且**没有"内核特权 Block"**——内置的和你写的，走完全相同的形态、入口、约束，运行时因此能一块块生长，而不是越长越僵。

### 安全与自我扩展

屏幕上的每一片都连着一份状态；状态谁都能随手改的话，前面全都白搭。所以**所有写入收敛到唯一一道关口**：agent 想做任何事，只能通过一次受约束的操作——光说一段话不算动作，会被拒绝、并作为反馈喂回。使用者、agent、Block 三方走同一组操作，权限差异由统一的鉴权关口裁决，没有谁有后门；再加两条刻意的不对称：agent 改不了自己的身份约束，也装卸不了 Block。这是抗提示注入的底线，而这些边界是结构本身的一部分，不是出了事再打的补丁。

边界先立好，是为了下一步敢往前走。agent 今天已经在不断重塑自己的上下文：写下记忆、登记任务、调整自己下一轮看到的世界——这是自我演化的初级形态。既然添一种能力只等于添一个 Block，这条路的终点，就是 agent 自己产出 Block、扩展自己。难点从不在"让它写"，而在"让它在边界内写"。运行时为此准备了统一宿主模型：可信的 Block 跑在同进程，不可信的——第三方的、agent 自己产出的——被放进子进程沙箱，声明的能力超出天花板的在安装时就被拒绝。**安全的自我扩展，被当成一个结构问题来解，而不是一个对齐问题来赌。**

### 内置 Block

| Block | 作用 |
|---|---|
| agent_identity | agent 的身份与约束；agent 无法改写自己 |
| messages | 对话历史与自动压缩 |
| tools | 一组内置工具 |
| memory | 本地记忆 |
| memory_letta | 外部语义记忆（与 memory 同接口、可互换） |
| task | 任务列表；可由 agent 或外部系统写入 |
| stats | 跨 Block 统计（契约协作的示例） |

### 状态

已实现：核心闭环、内置 Block、交互式终端、Block 的发现与装卸（含热卸载）、Block 间按契约协作（声明接口 + 每轮渲染前按契约取数）、外部语义记忆对接（真实 Letta / 百炼 DashScope 跑通）、可信／沙箱的统一宿主模型（跨进程沙箱载体已落地并接入启动、有端到端 fork 测试；发行版暂未附带沙箱 Block）。测试全绿：core 471 · cli 88 · memory_letta 44。

## 快速开始（以 DeepSeek 为例）

```bash
npm install
```

API key 只从环境变量读，绝不写进配置文件、不入库。启动有两种等价的方式，任选其一。

**方式一：命令行 flags**——临时试跑、随手换模型时最顺手。在 shell 里设好 key，直接启动：

```bash
export OPENAI_API_KEY=sk-你的key   # openai-compat 类 provider（含 DeepSeek / 百炼）统一读这个变量
npm start -- --provider openai-compat --model deepseek-chat --base-url https://api.deepseek.com
```

**方式二：`.env` + 配置文件**——把 key 和模型都写进文件，之后启动只需 `npm start`。

① 放 API key——在仓库根建一个 gitignored 的 `.env`，启动时会自动加载（且覆盖同名的 shell 环境变量）：

```bash
# .env（仓库根，已被 .gitignore 忽略）
# 注意：openai-compat 类 provider（含 DeepSeek / 百炼）统一读 OPENAI_API_KEY
OPENAI_API_KEY=sk-你的key
```

② 选 DeepSeek——在仓库根建 `block-agent.config.json`（也被 gitignore）：

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

③ 跑：

```bash
npm start

# 没有 key 也想看它跑（离线，不联网）：
npm start -- --dry-run
```

启动后是一个交互式终端：直接打字 = 给 agent 发消息；以 `/` 开头 = 命令（`/help` 看全部，`/apps` 看 Block）。两种方式可以混用，优先级 flags > 配置文件 > env > 默认。换成 Anthropic 或任意 OpenAI 兼容端点（Ollama / vLLM / 百炼）只需改 provider 与 base_url。

## Web 端对话（浏览器，可选）

除了终端，还可以在浏览器里和 agent 对话。它分两层：一个无界面的后端 `block-agent-serve`（把同一个 agent 用 WebSocket 暴露出来），和一个 Vite + React 的 web 前端（对话界面）。`.env` 与 `block-agent.config.json` 的识别规则与 `npm start` **完全一致**（同一套加载逻辑），所以上面配好的 DeepSeek/key 这里直接复用。

开两个终端，**都在仓库根目录**跑：

```bash
# 终端 1 —— 启后端（端口 4317 要和 web 默认对上）
npm run serve -- --name web --port 4317
# 看到 “listening on ws://127.0.0.1:4317” 即就绪（已加载 .env + block-agent.config.json）

# 终端 2 —— 启 web 前端
npm run web
# Vite 打印一个 http://localhost:5173 之类的地址，浏览器打开它即可对话
```

几点注意：

- **必须 `--port 4317`**——web 前端默认连 `ws://localhost:4317`。想换端口就在跑 web 时设 `VITE_WS_URL`，例：`VITE_WS_URL=ws://localhost:7345 npm run web`。
- 用根脚本 `npm run serve`，**不要**用 `npm run serve -w @block-agent/server`——后者会把工作目录切到包目录，找不到仓库根的 `.env` 与配置文件。
- 仅限本机 loopback：后端无条件把输入按"使用者"身份盖章，只在 `localhost` 上是安全的；未加鉴权前不要绑 `0.0.0.0`。

## 教程与文档

想自己拼一个 Block，从 [BlockApp 开发指南](./doc/blockapp-development.md) 开始——它从整个项目的目录结构讲起，告诉你 `apps/` 在哪、一个 Block 由哪几个文件组成，再逐个文件带你写出第一个可用的 Block。完整的使用与开发文档见 [`doc/`](./doc/README.md)。

代码结构：`packages/core`（核心运行时，零运行时依赖）· `packages/cli`（交互式终端）· `apps/*`（内置 BlockApp，含 `apps/memory_letta` 外部记忆对接、依赖隔离）。技术栈：Node 24 · TypeScript · vitest。

## License

[MIT](./LICENSE) © 2026 zzer and BlockAgent contributors
