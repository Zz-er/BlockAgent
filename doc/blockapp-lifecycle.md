# BlockApp 生命周期：发现 / 安装 / 更换 / 卸载

本文讲一个 BlockApp 从"可装候选"到"卸载归档"的一生，以及在 CLI 里怎么操作。命令行为对照仓库里**真实已实现**的代码（`packages/cli/src/{app_catalog,commands,config,launch}.ts`、`packages/core/src/app/registry.ts`）。

---

## 1. 全景：一个 app 的状态

```
  [可装候选]      ──发现──▶  [校验]  ──注册──▶  [已注册]  ──接线──▶  [已安装/活跃]
 (catalog 列出)             (manifest         (进内存表,       (参与渲染 + 命令,
                            合法?)            建索引)          在工具目录里)
                                                                   │ 卸载
                                                                   ▼
                                                          [已卸载/归档]
                                                       (投影块软删,索引回收,
                                                        磁盘数据原地保留 INV#5)
                                                                   │ purge(显式·需 capability)
                                                                   ▼
                                                              [物理删除]
```

关键：**注册（register）** 和 **安装（install）** 是两段。

- **register**：纯内存、同步——把 manifest 校验后接纳进 `AppRegistry`（建实例、建 builder 索引、跑 `on_install`）。
- **install 接线**：让 app 真正参与运行——把它的投影块种进树（seedProjectionBlocks，经 `Operations` 走鉴权闸）、并入给 agent 的**工具目录**、接上跨 app 调用 / 唤醒等 seam。这部分需要 `Operations` 已存在，所以由 launcher 在 boot 流程里完成。

---

## 2. 发现（discovery）：runtime 怎么知道有哪些 app 可装

block-agent 用**配置清单为权威 + 静态 catalog 列可装**，**绝不自动扫描后自动装**（守安全：不可信代码不会因为躺在某个目录就自动获得执行）。

- **权威清单 = `block-agent.config.json` 的 `apps` 段**。装哪些、开关在这里：

  ```json
  {
    "apps": {
      "agent_identity": { "enabled": true },
      "messages":       { "enabled": true },
      "tools":          { "enabled": true },
      "memory":         { "enabled": true },
      "memory_letta":   { "enabled": false }
    }
  }
  ```

- **可装 catalog** = 一份内置 app 元数据表（`packages/cli/src/app_catalog.ts` 的 `BUILTIN_APP_CATALOG`）：列出每个内置 app 的 id / 一行简介 / 默认开关 / 前置依赖。`/apps` 的"可装"段就来自它。这只是**只读元数据**，不触发安装。
- 命令行 flag 也能开关（`--no-tools` 关 tools，`--memory-letta` 开 letta，等），优先级 **flag > 配置文件 > 环境变量 > 默认**。

---

## 3. CLI 操作

### `/apps` —— 两段视图

列出**已装**（id / version / 块名 / 命令，user-only 命令会标注）和**可装**（catalog 里有、但当前没装的）：

```
> /apps
  Installed (4):
    agent_identity v1.0.0  blocks: agent_identity:identity  commands: agent_identity.set (user-only)
    messages       v1.0.0  blocks: messages:recent, messages:summary  commands: messages.reply, messages.ack, ...
    tools          v1.0.0  blocks: tools:recent  commands: tools.read_file, tools.grep, tools.bash, ...
    memory         v1.0.0  blocks: memory:notes, memory:pinned, memory:recalled, memory:user  ...
  Available to install (1):
    memory_letta           对接外部 Letta 服务器，实现跨会话持久化归档记忆与语义搜索。  default: disabled
```

### `/app <子命令>` —— 生命周期操作

一个命令，五个子命令。**全部是 invoker=user 的斜杠命令**——见 §5 的安全原则。

| 子命令 | 实际行为（v1） |
|---|---|
| `/app info <id>` | 只读：已装的显示 version/blocks/commands，未装的显示 catalog 简介/默认/前置。 |
| `/app install <id>` | 校验 id 在 catalog 里，然后**写配置** `apps.<id>.enabled=true`，提示 **⚠ 重启生效**。（运行时热装是后续里程碑；v1 装侧走重启。） |
| `/app uninstall <id>` | **热卸载**（无需重启，立即生效）：把 app 从 registry 移除、投影块从树里软删、工具目录去掉它的命令；**同时**写配置 `enabled=false`（重启后也不再装）。 |
| `/app swap <a> <b>` | 写配置（`a`=false、`b`=true），提示重启。语义 = 用 b 替代 a 的职责（如换记忆后端）。**默认不迁移数据**（两后端数据模型不同）。 |
| `/app purge <id>` | **破坏性**：物理删除该 app 的本地数据目录 `<storage>/.block-agent/apps/<id>/`。默认**禁用**——要在配置里设 `allow_purge: true` 才出现；可用时还要**二次确认**。见 §6。 |

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

> 想直接调任意运行时命令（不是生命周期操作），用 `/cmd <app.command> [json]`，例如 `/cmd memory.remember {"target":"notes","content":"x"}`。`/help` 列出全部斜杠命令。

---

## 4. 热卸载的安全窗口（原理）

热卸载（`/app uninstall`）会在运行时改 registry 和块树。如果在 agent **正在跑一轮**的中途改，会破坏"同一棵树渲染出同样字节"的保证、甚至崩。所以热卸载经过一个**安全窗口执行器**：

1. **等当前所有排队的 turn 跑完**（`awaitTurnsSettled`）。
2. **断言 runtime 处于 idle**——如果 agent 正忙，返回 `busy`，让你稍后重试（不会硬插）。
3. **操作期间把新的唤醒事件排队**（不丢、不并发），等卸载完成后再放行。
4. 然后才依次：把投影块节点**软删**（经 `Operations`，走鉴权闸，不是旁路）→ 从 registry 卸载（跑 `on_uninstall` 优雅断开）→ 重建工具目录。
5. 完成后清标志、回放排队的唤醒。

结果：卸载是原子的、可观测的，绝不在渲染中途动手。

---

## 5. 安全原则：agent 永远不能装 / 卸 app

`/app` 系列是 **invoker=user 的斜杠命令**，**不进 agent 的工具目录**——agent 根本看不到、也调不到它们。装 / 卸 / 换 app 是操作者（人）的决策，不是 agent 的能力。这和"`agent_identity.set` 是 user-only、agent 改不了自己身份"是同一条防线（防自我提权 / jailbreak）。

同理，所有 `*.set_config`（messages / tools / memory / memory_letta 的配置命令）都是 user-only——agent 改不了自己的 token 预算、工具历史条数、记忆上限、后端选择。

---

## 6. 卸载的数据去留（INV #5「删除即归档」）

卸载 ≠ 销毁。三类数据分别处理：

| 数据 | 在哪 | 卸载（uninstall）默认 |
|---|---|---|
| 投影块节点 | 块树 | **回收**：索引删除、节点软删（归档，不物理擦） |
| 本地 jsonl | `.block-agent/apps/<id>/*.jsonl` | **原地保留**——不删。同 id 再装回即继续用旧数据 |
| 外部 store | 如 Letta server 上的 agent/passages | **断开不删**——`on_uninstall` 只关连接，block-agent 无权擅删外部数据 |

**物理删除是独立的 `/app purge`**：需要配置 `allow_purge: true` 开启 + 二次确认（命令后加 `yes`），才会删掉 `.block-agent/apps/<id>/` 整个本地目录。这是 INV #5 的显式例外路径，与日常卸载分开。

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

> 注意：purge `memory_letta` 只删**本地目录**，不会删 Letta 服务器上的 agent/passages（那是外部系统的数据，block-agent 不擅动）。

---

## 7. 更换（swap）

`/app swap <a> <b>` 在语义上 = "停掉 a、启用 b"，用来换提供同类职责的后端（典型：内置 `memory` ↔ 外部 `memory_letta`）。它就是**有序的 uninstall + install**，不是一个内核级"原子换"原语。

- 两者命名空间不同（`memory:*` vs `memory_letta:*`），技术上能共存；swap 的意义是切换，不是同名替换。
- **数据默认不迁移**：两后端存储模型不同（内置是 JSONL 笔记/画像二分，Letta 是 core block + archival passages），自动迁移会丢信息。a 的数据按 §6 归档保留，将来装回即见。

---

## 8. 小结

- 装什么由 **config 清单**说了算；`/apps` 看已装+可装；`/app` 管生命周期。
- v1：**install / swap 写配置 + 重启**，**uninstall 热卸载即时生效**，**purge 显式破坏性**。
- agent 永远不能装/卸 app；卸载归档不删（INV #5）；物理删走 purge + capability + 确认。
- 想写自己的 app → [blockapp-development.md](./blockapp-development.md)；想了解内置 app → [builtin-apps.md](./builtin-apps.md)。
