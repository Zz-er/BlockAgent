---
name: maintain-memory
description: 指导 agent 在上下文压力上升时将耐久事实蒸馏进 memory，以便跨回合保留。
allowedTools: [memory.remember, memory.recall, memory.pin, memory.unpin, memory.forget]
---

# 维护记忆

当上下文压力 nudge 出现（`# 上下文压力` 块）时，你应该把当前回合中需要长期保留的耐久事实蒸馏进 memory。

## 什么时候做

- 上下文压力 ≥ 70% 时：检查 `base:recent` 中最旧的即将滚出的操作，把其中需要跨回合保留的事实写进 memory
- 用户明确告诉你的事（偏好、约束、背景）— 随时可以写，不一定要等 nudge

## 怎么做

### 写记忆

```
memory.remember({ target: "notes", type: "feedback", content: "...", name: "short-label", description: "one-line summary" })
```

- `target` = `"notes"` 用于一般记忆，`"user"` 用于用户个人的事实/偏好
- `type` 按事实性质选：`"feedback"`（反馈/经验）、`"project"`（项目上下文）、`"reference"`（参考信息）
- `name` 是短标签（会在索引中显示），`description` 是一行摘要
- 压缩时优先选择：**概念、用户决策、环境约束** — 而非逐字转录

### 查记忆

```
memory.recall({ query: "关键词" })
```

写入前先查一下，避免重复存同样的东西。

### 管理记忆

- `memory.pin({ id })` — 把重要的记忆钉在 stable 区，常驻上下文
- `memory.unpin({ id })` — 取消钉住
- `memory.forget({ id })` — 软删除（归档），用于过时/错误的记忆

## 取舍

- **宁可少存、不要滥存** — 只存跨回合需要的事实，不存本次上下文已能看到的临时信息
- 每条记忆应该是一个原子事实，不要堆成巨长一段
- 蒸馏是 best-effort — 如果窗口中没有什么值得长期保留的，跳过即可
