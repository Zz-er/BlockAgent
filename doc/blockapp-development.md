# 开发一个 BlockApp

本文教你从零写一个 BlockApp。读完你能写出一个能装进 block-agent、给 agent 暴露命令、并把自己的状态投影进 prompt 的 app。

> 所有示例对照仓库里**真实已实现**的代码（`packages/core/src/apps/agent_identity.ts` 是最小范本，`messages.ts` / `tools.ts` / `memory.ts` 是更完整的范本）。命名、字段、类型都与 `packages/core/src/app/types.ts` 契约一致。

---

## 0. 心智模型：一个 BlockApp 有两张面孔

- **AppManifest（装箱单，静态声明）**：装 app 时 runtime 读它——app 叫什么、占哪棵子树、依赖谁、带哪些 builder 和 command、初始状态是什么、状态的 schema 是什么。
- **AppContext（遥控器，运行时句柄）**：装好后 app 代码握在手里的把手——通过它读写自己的 state、调别的 app、订阅事件。

你写的就是一个返回 `AppManifest` 的工厂函数。command 和 builder 在运行时拿到 `AppContext`。

```
你的工厂  ──返回──▶  AppManifest  ──AppRegistry.install──▶  运行时
                                                              │
   builder ◀── 每轮渲染时调用，从 state 投影出块 ──┐          │
   command ◀── 被调用时改 state / 返回数据 ────────┴── AppContext
```

---

## 1. 契约文件：只 import，不修改

你的 app 只依赖一个契约文件：

```typescript
// app 在 packages/core/src/apps/ 内（同 monorepo core 包）：
import type {
  AppManifest, AppContext, BuildContext,
  BuilderManifest, CommandManifest, CommandResult, JsonSchema,
} from '../app/types.js';            // 注意 NodeNext 要求 .js 扩展名
import type { Block, BlockName, InvokerContext } from '../core/types.js';

// app 在独立 npm 包内（像 packages/memory-letta，跨包）：
import type {
  AppManifest, AppContext, BuildContext, BuilderManifest,
  CommandManifest, CommandResult, JsonSchema,
} from '@block-agent/core/app/types.js';
import type { Block, BlockName, InvokerContext } from '@block-agent/core/core/types.js';
```

`@block-agent/core` 的 `exports` 已把 `./app/*` / `./core/*` / `./apps/*` 映射到 `.ts` 源，tsx 直接跑、无构建步。

---

## 2. AppManifest 各字段

```typescript
interface AppManifest<TState = unknown> {
  id: string;                 // app 标识，如 'todo'。也是块名/命令名的命名空间前缀
  version: string;            // 如 '1.0.0'
  depends_on: string[];       // 依赖的其它 app id（bootstrap 时按依赖拓扑排序后装）
  tree_namespace: string;     // 占据的子树根，如 '/todo'
  initial_state: TState;      // app 启动状态（必须满足下面的 state_schema）
  state_schema: JsonSchema;   // 强制声明 state 结构（见 §3）
  builders: BuilderManifestFactory<TState>[];   // 投影块的 builder（见 §4）
  commands: CommandManifestFactory<TState>[];   // 命令（见 §5）
  on_install?(ctx): Promise<void>;     // 装好后跑一次（可选）
  on_uninstall?(ctx): Promise<void>;   // 卸载时跑一次（可选）
}
```

**命名约定（house style，务必遵守）**：

| 东西 | 形式 | 例子 |
|---|---|---|
| app id | bare 小写 | `todo` |
| 块名 | `<id>:<name>`（**冒号**） | `todo:list` |
| 命令全名 | `<id>.<command>`（**点**） | `todo.add` |
| builder 类型名 | 块世界名词加 `Block` 前缀 | `TodoListBlockBuilder` |
| 作用者类型名 | 职责名、无前缀 | `Store` / `Renderer` |

`id` 为 `core` 是**保留**的（runtime 低层原语占用），装它会被自动改名 `core_2` 并告警；与已装 app 撞 id 也会自动改名（`todo` → `todo_2`）。

---

## 3. state + state_schema（INV #14）

app 的 state 是**有界的、纯 JSON 的**投影窗口——全量历史/大数据放磁盘（JSONL / 外部 store），**不进 state**。

`state_schema` 是**强制**的。`AppContext.set_state` 每次写都过校验：

- 只允许 JSON 可序列化的值：string / number / boolean / null / 数组 / 普通对象（递归）。
- **拒绝**：函数 / class 实例 / Block 引用 / 凭据明文 / symbol / bigint / undefined。违反抛 `AppStateViolation`。

```typescript
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array' } },
};
```

> 为什么强制：如果 state 能塞任意对象，第三方 app 就能在 state 里藏凭据/函数引用绕过鉴权。schema + 校验是低成本但堵掉一整类漏洞的护栏。

---

## 4. builder：把 state 投影成块

block-agent 的 app **不直接往 prompt 里写字符串**。你声明一个 builder，它把 app 的 state 渲染成一个块；renderer 每轮把块树拼成 prompt。

```typescript
interface BuilderManifest {
  name: string;
  version: string;
  owner: 'system' | 'plugin' | 'tool';   // 'agent' 是非法值（INV #4）——builder 必须可信
  app_id?: string;
  inputs: BlockNamePattern[];   // 订阅的输入块名模式（纯 state 投影可留空 []）
  outputs: BlockName[];         // 这个 builder 拥有/产出的块名（每个名至多一个 owner，INV #3）
  cache_tier: CacheTier;        // 'stable' | 'slow_changing' | 'volatile'
  cache_tier_pinned?: boolean;  // true = 小版本升级不得改 tier（保 cache 稳定）
  capabilities?: Capability[];
  build(ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null>;  // 纯 + 确定！
}
```

**`build` 必须纯且确定（INV #1 / #16）**——同样的 state 必须渲染出**字节相同**的块（这是 prompt cache 命中的前提）。所以 `build` 里：

- **禁用** `Date.now()` / `Math.random()` / `crypto.randomUUID()` / `process.env` / `new Date()` / `performance.now()`。
- 需要时钟/随机/id 用 `BuildContext` 的确定性替代：`ctx.deterministic_clock()` / `ctx.deterministic_random(seed)` / `ctx.content_addressed_id(content)`；配置走 `ctx.config`（不是 `process.env`）。
- `build` **只读** state，绝不写（写要走命令）。返回 `null` = 这轮不渲染这个块。

**cache_tier 怎么选**（块在 prompt 里按 tier 分段，越稳定越靠前，命中率越高）：

| tier | 含义 | 例子 |
|---|---|---|
| `stable` | 基本不变，放 cache 前缀头 | 身份块 `agent_identity:identity` |
| `slow_changing` | 偶尔变 | 对话摘要 `messages:summary`、记忆笔记 `memory:notes` |
| `volatile` | 每轮可能变 | 最近消息 `messages:recent`、工具结果 `tools:recent` |

> **投影是可信代码专属（INV #20）**：决定"哪片 state 进 context、定什么 cache_tier"永远是 app 自己的可信 builder 做。不可信后端（如外部记忆 server）只供候选数据，绝不亲手决定渲染字节。

---

## 5. command：唯一的写入口

```typescript
interface CommandManifest<TState> {
  name: string;             // bare 名，如 'add'。全名是 '<app_id>.add'
  description: string;      // 人读的描述（也是给 agent 看的工具描述）
  args_schema?: JsonSchema; // 参数 schema（建议写，agent 据此构造调用）
  capabilities?: Capability[];          // 需要的权限令牌，PolicyEngine 按 invoker 校验
  allowed_invokers?: ('user'|'agent'|'app')[];  // 限定谁能调；缺省=都能调
  invoke(args, ctx: AppContext<TState>, invoker: InvokerContext): Promise<CommandResult>;
}
// CommandResult = { ok: boolean; ops?: BlockOp[]; data?: unknown; error?: string }
```

要点：

- **三方共享**：同一个命令 user / agent / app 都能调，没有单独的"agent 专用通道"。差异由 `PolicyEngine` 按 invoker 决定，不在这里写 if。
- **`allowed_invokers` = "谁能调"闸**：缺省不限制。设了就由 PolicyEngine 在最前面拦——不在列表的 invoker 直接拒。最常见用法是 **`['user']`**：让 agent 改不了某些东西（防 jailbreak / 自我提权）。内置 app 的 `agent_identity.set` / `messages.set_config` / `tools.set_config` / `memory.set_config` 全是 user-only。
- **`capabilities` = "需要什么权限"**：与 `allowed_invokers` 正交。如 `tools.bash` 声明 `op:dangerous`，agent 调时 PolicyEngine 要求审批；`memory.forget_physical` 声明 `block:delete_physical`，agent 被直接拒。
- **命令不直接改树**：`invoke` 通常调 `ctx.set_state(...)` 改自己的 state（下轮 builder 重渲染），或返回 `ops`（树变更）让 `Operations` 这个单一写者去 apply。返回的 `data` 回给调用方。
- **id 用内容寻址**：要给记录生成 id，用内容 hash（如 FNV-1a），别用随机/时钟（保可复现）。

---

## 6. 一个最小可跑示例：`todo` app

下面是一个完整、可装的最小 app（模仿 `agent_identity.ts` 的结构）。它维护一个待办列表，投影成一个块，暴露一个 `add` 命令。

```typescript
// packages/core/src/apps/todo.ts  （或你自己的包里，改 import 路径为 @block-agent/core/...）
import type { Block, BlockName, InvokerContext } from '../core/types.js';
import type {
  AppContext, AppManifest, BuildContext,
  BuilderManifest, CommandManifest, CommandResult, JsonSchema,
} from '../app/types.js';

const APP_ID = 'todo' as const;
const LIST_BLOCK: BlockName = 'todo:list';

interface TodoState { items: string[]; }

const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array' } },
};

// 把 state.items 投影成一个块。纯 + 确定：同 state → 同字节。
function todoStateOf(app_ctx: AppContext | undefined): TodoState | null {
  if (app_ctx === undefined) return null;
  const s = app_ctx.state as Partial<TodoState>;
  return Array.isArray(s.items) ? { items: s.items } : null;
}

const TodoListBlockBuilder: BuilderManifest = {
  name: 'TodoListBlockBuilder',
  version: '1.0.0',
  owner: 'system',           // 'agent' 非法
  app_id: APP_ID,
  inputs: [],                // 纯 state 投影，不订阅别的块
  outputs: [LIST_BLOCK],
  cache_tier: 'slow_changing',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = todoStateOf(app_ctx);
    if (state === null || state.items.length === 0) return null;   // 没事项就不渲染
    const body = state.items.map((t, i) => `${i + 1}. ${t}`).join('\n');
    return {
      id: LIST_BLOCK, name: LIST_BLOCK, children: [],
      content_text: `# 待办事项\n${body}`, content_blob: null,
    };
  },
};

// 命令：todo.add({ text })。所有 invoker 可调，需要 block:write。
const TodoAddCommand: CommandManifest = {
  name: 'add',
  description: 'Add a todo item to the list.',
  capabilities: [{ name: 'block:write' }],
  args_schema: {
    type: 'object', required: ['text'],
    properties: { text: { type: 'string' } },
  },
  async invoke(args: unknown, ctx: AppContext, _invoker: InvokerContext): Promise<CommandResult> {
    const text = (args as { text?: unknown })?.text;
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, error: 'todo.add requires a non-empty string `text`' };
    }
    ctx.set_state((s) => ({ ...(s as TodoState), items: [...(s as TodoState).items, text] }));
    return { ok: true, data: { count: (ctx.state as TodoState).items.length } };
  },
};

export function makeTodoApp(): AppManifest {
  const manifest: AppManifest<TodoState> = {
    id: APP_ID,
    version: '1.0.0',
    depends_on: [],
    tree_namespace: '/todo',
    initial_state: { items: [] },
    state_schema: STATE_SCHEMA,
    builders: [() => TodoListBlockBuilder],
    commands: [() => TodoAddCommand],
  };
  return manifest as AppManifest;   // TS2379 widen 约定：内部 typed，返回时 widen 成 bare AppManifest
}
```

**装它**（最终由 launcher 接线；这里看原理）：

```typescript
registry.install(makeTodoApp());
// 之后 agent 的工具目录里就有 todo.add；它调 todo.add({text:'买牛奶'}）→ 下轮 todo:list 块出现在 prompt
```

> 想让它在内置启动流程里被装，需要在 launcher 的安装工厂 + catalog 里登记（见 [blockapp-lifecycle.md](./blockapp-lifecycle.md)）。一个纯 state-driven app（像上面）不需要自己创建块节点——launcher 的投影块 seeding 会处理。

---

## 7. AppContext 还能做什么

`invoke` / `build` / 生命周期钩子拿到的 `AppContext` 上：

- `ctx.state` / `ctx.set_state(updater)` —— 读写自己的 state（写过 schema 校验）。
- `ctx.list_commands()` / `ctx.list_builders()` / `ctx.list_blocks()` —— 反查自己注册了什么。
- `ctx.invoke_command(full_name, args)` —— **调别的 app 的命令**（跨 app，重新过 PolicyEngine，INV #11）。
- `ctx.read(blockname)` —— 读别的 app 暴露的块（返回**拷贝**，by-value，INV #22）。
- `ctx.on(event, handler)` / `ctx.emit(event, payload)` —— 事件订阅/发布（fire-and-forget，**不得在 handler 里加阻塞关口**）。
- `ctx.wake(event)` —— 把 runtime 从 idle 唤醒（如新消息到达后）。fire-and-forget，不过 PolicyEngine（是调度信号不是命令）。

> 跨 app 交互**全部 by-value**：阻塞关口（写入闸 / 脱敏）走 `invoke_command`；通知走 `emit`；`read` 返回拷贝。app 内部访问自己的数据用普通引用。

---

## 8. 生命周期钩子的边界

- `on_install(ctx)`：装好后跑一次，**fire-and-forget**（不被 await）——需要异步 setup 的 app 不能假设它在第一条命令前已完成（`memory_letta` 的做法是命令首次用时**惰性创建** Letta agent，见 [builtin-apps.md](./builtin-apps.md)）。
- `on_uninstall(ctx)`：卸载时跑一次，**只做优雅断开**——flush 缓冲、关外部连接、释放锁。**绝不删除磁盘或外部数据**（INV #5「删除即归档」）。物理删除是独立的、显式的、需 capability 的 `/app purge` 路径，不走这个钩子。

---

## 9. 自检清单（写完对照）

- [ ] 块名 `<id>:<name>`、命令名 `<id>.<command>`、app id 不撞 `core`。
- [ ] `state_schema` 声明了所有 required key；state 全 JSON、有界（大数据在磁盘/外部）。
- [ ] builder `owner` 是 `system`/`plugin`/`tool`（**不是** `agent`）；`build` 纯 + 确定（无 `Date.now`/`Math.random`/`process.env`）；每个 output 块名只有一个 owner。
- [ ] 改不得让 agent 改的东西的命令设了 `allowed_invokers: ['user']`。
- [ ] 危险/需权限的命令声明了 `capabilities`。
- [ ] 命令用 `ctx.set_state` 改 state，或返回 `ops`；不直接碰树。
- [ ] id 用内容寻址，不用随机/时钟。
- [ ] 工厂内部 typed `AppManifest<TState>`，return 时 `as AppManifest`。

下一步：把 app 装进去、管理它的生命周期 → [blockapp-lifecycle.md](./blockapp-lifecycle.md)。
