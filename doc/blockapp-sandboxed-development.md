# 开发一个 BlockApp（统一模型：可信 / 沙箱）

先判断你要不要读这篇：如果代码是你自己写的、经过审计的**可信**代码，[blockapp-development.md](./blockapp-development.md) 的同进程写法就够了。**只有当代码不可信时**——第三方扩展、agent 自己产出、要装载你管不住的外部逻辑——才需要把它放进沙箱，也就是本篇。

> 这篇是 [blockapp-development.md](./blockapp-development.md) 的延伸：在**统一宿主模型**下，怎么写一个 app，并选择它跑在**同进程（可信）还是子进程（沙箱）**。
> 核心一句话：**只有一种 BlockApp。"同进程 vs 跨进程"不是两种 app，而是一个配置——由 `trust` 决定。** 你写的代码（manifest）两种情况几乎一样，AppContext 的接口完全一样。
> 设计依据：`ai_com/design/blockapp-unified-host-architecture.md`（架构）、`…-impl-spec.md`（工程规格）。

---

## 0. 先记住：一个 manifest，两种放置

```
                     trust: 'trusted'  ──▶  host: in-process   （直引用，零开销，进缓存）
你写的 AppManifest ──┤
                     trust: 'sandboxed' ─▶  host: child-process（子进程隔离，声明式投影）
```

- 你交付的还是**一个 `AppManifest`**（`apps/agent_identity/src/manifest.ts` 是最小范本）。
- `trust` 缺省 `'trusted'`——**老 app 一个字不用改**。
- `host` 缺省由 `trust` 派生，operator 可在 `block-agent.config.json` 微调；但 `sandboxed` **不能**被降级到同进程（安全约束）。

```ts
export function makeMyApp(): AppManifest {
  const m: AppManifest<MyState> = {
    id: 'my_app',
    version: '1.0.0',
    depends_on: [],
    tree_namespace: '/my_app',
    initial_state: { /* ... */ },
    state_schema: STATE_SCHEMA,
    builders: [/* ... */],
    commands: [/* ... */],
    // 新增（可选）：
    trust: 'sandboxed',          // 第三方 / agent 产出 / 任何不可信代码 → 子进程
    // host 省略：sandboxed 自动派生为 child-process
  };
  return m as AppManifest;
}
```

---

## 1. 可信 app（trusted）= 现状，不变

`trust:'trusted'`（或省略）的 app 与今天**完全一样**：

- builder 是纯函数 `state→block`，跑在渲染热路径（INV#16），进缓存。
- 命令直接在主进程跑、`ctx.set_state` 同步落 state。
- `ctx.read` 走 BlockView 零拷贝。

内置 7 个 app 全是这一档。把 `blockapp-development.md` 的范式照搬即可。**只有当你的代码不可信（第三方、agent 产出、要装外部不可控逻辑）时，才需要下面的沙箱写法。**

---

## 2. 沙箱 app（sandboxed）怎么写：四条约束

沙箱 app 跑在**子进程**里，渲染由主进程的可信通用 builder 代劳。所以你要换一套写法：

### 约束 1 — 不写 build，只产 state（声明式投影）
沙箱 app **不提供 builder 代码**。你只负责把"要呈现的那一片"放进 `state`（纯 JSON），主进程的通用投影 builder 会把它渲染成块。

```ts
// 可信 app：你写 builder
builders: [() => MyBlockBuilder],   // build(ctx, app_ctx) → Block

// 沙箱 app：你不写 builder，改声明"投影哪个 state 字段成哪个块"
projection: {                       // [沙箱 app 专用声明]
  block: 'my_app:view',             // 块名 <id>:<片名>
  from: 'display',                  // 投影 state.display 这一片
  // tier 固定 volatile、大小受配额限制（你管不了，安全约束）
},
```

> 为什么：不可信代码不能在渲染热路径上跑（既破字节确定渲染，又破进程隔离）。这正是 VSCode 扩展从不直接画 DOM、只声明式 contribute 的同款约束。

### 约束 2 — emit 只是"失效门铃"，不能 push 数据
沙箱 app 想让上下文刷新，用 `ctx.emit` 发一个**不带 render 数据**的信号即可；**权威数据永远由核心侧来 pull**（在渲染前同步取你 `set_state` 写好的值）。

```ts
// ✅ 对：set_state 写权威值（落核心侧 cell），emit 只敲门
ctx.set_state((s) => ({ ...s, display: nextView }));
ctx.emit('changed', null);          // 失效门铃，payload 不承载 render 数据

// ❌ 错：试图把 render 数据 push 给别的 app / 直接塞进上下文
```

> 为什么：渲染读的值必须在 snapshot 冻结前就确定（字节确定渲染 INV#1）。你 `set_state` 的值会被核心侧缓存，渲染时确定可得；异步 push 会让某一轮读到半新半旧，破坏缓存与确定性。

### 约束 3 — 命令仍是唯一写入口，且要过能力闸
和可信 app 一样，**任何变更都走命令**（`ctx.set_state` 或返回 `ops`）。但沙箱 app 的命令默认走**收紧的能力表**：

- 物理删块 / 改 pinned / 读凭据明文 → **直接拒**（不可信不给）。
- 危险操作 / 联网 → **需审批**（pending）。
- 你声明的 `capabilities` 会被按 `trust:'sandboxed'` 校验，超 ceiling 的命令**装不上**（install reject）。

> ✅ **状态**：这三件——能力 ceiling 的真实强制、install reject、跨进程沙箱载体——**都已落地**。沙箱（agent_authored）app 声明了超出 ceiling 的能力会在**安装时被拒**（不再是 report-only）；启动流程会为 `sandboxed` manifest fork 一个真实子进程（注入失败则 fail-closed 拒装、绝不降级回同进程），端到端有 fork 测试覆盖。**唯一还缺的是「随发行版附带的沙箱 app」**——内置 7 个全是可信，把一个沙箱 app 热装进来是 UH-3 的事。所以本节描述的是当前可依赖的行为，不是将来的目标。

所以：沙箱 app 声明能力要**最小化**，只要真正需要的；想要更高能力，就得让 operator 把它标成可信。

### 约束 4 — state 有界、JSON、受配额
和现状一样 state 必须纯 JSON、有界（大数据放磁盘/外部）；**额外**：沙箱 app 的 state 有**字节上限**，投影块有**大小上限**。超了 `set_state` 会被拒、块会被裁剪。别把全量数据塞进 state——它只是"要呈现的那个窗口"。

---

## 3. AppContext：跨进程也一样用

你在 command handler 里拿到的 `ctx` 接口**和可信 app 完全相同**（背后是 RPC 代理，对你透明）：

| 你调用 | 跨进程时的行为（你无需关心） |
|---|---|
| `ctx.state` / `ctx.set_state` | set_state 写回核心侧 cell（过 schema + 字节配额） |
| `ctx.invoke_command(full, args)` | 重过 PolicyEngine（跨 app 调用仍鉴权） |
| `ctx.read(name)` | 返回**深拷贝**（不是零拷贝 view） |
| `ctx.emit / ctx.on` | 失效门铃 / 订阅（不承载 render 数据） |
| `ctx.wake(event)` | 唤醒 runtime（调度信号） |

唯一要改的心智：**`read` 拿到的是拷贝、`emit` 不传数据、不写 builder**——其余照旧。

---

## 4. 契约协作：沙箱 provider 要会"缓存自己的数"

如果你的沙箱 app 是某契约的 **provider**（如提供 `message_count`），为了不让"每轮被消费就拉活你的进程"，把契约标量**缓存到核心侧 cell**：你在 `set_state` 时把 count 一并写进自己的 cell，契约 `via` 命令（如 `my_app.count`）**同步返回 cell 里的最后已知值**，不发起跨进程往返。

```ts
// 你的 via 命令（readonly，allowed_invokers:['app']）：直接读自己 state 里的缓存值
const CountCommand: CommandManifest = {
  name: 'count', description: '...', readonly: true, allowed_invokers: ['app'],
  async invoke(_args, ctx) {
    return { ok: true, data: (ctx.state as MyState).cached_count };  // 同步、无 RPC、不拉活
  },
};
```

> 效果：消费方（如 stats）每轮渲染前 pull 的是**核心侧已就绪的缓存值**，你的子进程只在自己有事件要更新 count 时才被唤醒。

---

## 5. 开发 / 调试工作流

1. **先写成可信 app 跑通**：`trust` 省略，in-process，用 `blockapp-development.md` 的范式快速验证逻辑（直引用、可断点）。
2. **切沙箱**：加 `trust:'sandboxed'`，把 builder 换成 `projection` 声明（约束 1），把任何"想直接渲染"的逻辑改成"写 state + emit 门铃"（约束 2）。
3. **收紧能力**：核对命令的 `capabilities`，删掉沙箱拿不到的（删 pinned/物理删/cred/裸联网），install 时看是否被 ceiling reject（已生效）。
4. **跑离线**：`npm start -- --dry-run` 用 mock provider 走完整 turn loop，看你的投影块是否在上下文里、命令是否被正确鉴权。
5. **看上下文**：CLI 里 `/apps` 看已装、`/cmd <id>.<命令> [json]` 直接调命令验证。

---

## 6. 自检清单（沙箱 app 写完对照）

- [ ] `trust:'sandboxed'`；没有自己写 builder，改用 `projection` 声明把某 state 片投影成块。
- [ ] 任何变更走命令 + `ctx.set_state`/`ops`；`emit` 只敲失效门铃、不带 render 数据。
- [ ] 命令的 `capabilities` 最小化；没有声明沙箱拿不到的能力（删 pinned/物理删/cred/裸联网）。
- [ ] state 纯 JSON、有界、在字节配额内；大数据在磁盘/外部。
- [ ] 若是契约 provider：`via` 命令 `readonly + allowed_invokers:['app']`，同步返回 state 里缓存的标量（不发跨进程 RPC）。
- [ ] id 用内容寻址；build 侧（若有可信 builder）无 `Date.now`/`Math.random`/`process.env`。
- [ ] 工厂内部 typed `AppManifest<TState>`，return 时 `as AppManifest`。

下一步：装卸与生命周期 → [blockapp-lifecycle.md](./blockapp-lifecycle.md)；内置可信 app 范本 → [builtin-apps.md](./builtin-apps.md)。
