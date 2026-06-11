# 开发一个 BlockApp

这篇帮你从零写出一块属于自己的能力——一个能装进 block-agent、给 agent 暴露受约束操作、并把自己的状态呈现进上下文的 BlockApp。

你要描述的就是四件事：**状态**（模块持有什么、怎么随操作演化）、**呈现**（状态怎样变成 agent 看到的那片上下文）、**操作**（对外开放哪些受约束的命令）、**契约**（声明依赖什么、提供什么）。下面先把心智模型讲清楚，再带你把这四件事落进一个真实的工作区目录里。

> 本文针对**可信（trusted）app**：你写确定性 builder（`owner=system`），它跑在渲染热路径并进缓存。若你的代码不可信（第三方 / agent 产出），走**沙箱（sandboxed）app**——不写 builder、改声明式投影、`emit` 当失效门铃，见 [blockapp-sandboxed-development.md](./blockapp-sandboxed-development.md)。二者是**同一 BlockApp 模型下 `trust` 维度的两种放置，不是两种 app**。

在动手之前，先理解为什么 block-agent 让你这样写。它对每个模块有三条核心要求，理解了它们，下面的字段和约定就不再是死规矩，而是顺理成章的结果：

- **你不直接往上下文里塞字符串。** 你只负责把自己的状态**呈现**成上下文里的一片，运行时来拼。而且这个呈现必须是确定的——同样的状态总是呈现出同样的内容。这是上下文缓存能稳定命中的前提，所以呈现过程里不能掺任何"每次都不一样"的东西（时间、随机数、环境变量）。
- **任何写入都走受约束的操作。** 状态不是随便改的——改它要通过你声明的命令，命令经过统一的鉴权关口。这样使用者、agent、别的模块三方共用同一组入口，权限差异交给关口判，你不在代码里写一堆 if。
- **状态是有界的、纯数据的。** 进入状态的只能是能序列化的纯 JSON，而且要小——大数据、全量历史放磁盘，状态只放"要呈现出来的那个窗口"。这道护栏堵掉了一整类把凭据 / 函数引用藏进状态绕过鉴权的漏洞。

你写的，就是一个返回模块声明（manifest）的工厂函数，外加几份样板配置——它们一起构成 `apps/` 下的一个独立工作区。

> 所有示例对照仓库里**真实已实现**的代码。最小范本是 `apps/agent_identity/`，更完整的范本是 `apps/messages/` / `apps/tools/` / `apps/memory/` / `apps/task/`。命名、字段、类型都与 `packages/core/src/app/types.ts` 一致。

---

## 0. 心智模型：一个 BlockApp 有两张面孔

- **AppManifest（装箱单，静态声明）**：装 app 时 runtime 读它——app 叫什么、占哪个命名空间、依赖谁、带哪些 builder 和 command、初始状态是什么、状态的 schema 是什么。
- **AppContext（遥控器，运行时句柄）**：装好后 app 代码握在手里的把手——通过它读写自己的 state、调别的 app、订阅事件。

你写的就是一个返回 `AppManifest` 的工厂函数。command 和 builder 在运行时拿到 `AppContext`。

```
你的工厂  ──返回──▶  AppManifest  ──AppRegistry.install──▶  运行时
                                                              │
   builder ◀── 每轮渲染时调用，把 state 呈现成块 ──┐          │
   command ◀── 被调用时改 state / 返回数据 ────────┴── AppContext
```

---

## 1. 全局视角：你的 app 落在项目的哪里

block-agent 是一个 npm workspaces 单仓库，顶层就两类工作区：核心运行时在 `packages/`，**每个 BlockApp 是 `apps/` 下一个独立工作区**。你的新 app 就加在 `apps/` 里，和内置 app 平级——没有"内核特权目录"。

```
block-agent/
├─ packages/
│  ├─ core/         # 运行时：Block 树 · Operations · PolicyEngine · Renderer · App 框架 · providers（零运行时依赖）
│  └─ cli/          # 交互式终端（Ink/React）
├─ apps/            # ★ 所有 BlockApp 的家——你的 app 加在这里
│  ├─ agent_identity/   # 最小范本
│  ├─ messages/         # 更完整的范本
│  ├─ tools/
│  ├─ memory/
│  ├─ task/
│  └─ …                 # 内置 app 的具体集合会增减，但「apps/ 是 app 的家」不变
├─ doc/             # 你正在读的文档
├─ package.json     # workspaces: ["packages/*", "apps/*"]
└─ tsconfig.base.json
```

> 这里只要记住一件事：**写 app = 在 `apps/` 下新建一个工作区目录**。具体有哪些内置 app、各自内部怎么组织，会随项目演进变化，别把它们的内部结构当契约——契约是下面这套「一个 app 工作区长什么样」。

---

## 2. 你要创建的目录：一个 app 工作区长什么样

新建一个 app，就是在 `apps/` 下开一个目录（目录名 = app id），放进**四个文件**。以一个最小的 `todo` app 为例：

```
apps/todo/                  # 工作区，对应包名 @block-agent/app-todo
├─ package.json             # ★ 把这个目录声明成一个 BlockApp（id / trust / host / 契约）
├─ tsconfig.json            # 样板：继承根 tsconfig.base.json
├─ vitest.config.ts         # 样板：node 测试环境
└─ src/
   └─ manifest.ts           # ★ app 的全部逻辑：state · builder · command · 契约
   （可选）test/todo.test.ts # 你的单测，放 test/ 下
```

| 文件 | 干什么 | 你要花多少心思 |
|---|---|---|
| `package.json` | 声明工作区身份 + 一个 `blockAgent` 块（id / trust / host / 默认是否启用 / 契约）。runtime 和打包都读它 | 改几个字段（§3） |
| `tsconfig.json` | 继承仓库根的 `tsconfig.base.json`，统一 NodeNext / strict | 照抄（§4） |
| `vitest.config.ts` | 声明测试跑在 node 环境 | 照抄（§4） |
| `src/manifest.ts` | **app 的本体**：导出一个返回 `AppManifest` 的工厂函数 | 主要精力都在这（§5） |

前三个是样板——大同小异、复制即可。**真正写的是 `src/manifest.ts`。** 下面四节就按这个顺序走：先把三份配置敲定，再深入 `manifest.ts`。

---

## 3. `package.json`：把目录声明成一个 BlockApp

一个目录之所以是 BlockApp，靠的是 `package.json` 里的 `blockAgent` 块。下面是 `todo` 的版本（对照真实的 `apps/task/package.json`）：

```json
{
  "name": "@block-agent/app-todo",
  "version": "1.0.0",
  "description": "todo BlockApp: a minimal local todo list.",
  "type": "module",
  "private": true,
  "license": "MIT",
  "exports": { "./*": "./src/*" },
  "blockAgent": {
    "id": "todo",
    "trust": "trusted",
    "host": "in-process",
    "default_enabled": false,
    "summary": "待办列表（最小示例）。",
    "provides": [],
    "requires": null
  },
  "engines": { "node": ">=24" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest"
  },
  "dependencies": { "@block-agent/core": "*" },
  "devDependencies": { "typescript": "^5.7.0", "vitest": "^2.1.0" }
}
```

`blockAgent` 块各字段：

| 字段 | 含义 |
|---|---|
| `id` | app 标识，**必须和 `manifest.ts` 里的 `id` 一致**；也是块名 / 命令名的命名空间前缀。`core` 是保留 id |
| `trust` | `'trusted'`（同进程，可信）或 `'sandboxed'`（子进程，不可信）。缺省 `'trusted'`。沙箱写法见[沙箱篇](./blockapp-sandboxed-development.md) |
| `host` | `'in-process'` / `'child-process'`，缺省由 `trust` 派生（trusted→同进程）。一般留 `'in-process'` 即可 |
| `default_enabled` | 是否默认启用（启动时是否进 catalog 自动装）。第三方 app 通常先 `false`，手动启用验证 |
| `summary` | 一句话简介，CLI `/apps` 列表里显示 |
| `provides` / `requires` | 这个 app 提供 / 消费哪些**契约**（和 `manifest.ts` 里的 `provides` / `consumes` 呼应，§8 详述）。没有就 `[]` / `null` |

两处约定别漏：

- `"exports": { "./*": "./src/*" }` 把子路径直接映射到 **`.ts` 源**——没有构建步。别的代码用 `@block-agent/app-todo/manifest.js` 导入，NodeNext 经 workspace 符号链接解析到 `src/manifest.ts`，tsx 直接跑。
- `"dependencies": { "@block-agent/core": "*" }`——app 只依赖 core（拿类型 + 运行时句柄），单向。core **绝不**反向依赖任何 app 的运行时。

---

## 4. `tsconfig.json` 与 `vitest.config.ts`：两份样板

这两份几乎不用动，照抄即可。

`apps/todo/tsconfig.json`——继承仓库根的基线（NodeNext / strict / `.js` 扩展名规则都在 base 里）：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "outDir": "dist" },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

`apps/todo/vitest.config.ts`——测试跑在 node 环境：

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
});
```

敲定这两份后，目录的"骨架"就立起来了。剩下的全在 `src/manifest.ts`。

---

## 5. `src/manifest.ts`：app 的全部逻辑

这是你真正动脑的文件。它从头到尾就是按这个顺序写下来的：

1. **import 类型**（§5.1）——从 `@block-agent/core` 拿类型，只读不改。
2. **声明 state + schema**（§5.2）——模块持有什么、长什么样。
3. **写 builder**（§5.3）——把 state 呈现成块（"呈现"）。
4. **写 command**（§5.4）——唯一的写入口（"操作"）。
5. **导出工厂函数**，把上面拼进一个 `AppManifest`（§5.5 给出完整文件）。

先把 `AppManifest` 的字段全貌摆出来，后面几小节逐块填：

```typescript
interface AppManifest<TState = unknown> {
  id: string;                 // app 标识，如 'todo'。也是块名/命令名的命名空间前缀
  version: string;            // 如 '1.0.0'
  depends_on: string[];       // ⚠ 已废弃：新 app 一律写 []（见下方说明）
  tree_namespace: string;     // 占据的命名空间，如 '/todo'
  initial_state: TState;      // app 启动状态（必须满足下面的 state_schema）
  state_schema: JsonSchema;   // 强制声明 state 结构（见 §5.2）
  builders: BuilderManifestFactory<TState>[];   // 把 state 呈现成块的 builder（见 §5.3）
  commands: CommandManifestFactory<TState>[];   // 命令（见 §5.4）
  on_install?(ctx): Promise<void>;     // 装好后跑一次（可选，见 §7）
  on_uninstall?(ctx): Promise<void>;   // 卸载时跑一次（可选，见 §7）
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

> **`depends_on` 已废弃——新 app 一律写 `depends_on: []`。**
> 它过去用来声明"我依赖哪个 app"，但那是**身份耦合**：写死 `depends_on: ['messages']`，把 MessageApp 换成另一个实现就断了，恰恰破坏模块该有的可替换性。**表达数据依赖请用契约**（`consumes` / `provides`，见 §8）——按类型对接、不点名，提供方换了消费方一字不改；"必须有人提供"这件事由契约的可满足性检查负责（缺提供方只**告警**、不报错）。
> `depends_on` 仅为向后兼容保留作 bootstrap 拓扑排序之用；装一个非空 `depends_on` 的 app 时注册表会发**废弃告警**。该字段未来可能被移除或改名为 `install_after`。

### 5.1 import 类型：只 import，不修改

`manifest.ts` 开头从 `@block-agent/core` 按子路径导入类型（注意：这里说的是 TypeScript 的类型定义，和"模块按契约协作"里的"契约"是两回事）：

```typescript
import type { Block, BlockName, InvokerContext } from '@block-agent/core/core/types.js';
import type {
  AppContext, AppManifest, BuildContext,
  BuilderManifest, CommandManifest, CommandResult, JsonSchema,
} from '@block-agent/core/app/types.js';            // 注意 NodeNext 要求 .js 扩展名
```

`@block-agent/core` 的 `exports` 已把 `./app/*` / `./core/*` 映射到 `.ts` 源，tsx 直接跑、无构建步。

> 只有当你的代码就住在 `packages/core` 包内部时，才改用相对路径（`../app/types.js` / `../core/types.js`）——这是核心自身的少数情形，正常的 app（住在 `apps/`）不会落在那里。

### 5.2 state + state_schema

app 的 state 是**有界的、纯 JSON 的**呈现窗口——全量历史/大数据放磁盘（JSONL / 外部 store），**不进 state**。

`state_schema` 是**强制**的。`AppContext.set_state` 每次写都过校验：

- 只允许 JSON 可序列化的值：string / number / boolean / null / 数组 / 普通对象（递归）。
- **拒绝**：函数 / class 实例 / Block 引用 / 凭据明文 / symbol / bigint / undefined。违反抛 `AppStateViolation`。

```typescript
interface TodoState { items: string[]; }

const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array' } },
};
```

> 为什么强制：如果 state 能塞任意对象，第三方 app 就能在 state 里藏凭据/函数引用绕过鉴权。schema + 校验是低成本但堵掉一整类漏洞的护栏。

### 5.3 builder：把 state 呈现成块

block-agent 的 app **不直接往 prompt 里写字符串**。你声明一个 builder，由它把 app 的 state 呈现成一个块；运行时每轮把这些块拼成完整 prompt。这就是前面说的"呈现"在代码里的样子。

```typescript
interface BuilderManifest {
  name: string;
  version: string;
  owner: 'system' | 'plugin' | 'tool';   // 'agent' 是非法值——builder 必须可信
  app_id?: string;
  inputs: BlockNamePattern[];   // 订阅的输入块名模式（纯 state 呈现可留空 []）
  outputs: BlockName[];         // 这个 builder 拥有/产出的块名（每个名至多一个 owner）
  cache_tier: CacheTier;        // 'stable' | 'slow_changing' | 'volatile'
  cache_tier_pinned?: boolean;  // true = 小版本升级不得改 tier（保 cache 稳定）
  capabilities?: Capability[];
  build(ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null>;  // 纯 + 确定！
}
```

**`build` 必须纯且确定**——同样的 state 必须渲染出**字节相同**的块（这是 prompt cache 命中的前提）。所以 `build` 里：

- **禁用** `Date.now()` / `Math.random()` / `crypto.randomUUID()` / `process.env` / `new Date()` / `performance.now()`。
- 需要时钟/随机/id 用 `BuildContext` 的确定性替代：`ctx.deterministic_clock()` / `ctx.deterministic_random(seed)` / `ctx.content_addressed_id(content)`；配置走 `ctx.config`（不是 `process.env`）。
- `build` **只读** state，绝不写（写要走命令）。返回 `null` = 这轮不渲染这个块。

**cache_tier 怎么选**（块在 prompt 里按 tier 分段，越稳定越靠前，命中率越高）：

| tier | 含义 | 例子 |
|---|---|---|
| `stable` | 基本不变，放 cache 前缀头 | 身份块 `agent_identity:identity` |
| `slow_changing` | 偶尔变 | 对话摘要 `messages:summary`、记忆笔记 `memory:notes` |
| `volatile` | 每轮可能变 | 最近消息 `messages:recent`、工具结果 `tools:recent` |

> **呈现是可信代码专属**：决定"哪片 state 进 context、定什么 cache_tier"永远是 app 自己的可信 builder 做。不可信后端（如外部记忆 server）只供候选数据，绝不亲手决定渲染字节。

### 5.4 command：唯一的写入口

```typescript
interface CommandManifest<TState> {
  name: string;             // bare 名，如 'add'。全名是 '<app_id>.add'
  description: string;      // 人读的描述（也是给 agent 看的工具描述）
  args_schema?: JsonSchema; // 参数 schema（建议写，agent 据此构造调用）
  capabilities?: Capability[];          // 需要的权限令牌，鉴权关口按调用者校验
  allowed_invokers?: ('user'|'agent'|'app')[];  // 限定谁能调；缺省=都能调
  invoke(args, ctx: AppContext<TState>, invoker: InvokerContext): Promise<CommandResult>;
}
// CommandResult = { ok: boolean; ops?: BlockOp[]; data?: unknown; error?: string }
```

要点：

- **三方共享**：同一个命令 user / agent / app 都能调，没有单独的"agent 专用通道"。差异由统一的鉴权关口按调用者决定，不在这里写 if。
- **`allowed_invokers` = "谁能调"闸**：缺省不限制。设了就由鉴权关口在最前面拦——不在列表的调用者直接拒。最常见用法是 **`['user']`**：让 agent 改不了某些东西（防 jailbreak / 自我提权）。内置 app 的 `agent_identity.set` / `messages.set_config` / `tools.set_config` / `memory.set_config` 全是 user-only。
- **`capabilities` = "需要什么权限"**：与 `allowed_invokers` 正交。如 `tools.bash` 声明 `op:dangerous`，agent 调时鉴权关口要求审批；`memory.forget_physical` 声明 `block:delete_physical`，agent 被直接拒。
- **命令不直接改树**：`invoke` 通常调 `ctx.set_state(...)` 改自己的 state（下轮 builder 重渲染），或返回 `ops`（树变更）交给那道唯一的写入关口去落地。返回的 `data` 回给调用方。
- **id 用内容寻址**：要给记录生成 id，用内容 hash（如 FNV-1a），别用随机/时钟（保可复现）。

### 5.5 拼成完整文件：`todo` 的 `src/manifest.ts`

把 §5.1–§5.4 拼起来，就是一个完整、可装的最小 app（结构模仿 `apps/agent_identity/src/manifest.ts`）。它维护一个待办列表，呈现成一个块，暴露一个 `add` 命令。

```typescript
// apps/todo/src/manifest.ts
import type { Block, BlockName, InvokerContext } from '@block-agent/core/core/types.js';
import type {
  AppContext, AppManifest, BuildContext,
  BuilderManifest, CommandManifest, CommandResult, JsonSchema,
} from '@block-agent/core/app/types.js';

const APP_ID = 'todo' as const;
const LIST_BLOCK: BlockName = 'todo:list';

interface TodoState { items: string[]; }

const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array' } },
};

// 把 state.items 呈现成一个块。纯 + 确定：同 state → 同字节。
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
  inputs: [],                // 纯 state 呈现，不订阅别的块
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
    depends_on: [],            // ⚠ 已废弃，一律留空；数据依赖走契约（§8）
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

> 想让它在内置启动流程里被装，需要在 launcher 的安装工厂 + catalog 里登记（见 [blockapp-lifecycle.md](./blockapp-lifecycle.md)）。一个纯 state-driven app（像上面）不需要自己创建块节点——launcher 在接线时会替它把呈现的块种好。

---

## 6. AppContext 还能做什么

`invoke` / `build` / 生命周期钩子拿到的 `AppContext` 上：

- `ctx.state` / `ctx.set_state(updater)` —— 读写自己的 state（写过 schema 校验）。
- `ctx.list_commands()` / `ctx.list_builders()` / `ctx.list_blocks()` —— 反查自己注册了什么。
- `ctx.invoke_command(full_name, args)` —— **调别的 app 的命令**（跨 app，重新过鉴权关口）。
- `ctx.read(blockname)` —— 读别的 app 暴露的块（返回**拷贝**，按值）。
- `ctx.on(event, handler)` / `ctx.emit(event, payload)` —— 事件订阅/发布（fire-and-forget，**不得在 handler 里加阻塞关口**）。
- `ctx.wake(event)` —— 把 runtime 从 idle 唤醒（如新消息到达后）。fire-and-forget，不过鉴权关口（是调度信号不是命令）。

> 跨 app 交互**全部 by-value**：阻塞关口（写入闸 / 脱敏）走 `invoke_command`；通知走 `emit`；`read` 返回拷贝。app 内部访问自己的数据用普通引用。

---

## 7. 生命周期钩子的边界

- `on_install(ctx)`：装好后跑一次，**fire-and-forget**（不被 await）——需要异步 setup 的 app 不能假设它在第一条命令前已完成（`memory_letta` 的做法是命令首次用时**惰性创建** Letta agent，见 [builtin-apps.md](./builtin-apps.md)）。
- `on_uninstall(ctx)`：卸载时跑一次，**只做优雅断开**——flush 缓冲、关外部连接、释放锁。**绝不删除磁盘或外部数据**（"删除即归档"原则）。物理删除是独立的、显式的、需更高权限的 `/app purge` 路径，不走这个钩子。

---

## 8. 让模块之间协作：按契约，不点名

到这里你的模块是自洽的：自己的状态、自己的呈现、自己的命令。但真正有意思的是模块**之间**怎么配合——而 block-agent 在这里有一条明确的取向：**模块绑契约，不绑身份**。

一个契约就是一份独立于任何模块的、带类型的接口声明（类比一份共享的数据格式约定）。提供方说"我用某条命令满足某个契约"，消费方说"我需要某个契约"——**两边都不写对方的名字**。运行时按契约名把它们牵起来，并在每轮呈现之前，经那道统一的写入关口替消费方把数据取到位，落进消费方自己的状态里，消费方再纯粹地呈现它。

好处很直接：换掉提供方，消费方一个字都不用改。内置的待办和概览就是现成的例子——待办对外提供"未完成数量"这个契约，概览消费"消息数"和"未完成数量"两个契约汇总成一行，但概览从不知道是谁在提供这些数字。

你要做的只是在模块声明里加上对应的声明（manifest 里的 `provides` / `consumes`，并在 `package.json` 的 `blockAgent.provides` / `requires` 里同步登记），指明命令和契约名。这样写出来的模块天然可被替换、可被组合，而不是和某个具体伙伴焊死。这也是 block-agent "一块一块生长"的底气所在。

---

## 9. 自检清单（写完对照）

**目录与配置**

- [ ] app 在 `apps/<id>/` 下；有 `package.json` / `tsconfig.json` / `vitest.config.ts` / `src/manifest.ts`。
- [ ] `package.json` 的 `blockAgent.id` 与 `manifest.ts` 的 `id` 一致；`exports` 指向 `./src/*`；只依赖 `@block-agent/core`。

**manifest 本体**

- [ ] 块名 `<id>:<name>`、命令名 `<id>.<command>`、app id 不撞 `core`。
- [ ] `state_schema` 声明了所有 required key；state 全 JSON、有界（大数据在磁盘/外部）。
- [ ] builder `owner` 是 `system`/`plugin`/`tool`（**不是** `agent`）；`build` 纯 + 确定（无 `Date.now`/`Math.random`/`process.env`）；每个 output 块名只有一个 owner。
- [ ] 改不得让 agent 改的东西的命令设了 `allowed_invokers: ['user']`。
- [ ] 危险/需权限的命令声明了 `capabilities`。
- [ ] 命令用 `ctx.set_state` 改 state，或返回 `ops`；不直接碰树。
- [ ] id 用内容寻址，不用随机/时钟。
- [ ] 工厂内部 typed `AppManifest<TState>`，return 时 `as AppManifest`。

下一步：把 app 装进去、管理它的生命周期 → [blockapp-lifecycle.md](./blockapp-lifecycle.md)。
