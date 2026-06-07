# block-agent

[English](./README.en.md) · **简体中文**

[![CI](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Zz-er/BlockAgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> 能力 = f(权重, 上下文)。权重你改不了，上下文你完全可控。block-agent 的命题：把上下文做成**可独立演化的模块化结构**——agent 的演进来自重组上下文，而不是重写架构。

一个 agent 的行为由两个变量决定：训练好的权重（固定），和每一轮提供给它的上下文（可塑）。能改进的只有后者。多数框架把上下文当作一段临时拼接的文本，改一处往往牵动全局，越往后越难维护。block-agent 把它当作一个有结构、有边界、可组合的系统来管理。

## 命题

- 可改进的是上下文，不是权重。问题因此变成：如何让上下文**持续演化而不腐化**。
- 解法是模块化——把上下文拆成各自独立、各管一片能力的单元：**BlockApp**。
- 迭代一个 agent，等于增删、替换、重组这些单元，而不必改动它的内核。

## 可独立演化的模块化上下文

- 每个 BlockApp 封装一片能力（对话、记忆、工具、身份、任务……），独立开发、独立替换、互不牵连。
- 模块之间**通过各自声明的接口对接**，不触碰彼此内部。替换一个模块的实现，依赖它的模块无需改动——例如把一种记忆实现换成另一种，agent 侧没有任何改动。
- 内置模块与你写的模块**同形**，没有特权内核。

## 自我演化的路径

把两点合起来——能力的可塑部分全在上下文，而上下文是可增减、可替换的模块——agent 的"变强"就被还原成一个明确的操作：重组自己的模块，而不是重写自己的架构。

- agent 今天已经在持续重塑自己的上下文：通过模块开放的操作写入记忆、登记任务、调整它下一轮看到的世界。这是自我演化的初级形态。
- 自然的延伸是：既然新增一种能力只等于新增一个模块，这条路径的终点就是 agent 自行产出模块、扩展自己。
- 难点从不在"让它写"，而在"让它在边界内写"。边界——唯一的状态入口、统一鉴权、agent 不可改写自身约束——是这套设计的前提，而非补丁。安全的自我扩展被当作结构问题来解，这正是模块化与受约束操作要换取的东西。

## BlockApp：一个有状态的上下文程序

BlockApp 不是静态内容，而是一个小程序。开发它，你描述四件事：

1. **状态与演化**——它持有什么状态，状态如何随操作改变。
2. **呈现**——这些状态如何成为 agent 看到的上下文。
3. **操作**——它对外开放哪些操作；这是它接口的主动面，由 user、agent、其他模块或外部系统共同使用。
4. **契约**——它声明依赖、提供哪些能力；其他模块据此与它对接，而非依赖它的身份或内部实现。

> 例：一个统计模块声明它需要"消息数""任务数"；消息模块与任务模块各自声明提供这两项。框架按声明把它们接起来。替换消息模块的实现，统计模块不受影响。

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

开发自己的模块见 [文档](./doc/README.md)。

## 快速开始（以 DeepSeek 为例）

```bash
npm install
```

API key 只从环境变量读，不写入配置、不入库。在仓库根放一个 gitignored 的 `.env`：

```bash
# openai-compat 类 provider（含 DeepSeek / 百炼）统一读 OPENAI_API_KEY
OPENAI_API_KEY=sk-你的key
```

选模型并启动：

```bash
npm start -- --provider openai-compat --model deepseek-chat --base-url https://api.deepseek.com

# 没有 key 也想看它跑（离线，不联网）：
npm start -- --dry-run
```

交互式终端：直接输入 = 给 agent 发消息；`/` 开头 = 命令（`/help`、`/apps`）。也可用仓库根 `block-agent.config.json` 写死配置；优先级 flags > 配置文件 > env > 默认。换 Anthropic 或任意 OpenAI 兼容端点（Ollama / vLLM / 百炼）只需改 provider 与 base_url。

## 原则

- 状态的每一次改变都经由唯一入口、统一鉴权——agent 能做什么，是一个可审计、可约束的有限集合。
- agent 的行为只能是受约束的操作，不能是自由文本；这也是抗注入的底线。
- 上下文的呈现是确定的：相同输入产出相同结果，因而可被缓存复用。
- agent 不能改写自身约束，也不能装卸模块。
- 模型无关：Anthropic 与任意 OpenAI 兼容端点，开箱可用。

## 结构与文档

`packages/core`（核心 + 内置模块，零运行时依赖）· `packages/cli`（交互式终端）· `packages/memory-letta`（外部记忆对接，依赖隔离）· `doc/`（使用与开发文档）。技术栈：Node 24 · TypeScript · vitest。

## 状态

已实现：核心闭环、内置模块、交互式终端、模块生命周期（含热卸载）、模块间契约协作（声明接口 + 渲染前按契约取数）、外部记忆对接（真实 Letta / 百炼 DashScope 跑通）。测试全绿：core 274 · cli 88 · memory-letta 44。

## License

[MIT](./LICENSE) © 2026 zzer and BlockAgent contributors
