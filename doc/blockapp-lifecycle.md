# BlockApp 的一生：发现 / 安装 / 更换 / 卸载

这篇帮你理解一件事：在 block-agent 里，一块能力是怎么从"可装的候选"走到"在线运行"、再到"卸下归档"的，以及你在终端里怎么操作这整个过程。

背后有一条贯穿全文的设计取向：**装什么、卸什么，永远是操作者（人）的决定，agent 没有这个能力**。运行时不会因为某段代码躺在某个目录里就自动把它跑起来。理解了这条，下面所有行为就都顺理成章了。

---

## 1. 全景：一块能力的几种状态

```
  [可装候选]      ──发现──▶  [校验]  ──接纳──▶  [已注册]  ──接线──▶  [已安装 / 活跃]
 (清单里列出)              (声明              (进运行时,        (参与上下文呈现 +
                          合法?)             建好索引)         可被调用)
                                                                   │ 卸载
                                                                   ▼
                                                          [已卸载 / 归档]
                                                       (呈现的内容撤下,索引回收,
                                                        本地数据原地保留)
                                                                   │ 物理删除(显式·需更高权限)
                                                                   ▼
                                                              [彻底删除]
```

这里有个值得记住的分界：**接纳**和**接线**是两步。接纳，是把一块能力的声明校验通过、纳进运行时、建好索引——纯内存、立即完成。接线，是让它真正开始干活——把它要呈现的内容种进上下文、把它的命令并进给 agent 的工具目录、接上它和别的模块协作的通路。接线需要那道统一的写入关口已经就位，所以由启动流程来完成。

---

## 2. 发现：运行时怎么知道有哪些能力可装

block-agent 的取向是**配置清单说了算，再加一份只读的候选目录**，**绝不自动扫描后自动安装**——这是为了守住安全：不可信的代码不会因为放在某处就自动获得运行的机会。

- **权威清单 = `block-agent.config.json` 的 `apps` 段**。装哪些、开关，都在这里：

  ```json
  {
    "apps": {
      "agent_identity": { "enabled": true },
      "messages":       { "enabled": true },
      "tools":          { "enabled": true },
      "memory":         { "enabled": true },
      "task":           { "enabled": true },
      "memory_letta":   { "enabled": false },
      "stats":          { "enabled": false }
    }
  }
  ```

- **可装候选目录** = 一份内置能力的元数据表：列出每个内置模块的 id、一行简介、默认开关、前置依赖。`/apps` 里"可装"那一段就来自它。这只是**只读元数据**，看一眼不会触发安装。
- 启动参数也能开关（`--no-tools` 关工具、`--memory-letta` 开 Letta，等等），优先级 **参数 > 配置文件 > 环境变量 > 默认**。

---

## 3. 在终端里操作

### `/apps` —— 两段视图

列出**已装**（id / 版本 / 它呈现什么 / 它有哪些命令，只允许使用者调的会标注）和**可装**（候选目录里有、当前没装的）：

```
> /apps
  Installed (5):
    agent_identity v1.0.0  blocks: agent_identity:identity  commands: agent_identity.set (user-only)
    messages       v1.0.0  blocks: messages:summary, messages:recent  commands: messages.chat, messages.ingest, ...
    tools          v1.0.0  blocks: tools:recent  commands: tools.read_file, tools.grep, tools.bash, ...
    memory         v1.0.0  blocks: memory:pinned, memory:notes, memory:user, memory:recalled  commands: memory.remember, ...
    task           v1.0.0  blocks: task:list  commands: task.add, task.complete, task.reopen, ...
  Available to install (2):
    memory_letta           对接外部 Letta 服务器，实现跨会话语义记忆。  default: disabled
    stats                  概览：按契约汇总消息数与待办数，默认隐藏。  default: disabled
```

> （`blocks:` / `commands:` 是终端的真实输出标签——块名形如 `<模块>:<片名>`，命令名形如 `<模块>.<命令>`，标 `(user-only)` 的只允许使用者调。）

### `/app <子命令>` —— 生命周期操作

一个命令，五个子命令。**它们全都只允许使用者调**——原因见 §5。

| 子命令 | 实际行为 |
|---|---|
| `/app info <id>` | 只读：已装的显示版本 / 呈现什么 / 有哪些命令，未装的显示候选简介 / 默认开关 / 前置依赖。 |
| `/app install <id>` | 校验 id 在候选目录里，然后**写配置**把它标为启用，提示 **⚠ 重启生效**。（运行时热装是后续里程碑；现在装侧走重启。） |
| `/app uninstall <id>` | **热卸载**（无需重启，立即生效）：把它从运行时移除、它呈现的内容从上下文撤下、它的命令从工具目录去掉；**同时**写配置标为禁用（重启后也不再装）。 |
| `/app swap <a> <b>` | 写配置（关 a、开 b），提示重启。语义 = 用 b 接替 a 的职责（如换记忆后端）。**默认不迁移数据**（两后端存的东西结构不同）。 |
| `/app purge <id>` | **破坏性**：物理删除该模块的本地数据目录。默认**禁用**——要在配置里设 `allow_purge: true` 才出现；可用时还要**二次确认**。见 §6。 |

示例：

```
> /app uninstall tools
  Hot-uninstalled 'tools'. Removed blocks: tools:recent.
  Wrote apps.tools.enabled=false to block-agent.config.json.

> /app swap memory memory_letta
  Plan: uninstall 'memory', install 'memory_letta'.
  Wrote apps.memory.enabled=false, apps.memory_letta.enabled=true to block-agent.config.json.
  ⚠ Restart to take effect.
```

> 想直接调某个运行时命令（而不是做生命周期操作），用 `/cmd <模块.命令> [json]`，例如 `/cmd memory.remember {"target":"notes","content":"x"}`。`/help` 列出全部斜杠命令。

---

## 4. 热卸载为什么要等一个"安全窗口"

热卸载会在运行时改动正在生效的东西——撤下呈现的内容、改命令目录。如果在 agent **正跑到一半**的时候动手，会破坏"同一份状态总呈现出同样内容"的保证，甚至直接出错。所以热卸载走一个**安全窗口**：

1. **等当前所有排队的回合跑完**。
2. **确认运行时确实闲下来了**——如果 agent 正忙，直接返回"忙"，让你稍后重试，绝不硬插。
3. **卸载期间把新来的唤醒事件排队**（不丢、也不并发），等卸载完再放行。
4. 然后才依次：把它呈现的内容撤下（同样经过统一的写入关口，不是抄近路）→ 从运行时卸下（跑一次优雅断开）→ 重建命令目录。
5. 完成后清掉标志、回放排队的唤醒。

结果是：卸载这件事是原子的、可观察的，绝不在呈现中途动手。

---

## 5. 一条硬约束：agent 永远不能装 / 卸模块

`/app` 这一系列**只允许使用者调，根本不进 agent 的工具目录**——agent 看不到、也调不到它们。装、卸、换一块能力，是操作者（人）的决策，不是 agent 的能力。

这和"agent 改不了自己的身份"是同一条防线（防自我提权、防越狱）。同理，所有模块的"改配置"命令也都只允许使用者调——agent 改不了自己的预算上限、历史条数、记忆容量、后端选择。

---

## 6. 卸载之后，数据去哪了（删除即归档）

卸载 ≠ 销毁。三类数据分别处理：

| 数据 | 在哪 | 卸载默认怎么处理 |
|---|---|---|
| 呈现进上下文的内容 | 上下文里 | **回收**：从索引移除、内容归档（不物理擦除） |
| 本地数据文件 | 该模块的本地目录 | **原地保留**——不删。同 id 再装回来即接着用旧数据 |
| 外部存储 | 如 Letta 服务器上的记忆 | **断开不删**——优雅断开只关连接，block-agent 无权擅删外部数据 |

**物理删除是单独的 `/app purge`**：要先在配置里设 `allow_purge: true` 开启，再加二次确认，才会删掉该模块整个本地数据目录。这是"删除即归档"原则下一条显式的例外路径，和日常卸载分得清清楚楚。

```
> /app purge tools
  /app purge is disabled. Set allow_purge:true in block-agent.config.json to enable it.
  WARNING: purge deletes ALL local data for the app and cannot be undone.

# 配置里设了 allow_purge:true 后：
> /app purge tools
  WARNING: /app purge tools will delete ALL local data for app 'tools' (this cannot be undone).
  Re-run with confirmation: /app purge tools yes

> /app purge tools yes
  Purged ALL local data for 'tools': deleted .../.block-agent/apps/tools.
```

> 注意：purge `memory_letta` 只删**本地目录**，不会删 Letta 服务器上的记忆（那是外部系统的数据，block-agent 不擅动）。

---

## 7. 更换（swap）：换一个提供同样职责的模块

`/app swap <a> <b>` 在语义上 = "停掉 a、启用 b"，用来换提供同类职责的后端（典型：内置 `memory` ↔ 外部 `memory_letta`）。它就是**有序的一次卸载 + 一次安装**，不是某个底层的"原子替换"原语。

为什么换得这么干脆？因为**模块之间是按声明的契约协作的，不互相点名**。比如待办按 `task_count` 契约报出未完成数、概览按这个契约去取——概览压根不知道是谁在提供这个数。所以换掉提供方，依赖它的那些模块一个字都不用改。swap 就是这套"绑契约不绑身份"取向的直接体现。

- 两个模块各占各的命名空间，技术上能共存；swap 的意义是切换，不是同名顶替。
- **数据默认不迁移**：两个后端存的东西结构不同，自动迁移会丢信息。被换下的那个，数据按 §6 归档保留，将来装回即见。

---

## 8. 小结

- 装什么由 **配置清单**说了算；`/apps` 看已装 + 可装；`/app` 管生命周期。
- 现状：**install / swap 写配置 + 重启**，**uninstall 热卸载即时生效**，**purge 是显式的破坏性操作**。
- agent 永远不能装 / 卸模块；卸载默认归档不删；物理删除走 purge + 更高权限 + 二次确认。
- 想写自己的模块 → [blockapp-development.md](./blockapp-development.md)；想了解内置模块 → [builtin-apps.md](./builtin-apps.md)。
