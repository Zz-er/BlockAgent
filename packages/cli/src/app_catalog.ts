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
 * BUILTIN_APP_CATALOG — the full set of installable first-party apps (5 + 1).
 *
 * Order: four always-on apps first (agent_identity / messages / tools / memory),
 * then the one optional external-dep app (memory_letta). This mirrors the boot
 * install order in launch.ts and the DEFAULTS.apps key order.
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
    id: 'tools',
    summary: '向 Agent 暴露文件读写、Shell 等内置工具集。',
    default_enabled: true,
  },
  {
    id: 'memory',
    summary: '本地 JSONL 记忆库（零依赖、离线）：agent 笔记 + 用户画像，全文/子串兜底召回（无向量，语义召回用 memory_letta）。',
    default_enabled: true,
  },
  {
    id: 'memory_letta',
    summary: '对接外部 Letta 服务器，实现跨会话持久化归档记忆与语义搜索。',
    default_enabled: false,
    requires: 'Letta server + LETTA_API_KEY',
  },
];
