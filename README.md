# block-agent

[English](./README.en.md) · **简体中文**

[![CI](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> 能力 = f(权重, 上下文)。权重你改不了，上下文你完全可控。block-agent 把这唯一可控的变量——上下文——做成可独立演化的模块化结构：**迭代一个 agent，靠重组它的上下文，而不是重写它的架构。**

一个 agent 能做成什么，由两样东西决定：训练好的权重（固定，你动不了），和每一轮喂给它的上下文（你完全可塑）。能下功夫的只有后者。可多数框架把上下文当成一段手工拼出来的字符串——加一段、改一处，常常牵动全局，越往后越像一个谁也不敢动的黑盒。block-agent 反过来：把上下文当成一个**有结构、有边界、可组合**的系统来经营。

组成这个系统的单元，叫 **BlockApp**。对话历史是一个 BlockApp，工具是一个，记忆是一个，agent 的身份也是一个。给 agent 添一种能力，等于写一个 BlockApp 装进去；换一种实现，等于把一个 BlockApp 换成另一个——都不必动它的内核。关键是**没有"内核特权模块"**：内置能力和你写的能力走完全相同的形态、相同的入口、相同的约束。运行时因此能一块一块地生长，而不是越长越僵。

## 三个核心想法

- **上下文是模块拼出来的，各自独立演化。** 每个模块只管自己那一片，独立开发、独立替换、互不牵连。把一种记忆实现换成另一种，依赖它的模块一个字都不用改。
- **模块之间按声明的契约协作，而不是互相点名。** 一个模块说"我提供消息数"，另一个说"我需要消息数"，双方都不必知道对方是谁。换掉提供方，消费方不受影响——灵活的根，在于绑的是契约、不是身份。
- **agent 想做任何事，只能通过一次受约束的操作。** 光说一段话不算动作——会被拒绝、并作为反馈喂回。所有写入都收敛到同一道鉴权关口，没有谁有后门；这也是抗注入的底线。

## 自我演化的路径

把这些合起来看：能力里可塑的部分全在上下文，而上下文是可增减、可替换的模块——于是"让 agent 变强"被还原成一个明确的动作：重组它的模块，而不是重写它的架构。

agent 今天已经在不断重塑自己的上下文：它通过模块开放的操作写下记忆、登记任务、调整自己下一轮看到的世界。这是自我演化的初级形态。再往前一步——既然添一种能力只等于添一个模块，这条路的终点，就是 agent 自己产出模块、扩展自己。难点从不在"让它写"，而在"让它在边界内写"；而边界（唯一的状态入口、统一鉴权、agent 改不了自己的约束）是这套设计的前提，不是事后补丁。**安全的自我扩展，被当成一个结构问题来解**——这正是模块化与受约束操作要换来的东西。

## BlockApp：一个有状态的上下文程序

BlockApp 不是一段静态内容，而是一个小程序。写一个，你描述四件事：

1. **状态，以及它如何演化**——模块持有什么状态，状态怎样随操作改变。
2. **呈现**——这些状态如何变成 agent 看到的那一片上下文。
3. **操作**——它对外开放哪些操作；这是它接口的主动面，使用者、agent、别的模块、外部系统都走同一组。
4. **契约**——它声明依赖、提供哪些能力；别的模块据此与它对接，而不依赖它是谁、内部怎么实现。

> 一个已经能跑的例子：一个"概览"模块声明它需要"消息数""任务数"；对话模块和任务模块各自声明提供这两项。框架按声明把它们接起来，每轮把最新的数喂给概览模块。你把对话模块整个换掉，只要新的也提供"消息数"，概览模块一行不改。

## 内置模块

| 模块 | 作用 |
|---|---|
| identity | agent 的身份与约束；agent 无法改写自己 |
| messages | 对话历史与自动压缩 |
| tools | 一组内置工具 |
| memory | 本地记忆 |
| memory_letta | 外部语义记忆（与 memory 同接口、可互换） |
| task | 任务列表；可由 agent 或外部系统写入 |
| stats | 跨模块统计（模块间协作的示例） |

想写一块属于自己的能力，见 [使用与开发文档](./doc/README.md)。

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

启动后是一个交互式终端：直接打字 = 给 agent 发消息；以 `/` 开头 = 命令（`/help` 看全部，`/apps` 看模块）。两种方式可以混用，优先级 flags > 配置文件 > env > 默认。换成 Anthropic 或任意 OpenAI 兼容端点（Ollama / vLLM / 百炼）只需改 provider 与 base_url。

## 它换来了什么

灵活，因为模块绑的是契约、不是身份；安全，因为所有写入都收敛到唯一一道关口、agent 改不了自己的约束、也装卸不了模块；清晰，因为上下文是被确定地呈现出来的——同样的状态总是同样的内容，上下文缓存因此能稳定命中。这三件事合起来，就是 block-agent 想交给 agent 的那份**结构清晰的上下文**。模型上它不挑：Anthropic 与任意 OpenAI 兼容端点，开箱可用。

## 结构与文档

`packages/core`（核心 + 内置模块，零运行时依赖）· `packages/cli`（交互式终端）· `apps/*`（内置 BlockApp，含 `apps/memory_letta` 外部记忆对接、依赖隔离）· `doc/`（[使用与开发文档](./doc/README.md)）。技术栈：Node 24 · TypeScript · vitest。

## 状态

已实现：核心闭环、内置模块、交互式终端、模块的发现与装卸（含热卸载）、模块间按契约协作（声明接口 + 每轮渲染前按契约取数）、外部语义记忆对接（真实 Letta / 百炼 DashScope 跑通）。测试全绿：core 274 · cli 88 · memory_letta 44。

## License

[MIT](./LICENSE) © 2026 zzer and BlockAgent contributors
