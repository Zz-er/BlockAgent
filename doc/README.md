# block-agent 使用者文档

这里是 block-agent 面向**使用者 / app 开发者**的教学文档（中文）。

block-agent 是一个通用 agent runtime：它把进入 LLM 的上下文组织成一棵**块树（BlockTree）**，每一片功能都是一个可装可卸的 **BlockApp**。内置的对话历史、工具、记忆、身份都是 BlockApp，第三方扩展也走完全相同的形态——没有"内核特权 app"。

## 文档索引

| 文档 | 讲什么 | 适合谁 |
|---|---|---|
| [blockapp-development.md](./blockapp-development.md) | **怎么开发一个 BlockApp**：AppManifest 各字段、state + state_schema、builder（投影块）、command（命令）、命名约定，含一个最小可跑示例 app | 想写自己 app 的开发者 |
| [blockapp-lifecycle.md](./blockapp-lifecycle.md) | **BlockApp 的一生**：怎么被发现 / 安装 / 更换 / 卸载，CLI 里 `/apps` 与 `/app` 命令怎么用，热卸载与安全原则 | 想装卸/管理 app 的使用者 |
| [builtin-apps.md](./builtin-apps.md) | **5+1 个内置 app 介绍**与用法，尤其 `memory_letta`（外部 Letta 语义记忆库）原理 + Docker/百炼接法 | 想用内置能力、想接长期记忆的人 |

## 一分钟跑起来

```bash
# 在仓库根目录。真实 LLM 需要 key（从环境变量读，绝不写进配置文件）：
$env:ANTHROPIC_API_KEY = "<你的 key>"          # PowerShell
export ANTHROPIC_API_KEY=<你的 key>            # bash
npm start

# 没有 key 也想看它跑：用离线 mock provider（脚本化回一句话）
npm start -- --dry-run
```

启动后是一个交互式终端：直接打字 = 给 agent 发消息；以 `/` 开头 = 斜杠命令（`/help` 看全部）。

## 几条贯穿全局的原理（读任何文档前先记住）

- **commands-only**：agent 的每个动作都必须是一次**命令调用**（结构化 tool call）。纯文本不算动作——会被拒绝并作为错误反馈给它。
- **块树 + 投影**：app 不直接往 prompt 里塞字符串；它声明 **builder**，由 builder 把 app 自己的 state **投影**成块（block），renderer 每轮把块树渲染成 prompt。渲染是**纯函数**（同样的树→同样的字节），这是 prompt cache 命中的基础。
- **命令是唯一的写入口**：user / agent / app 三方都通过同一组命令改状态，全部经过 `Operations` 这个唯一闸口（里面有 `PolicyEngine` 鉴权，绕不开）。
- **安全分流**：内置 + 审核过的 app 是"可信 in-process"；不可信的第三方 / agent 自写 app 走沙箱（这部分是后续里程碑）。
