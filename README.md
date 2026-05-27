# block-agent

> 一个通用单-agent runtime：进入 LLM 的**全部上下文是一棵块树（BlockTree）**，每一片功能都是一个可装可卸的 **BlockApp**，而**命令（tool call）是唯一的状态写入口**。

block-agent 把"agent 的上下文/能力"做成统一的、可插拔的结构：对话历史、工具、记忆、身份——全是 BlockApp，第三方扩展走**完全相同**的形态，没有"内核特权 app"。

## 核心理念

- **块树 + 投影**：app 不直接往 prompt 塞字符串；它声明 **builder**，把自己的 state **投影**成块（block），renderer 每轮把块树渲染成 prompt。渲染是**纯函数**（同样的树 → 同样的字节）——这是 prompt cache 命中的基础。
- **commands-only**：agent 的每个动作都必须是一次结构化**命令调用**；纯文本不算动作（会被拒绝并作为反馈喂回）。这也是抗 prompt-injection 的底线。
- **命令是唯一写入口**：user / agent / app 三方共用同一组命令，全部经过唯一闸口 `Operations`（内含 `PolicyEngine` 鉴权，绕不开）。
- **BlockApp 生命周期**：app 可发现 / 安装 / 更换 / 卸载（CLI 里 `/apps`、`/app …`）；**agent 永不能装卸 app**（防自我提权）。
- **多 Provider day-1**：Anthropic + 任何 OpenAI 兼容端点（DeepSeek / 百炼 DashScope / Ollama …）。
- **思考不进上下文**：LLM 的 reasoning 经事件通道给 UI 订阅，**不写入块树**。

## 快速开始（以 DeepSeek 为例）

```bash
npm install
```

**① 放 API key**——key 只从环境变量读（绝不写进配置文件 / 不入库）。在仓库根建一个 gitignored 的 `.env`，启动时会自动加载（且覆盖同名的 shell 环境变量）：

```bash
# .env （仓库根，已被 .gitignore 忽略）
# 注意：openai-compat 类 provider（含 DeepSeek / 百炼）统一读 OPENAI_API_KEY
OPENAI_API_KEY=sk-你的DeepSeek-key
```

**② 选 DeepSeek**——在仓库根建 `block-agent.config.json`（也被 gitignore）：

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

**③ 跑**：

```bash
npm start

# 或不写配置文件，用命令行 flag（等价）：
npm start -- --provider openai-compat --model deepseek-chat --base-url https://api.deepseek.com

# 没有 key 也想看它跑：离线 mock provider（脚本化回一句话，不联网）
npm start -- --dry-run
```

启动后是交互式终端：直接打字 = 给 agent 发消息；`/` 开头 = 斜杠命令（`/help` 看全部，`/apps` 看已装/可装 app）。agent 思考完会**回复一次**，然后停下等你的下一条消息。

> **换别的模型**：`deepseek-reasoner`（带思考链）、Anthropic（`--provider anthropic --model claude-... ` + `ANTHROPIC_API_KEY`）、或任何 OpenAI 兼容端点（Ollama / vLLM / 百炼 …，改 `base_url` 即可）。配置优先级 **flags > 配置文件 > env > 默认**。

## 仓库结构（npm workspaces）

| 包 | 作用 |
|---|---|
| `packages/core` | 核心 runtime + 内置 app（agent_identity / messages / tools / memory）。**零运行时依赖**。 |
| `packages/cli` | 交互式 CLI（Ink / React）+ launcher。Ink/React 依赖隔离在此。 |
| `packages/memory-letta` | `memory_letta` BlockApp：对接外部 [Letta](https://github.com/letta-ai/letta) 服务器做语义召回长期记忆。Letta SDK 依赖隔离在此，**绝不进 core**。 |
| `doc/` | 面向使用者 / app 开发者的中文教学文档。 |

技术栈：Node 24 · TypeScript（strict / NodeNext / ESM）· tsx 直跑源 · vitest。

## 文档

详见 **[`doc/`](./doc/README.md)**：

- [如何开发一个 BlockApp](./doc/blockapp-development.md)（含最小可跑示例）
- [BlockApp 生命周期](./doc/blockapp-lifecycle.md)（发现 / 安装 / 更换 / 卸载 + CLI 操作）
- [内置 BlockApp 介绍](./doc/builtin-apps.md)（含 `memory_letta` 原理 + 接百炼 DashScope 的方法）

## 状态

v3.0 核心闭环 + 内置 app + 交互式 CLI + BlockApp 生命周期 v1（含热卸载）+ memory_letta（真实 Letta + 百炼 DashScope e2e 跑通）。测试：core 181 / cli 60 / memory-letta 44 = **285** 全绿。
