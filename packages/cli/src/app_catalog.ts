/**
 * cli/app_catalog.ts — BUILTIN_APP_CATALOG: pure metadata for every first-party
 * BlockApp (impl-cli owned).
 *
 * Design: ai_com/block-agent-app-lifecycle-impl-split.md §3.1.
 *
 * This file carries only declarative metadata — no manifest construction logic and no
 * imports from core app factories. The `default_enabled` values mirror `DEFAULTS.apps`
 * (config.ts:31); they must stay in sync (tests assert alignment).
 *
 * Used by:
 *   - context_view.appsView → `available` segment (catalog minus installed ids).
 *   - commands.appCommand   → id validation + info text.
 */

/** Per-app catalog entry: what an operator or user sees BEFORE installing. */
export interface BuiltinAppEntry {
  /** Bare app id (matches LauncherConfig key and AppManifest.id). */
  id: string;
  /** One-line Chinese summary shown in /apps available + /app info. */
  summary: string;
  /** Mirrors DEFAULTS.apps.<id>.enabled; default boot behavior. */
  default_enabled: boolean;
  /**
   * Readiness precondition shown in /app info for apps that need external services.
   * Absent when the app is fully self-contained (no external dep).
   */
  requires?: string;
}

/**
 * BUILTIN_APP_CATALOG — the full set of installable first-party apps (7).
 *
 * Order: three always-on apps first (agent_identity / messages / memory), then the
 * always-on observation-ledger-plus-tools app (base — formerly `actions`, it absorbed the
 * former `tools` app's read_file / grep / bash / http_request commands), then the optional
 * external-dep app (memory_letta), then the contract-model pair (task / stats). This
 * mirrors the boot install order in launch.ts and the DEFAULTS.apps key order;
 * `default_enabled` MUST match DEFAULTS.apps (tests assert it).
 */
export const BUILTIN_APP_CATALOG: readonly BuiltinAppEntry[] = [
  {
    id: 'agent_identity',
    summary: '存储并渲染 Agent 的角色、人格与系统指令，支持运行时修改。',
    default_enabled: true,
  },
  {
    id: 'messages',
    summary: '维护对话历史，提供消息压缩与显示计数控制。',
    default_enabled: true,
  },
  {
    id: 'memory',
    summary: '本地 JSONL 记忆库（零依赖、离线）：agent 笔记 + 用户画像，全文/子串兜底召回（无向量，语义召回用 memory_letta）。',
    default_enabled: true,
  },
  {
    id: 'base',
    summary: '统一动作/观测账本 + 内置工具（前身为 actions）：记录每条 agent 命令的结果（成功+失败）与外部输入，并暴露 read_file / grep / bash / http_request 工具命令，让 agent 看见“我刚做了什么、成功了吗”。',
    default_enabled: true,
  },
  {
    id: 'memory_letta',
    summary: '对接外部 Letta 服务器，实现跨会话持久化归档记忆与语义搜索。',
    default_enabled: false,
    requires: 'Letta server + LETTA_API_KEY',
  },
  {
    id: 'task',
    summary: '本地 JSONL 待办清单：增改删/完成/重开/归档，并按契约 task_count 对外提供未完成计数。',
    default_enabled: true,
  },
  {
    id: 'stats',
    summary: '纯消费型概览：按契约汇总消息数（message_count）与待办数（task_count），默认隐藏，需开启并 show_block 才渲染。',
    default_enabled: false,
  },
];
