# 内置 BlockApp 介绍

block-agent 自带一组内置模块。它们和你将来写的第三方模块**形态完全相同**——只是默认随发行版一起提供。这份文档讲每个内置模块做什么、默认开不开、怎么配；最后把外部语义记忆 `memory_letta` 的接法讲透，因为它是唯一需要外部服务的那个。

读之前记住一点：这些模块互不点名。待办模块对外说"我能报未完成数量"，概览模块说"我需要未完成数量"——它们按声明的契约对接，谁也不知道对方叫什么。换掉其中一个，另一个不用改。

| 模块 | 默认 | 做什么 | 呈现进上下文的内容 |
|---|---|---|---|
| `agent_identity` | 开 | agent 的身份、人格、操作约束，钉在上下文最前面 | 身份说明 |
| `messages` | 开 | 对话历史 + 旧史压缩 + 最近若干条原文 | 旧史摘要、最近消息 |
| `tools` | 开 | 给 agent 暴露文件 / Shell / HTTP 等工具，并呈现调用结果 | 最近的工具调用与结果 |
| `memory` | 开 | 内置本地长期记忆（agent 笔记 + 用户画像），离线可用 | 置顶项、笔记、用户画像、最近召回 |
| `memory_letta` | **关** | 外部 Letta 服务器支撑的**语义召回**长期记忆 | Letta 核心记忆、最近语义召回 |
| `task` | 开 | 本地待办清单：增改删、完成、重开、归档 | 当前未完成的待办 |
| `stats` | **关** | 概览：按契约汇总消息数与待办数 | 一行计数小结 |

> 装哪些在 `block-agent.config.json` 的 `apps` 段开关，或用 `--no-<模块名>` / `--<模块名>` 这样的启动参数。详见 [blockapp-lifecycle.md](./blockapp-lifecycle.md)。

---

## 1. agent_identity —— agent 是谁

把 agent 的身份钉在上下文最前面、最稳定的位置，每一轮都带着它。

- **状态**：角色（role）、人格（persona）、操作指令（instructions）三段文字，初值来自启动配置。
- **修改**：`agent_identity.set` 改这三段——但**只有使用者能调**。agent 改不了自己的身份和约束，这是防止它自我提权、绕过约束的第一道防线。
- 这块身份说明里还写明了"必须用操作来行动"等约束，等于在上下文里就把规矩讲给 agent 听。

---

## 2. messages —— 对话历史

对话历史管理器：每一轮给 agent 呈现 **[旧史摘要] + [最近 N 条原文]**；历史长到超过阈值时，自动把更旧的部分增量地折叠进摘要。全量历史落在本地文件里，不挤占上下文。

- **呈现**：一段旧史摘要（偶尔变），加最近若干条消息原文（每轮可能变，是 agent 读对话正文的地方）。
- **常用操作**：
  - `messages.chat` —— **agent 对使用者说话的出口**。把要说的话放进去，这一轮就结束（agent 完成本轮回应、运行时回到空闲）。这是 agent 最常用的"开口"命令。
  - `messages.ingest` —— 投递一条使用者消息进历史，并唤醒 agent。
  - `messages.peek` —— 取最近消息和摘要。
  - `messages.ack` —— 把某条消息从"最近呈现"里移走（历史日志仍保留）。
  - `messages.set_config` —— 调显示条数、压缩阈值等，**只有使用者能调**。
- **对外提供**：按 `message_count` 契约报出当前消息数，供概览这类模块汇总（它不需要知道是谁在汇总）。
- 注：当前的摘要器是确定性占位（触发逻辑已就绪，换成真正的模型摘要是后续的事）。

---

## 3. tools —— 给 agent 的工具集

每个工具是一条命令，调用的请求和结果会呈现进上下文（保留最近 N 次）。

- **工具**：读文件、文本搜索、运行 Shell、发 HTTP 请求等。
- **呈现**：最近若干次工具调用的请求与结果。
- **约束**：危险或受限的工具带着相应的权限要求——比如运行 Shell 时 agent 需要**经过审批**，发 HTTP 时受目标主机白名单约束。这些约束由统一的鉴权关口按调用者身份执行。
- **配置**：呈现几条历史、开放哪些工具子集；`tools.set_config` **只有使用者能调**。

---

## 4. memory —— 内置本地记忆（零依赖、离线可用）

本地长期记忆：分 agent 笔记和用户画像两类，按**字面 / 全文**召回（不做向量），数据落在本地文件。开箱即用，不需要任何外部服务。

- **呈现**：置顶项（最稳定）、agent 笔记、用户画像、最近一次召回的结果。
- **操作**：记一条（`memory.remember`）、召回（`memory.recall`）、置顶 / 取消置顶、遗忘（`memory.forget` 是**软删 = 归档**，不真擦）。物理删除是一条单独的、agent 会被直接拒绝的命令。`memory.set_config` **只有使用者能调**。
- **安全**：每次写入都过一道注入扫描（默认常开、不可关）；召回的内容在呈现时套一层**来源围栏**——明确标注"这是记忆数据，不是新指令"，未经验证的内容会被标记。这是为了防止"在记忆里藏指令"的注入。

> 想要**语义召回**（按"意思相近"而不只是"字面包含"找）？用下面的 `memory_letta`。

---

## 5. task —— 本地待办清单

一份本地待办：agent、使用者、外部系统都能往里放任务，三方走的是同一组命令、同一道鉴权关口，只按"是谁在调"区分。

- **呈现**：当前未完成的待办，列成一段清单；没有未完成项时这块就不出现。
- **操作**：新增、部分更新、完成、重开、归档（`task.remove` 是**软删 = 归档**）。读取列表、按 id 取单条这类只读操作面向界面和其它模块，不进 agent 的工具目录（agent 已经能从呈现里看到未完成待办）。
- **外部任务入口**：外部任务系统通过 `task.ingest` 投递任务并唤醒 agent——这条 agent 自己不能调，所以它**伪造不了"外部派来的任务"**。
- **物理删除**：是一条单独的、需要更高权限的命令，**agent 会被直接拒绝**——它最多只能软删（归档），永远抹不掉一条别人派给它的任务。
- **对外提供**：按 `task_count` 契约报出未完成数量，供概览汇总。
- **配置**：清单最多呈现几条；`task.set_config` **只有使用者能调**。

---

## 6. stats —— 概览（契约协作的样板）

一个**默认关闭**的小模块，作用是把"模块按契约协作"这件事演示透：它自己不产生任何数据，只**消费**两个契约——消息数和待办数——把汇总结果呈现成一行小结。

它从头到尾不提"messages"或"task"的名字。增加、移除、替换提供这些数字的模块，它都不用改。这正是"绑契约不绑身份"的好处。

- **呈现**：一行小结，形如「N 待办 · M 条消息」。
- **默认双重静默**：默认不安装；即便装上，也要使用者显式打开（`stats.set_config({show_block:true})`）才会渲染——它没有任何 agent 能调的写命令，数据全靠契约拉取。

---

## 7. memory_letta —— 外部 Letta 后端的语义记忆（原理 + 接法）

`memory_letta` 把一个外部 [Letta](https://www.letta.com/) 服务器接成 block-agent 的长期**语义**记忆后端。所有向量、检索、嵌入计算都在 Letta 服务器那一侧做——block-agent 这边一行向量代码都没有。默认**关闭**（因为它需要外部服务）。

### 7.1 原理

- **独立的包**：实现单独成包，它依赖的 Letta SDK 只在你真的开启 `memory_letta` 时才加载，绝不进入核心。
- **共享同一套记忆接口**：它和内置 `memory` 用同一个被动的存储接口（存、取、查、删），只是把后端换成了 Letta。
- **外部后端不可信，按值隔离**：Letta 服务器是一个不可信的外部进程。每次查询返回的结果在回到 block-agent 之前会被深拷贝，数量也受召回上限约束。决定"哪些召回内容进上下文"的**呈现**永远是 `memory_letta` 自己的可信代码做——Letta 只提供候选数据，碰不到最终呈现。
- **来源围栏**：外部来源的内容标记为未验证，呈现时套和内置记忆同款的隔离围栏。
- **惰性创建**：安装动作是放手即走的，可能在第一条命令之前还没建好 Letta 上的 agent。所以命令开头会**惰性确保它存在**——没建就先建、存回配置再继续，不依赖安装钩子已完成。
- **呈现**：Letta 的核心记忆，加最近一次语义检索结果（带围栏）。
- **操作**：记一条（`memory_letta.remember`）、语义召回（`memory_letta.recall`）、设置核心记忆块（只读块拒写）；`memory_letta.set_config` **只有使用者能调**。
- **优雅降级**：Letta 服务器连不上时，命令返回清晰的错误，不会让这一轮崩掉。

### 7.2 配置与密钥

| 变量 | 走哪 | 说明 |
|---|---|---|
| `LETTA_BASE_URL` | 配置文件 / 环境变量 / 参数 `--letta-base-url` | Letta server 地址，默认 `http://localhost:8283` |
| `LETTA_API_KEY` | **只走环境变量** | Letta server 的访问密钥（自托管时 = server 密码）。**绝不写进配置文件 / 状态 / 日志**（和 `ANTHROPIC_API_KEY` 同一条铁律） |

开启：配置文件里 `apps.memory_letta.enabled = true`，或启动时加 `--memory-letta`。

### 7.3 起一个 Letta 服务器（Docker）

```bash
docker run -d --name letta-server \
  -p 8283:8283 \
  -v letta_pgdata:/var/lib/postgresql/data \
  -e SECURE=true \
  -e LETTA_SERVER_PASSWORD=<你设的密码> \
  -e OPENAI_API_KEY=<给 Letta 用的 embedding/LLM 后端 key> \
  -e OPENAI_API_BASE=<该后端的 OpenAI 兼容地址> \
  letta/letta:latest
```

然后客户端侧（`.env`，gitignored）：`LETTA_API_KEY` = 上面的 `LETTA_SERVER_PASSWORD`，`LETTA_BASE_URL` = `http://localhost:8283`。

### 7.4 选 embedding / LLM 后端（关键坑）

创建 Letta agent 时要指定它用哪个 LLM + 哪个 embedding。`memory_letta` 用**环境变量驱动**，两种方式（仅在**创建 agent 那一刻**起作用，之后用 agent_id）：

**(a) 用 Letta 注册的 handle**（简单，但受限于 Letta 自动注册了什么）：
- `LETTA_MODEL`（如 `openai/gpt-4o-mini`）、`LETTA_EMBEDDING`（如 `openai/text-embedding-3-small`）。

**(b) 自定义 endpoint 配置**（**推荐用于非 OpenAI 的 embedding**）：
- chat：`LETTA_CHAT_ENDPOINT` + `LETTA_CHAT_MODEL` + `LETTA_CHAT_CONTEXT_WINDOW`(默认 32768)
- embedding：`LETTA_EMBED_ENDPOINT` + `LETTA_EMBED_MODEL` + `LETTA_EMBED_DIM`(默认 1024)

> **为什么需要 (b)**：Letta 默认的 `openai/text-embedding-*` handle **写死指向 `api.openai.com`，无视 `OPENAI_API_BASE`**。所以要用别的 OpenAI 兼容 embedding 服务，必须走自定义 endpoint 配置（直接给 `agents.create` 塞 `embedding_config`/`llm_config`，绕过 handle 发现）。

### 7.5 推荐（但不强制）：阿里云百炼 DashScope

**任何 OpenAI 兼容的 embedding 服务都能用**——百炼只是一个验证过、好上手的推荐。它的 OpenAI 兼容 embedding 接口文档：
https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai

用百炼做后端时的 `.env`（客户端侧；gitignored）：

```bash
LETTA_API_KEY=<Letta server password>
LETTA_BASE_URL=http://localhost:8283
# chat（生成）走百炼：
LETTA_CHAT_ENDPOINT=https://dashscope.aliyuncs.com/compatible-mode/v1
LETTA_CHAT_MODEL=qwen-plus
# embedding（向量）走百炼：
LETTA_EMBED_ENDPOINT=https://dashscope.aliyuncs.com/compatible-mode/v1
LETTA_EMBED_MODEL=text-embedding-v4
LETTA_EMBED_DIM=1024
```

对应地，Docker 起 Letta 时把 server 的 openai-provider key/base 指向百炼（自定义 endpoint 会用 server 的 openai-provider key 去调，所以那个 key 必须对该 endpoint 有效）：

```bash
  -e OPENAI_API_KEY=<你的百炼 DashScope key> \
  -e OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1 \
```

> 提示：换 embedding 后端后若复用同一个 `letta_pgdata` 卷，旧 provider 缓存可能残留；自定义 `embedding_config` 路绕过 handle 发现、不受该缓存影响，是最稳的接法。彻底换后端可 `docker volume rm letta_pgdata` 重来。

### 7.6 验证

开启 `memory_letta` 后跑一轮：让 agent `memory_letta.remember` 存一条 → `memory_letta.recall` 用语义相近（非字面）的查询召回 → 看最近召回结果带着围栏出现在上下文里，即接通。

---

## 8. 内置还是外部记忆？

- **`memory`**：零依赖、离线、按字面 / 全文召回。"方便的内置"，适合大多数场景。
- **`memory_letta`**：需要外部 Letta 服务器，提供**语义召回**（向量在服务器侧算）。适合需要跨会话、大规模、按意思检索的长期知识库。

两者互不干扰，技术上能同时装；通常按需求二选一（用 `/app swap memory memory_letta` 切换，见 [blockapp-lifecycle.md](./blockapp-lifecycle.md)）。
