/**
 * apps/im_proxy/src/manifest.ts — the `im_proxy` BlockApp.
 *
 * im_proxy projects an external IM service into agent context as a STATEFUL chat block.
 * It is a STANDARD BlockApp (no back door): state + pure builders + commands + contract,
 * isomorphic to the built-in `messages` app (apps/messages/src/manifest.ts) — only the
 * truth source changes (a remote IM service + a bounded projection window, instead of a
 * local jsonl). The proxy is THIN: it forwards commands and folds pushes; the service
 * owns all the logic.
 *
 * Authoritative design: BlockAI-team/docs/blockapps/im-proxy.md (window+fold, push→wake→
 * ingest, per-conv `consumed_seq`, `from` content-only). Wire contract: wire.ts (a
 * type-only mirror of @blockai/contracts/im.ts).
 *
 * Two projection blocks (mirror messages:summary / messages:recent):
 *   - `im_proxy:conversations` (slow_changing) — conversation list + unread + focus.
 *   - `im_proxy:chat`          (volatile)       — the focused conversation's recent window
 *     VERBATIM. This is where the agent READS message bodies. @-mentions of self are
 *     highlighted (`@me`), proxy-derived from `msg.mentions.includes(self)`.
 *
 * INVARIANTS held here:
 *   #1  byte-identical rendering: both builders are PURE — read `state` only, no clock /
 *       random / network. Pushes mutate state; the builder renders deterministically.
 *   #4  builder owner is `system` (`agent` is illegal).
 *   #14 state is JSON-serializable + bounded (per-conv window capped at `window`); the
 *       full history is the IM service, never unbounded in state. The token is NEVER in
 *       state (client-private).
 *   #15 block names are `<app_id>:<name>` (`im_proxy:chat` / `im_proxy:conversations`).
 *
 * SECURITY — the identity fence (§7, Architect-confirmed): the peer-controlled `from` and
 * the `mentions[]` principal_ids are CONTENT, not AUTHORITY. They flow into state
 * (`from_label`, sanitized) and the pure builder ONLY, and NEVER reach `ctx.identity`:
 * `im.ingest` runs under im_proxy's own host-stamped `app_id` (`invoker:'app'`), unrelated
 * to the peer `from`. `mentioned_me` is a string-equality self-judgement, not an identity
 * lookup. v1 depends on NO unlanded core change. `im.ingest` is `allowed_invokers:['app']`
 * (STRICTER than messages' `['user','app']`) — the agent can never forge an inbound message.
 *
 * config (anti-self-modification): `set_config` + every group-management command are
 * `allowed_invokers:['user']` (the "who, not what" gate) — the agent can never retune its
 * own window budget nor create/restructure groups.
 *
 * House style (§0.5): the extension unit is `BlockApp`; builders are `<Name>BlockBuilder`;
 * block names use a colon, command full-names a dot; relative imports carry `.js`.
 */

import type { Block, BlockName, InvokerContext, WakeEvent } from '@block-agent/core/core/types.js';
import type {
  AppContext,
  AppManifest,
  BuildContext,
  BuilderManifest,
  Capability,
  CommandManifest,
  CommandResult,
  JsonSchema,
} from '@block-agent/core/app/types.js';
import type { ConvKind, ImPushFrame, WireMessage } from './wire.js';
import { ImClient, type ImClientApi } from './im_client.js';

// ============================================================================
// Identity + block names
// ============================================================================

/** App id + tree namespace. */
const APP_ID = 'im_proxy' as const;
const TREE_NAMESPACE = '/im_proxy' as const;

/** The two blocks this App renders into the prompt (INV #15). */
const CONVERSATIONS_BLOCK: BlockName = 'im_proxy:conversations';
const CHAT_BLOCK: BlockName = 'im_proxy:chat';

// ============================================================================
// Capability tokens
// ============================================================================

const CAP_BLOCK_WRITE: Capability = { name: 'block:write' };
const CAP_NET_HTTP: Capability = { name: 'net:http' };

// ============================================================================
// Display-label sanitization fence (§7) — `from`/`mentions` are CONTENT, sanitized
// for rendering, NEVER identity. The map is INJECTIVE: two distinct principal_ids
// can never collapse to the same label (a non-injective sanitizer would itself let
// two peers collide). Fixed `im:` prefix + strict allowlist; everything else is
// hex-escaped `_xx`, so the escape is unambiguous and deterministic (INV #1).
// ============================================================================

/**
 * sanitizeId — injective, allowlist sanitizer for a peer-controlled principal_id. Keeps
 * `[a-z0-9_-]`; every other byte becomes `_<hexpair>`. Because a literal `_` in the input
 * is itself escaped (`_5f`), no escaped sequence can be forged by raw input — the map is
 * injective, so two distinct ids never produce the same label. This is the anti-injection
 * fence (peer can't smuggle `</im-context>` or a boundary marker into a block) AND the
 * collision fence (two peers can't share a display label).
 */
function sanitizeId(raw: string): string {
  let out = '';
  for (const ch of raw) {
    if (/[a-z0-9-]/.test(ch)) {
      out += ch;
    } else {
      // Escape EVERY other char — including `_` and uppercase — as `_<hexpair(s)>` over
      // its UTF-8 bytes, so the escape is reversible/injective and renders deterministically.
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) out += `_${b.toString(16).padStart(2, '0')}`;
    }
  }
  return out;
}

/** The display label for a peer principal_id: fixed `im:` prefix + injective sanitize. */
function labelFor(principalId: string): string {
  return `im:${sanitizeId(principalId)}`;
}

// ============================================================================
// State (bounded projection — INV #14)
// ============================================================================

/** A conversation member, resolved for display (display name from the directory if any). */
export interface ImMember {
  principal_id: string;
  kind: 'human' | 'agent';
  display: string;
}

/**
 * One projected message in a conversation window. `from_label` is the SANITIZED display
 * label (§7) — never the raw peer id used as authority. `mentioned_me` is the proxy's own
 * `msg.mentions.includes(self)` judgement (a render highlight + optional priority-wake
 * signal), never an identity.
 */
export interface ImMessage {
  id: string;
  /** §7 sanitized display label, e.g. `im:zhangsan` — NOT the raw `from`. */
  from_label: string;
  body: string;
  /** per-conversation monotonic seq (dedupe/sort key). */
  seq: number;
  /** this agent was @-mentioned (render `@me` + optional priority wake). */
  mentioned_me?: boolean;
}

/**
 * A conversation's bounded projection. `recent` is capped at `config.window` (older
 * messages fall out of the window — the service keeps the full history). `consumed_seq`
 * is the PER-CONVERSATION backfill cursor (im-proxy.md §4 — a per-agent scalar would
 * silently drop messages across two independent seq spaces).
 */
export interface ImConversation {
  id: string;
  kind: ConvKind;
  members: ImMember[];
  recent: ImMessage[];
  unread: number;
  /** ★ max seq consumed for THIS conv — the per-conv backfill cursor (§4). */
  consumed_seq: number;
}

/**
 * One member of the consumed `org_directory` — a type-only mirror of oa_proxy's
 * `DirectoryMember` (BlockAI-team oa.ts §3), narrowed to the fields im_proxy actually
 * reads. `principal_id`/`display`/`name`/`kind` are always present (non-nullable). We only
 * read `display` (preferred) + `name` to resolve a peer's shown name.
 *
 * The HR-projection fields `employee_no`/`dept_id`/`dept_path`/`title` are NOT mirrored here
 * because im_proxy never reads them. If a future feature needs them: oa_proxy normalizes a
 * missing value to an ABSENT KEY (`field?: string`), NOT `null` — core's consume-refresh
 * validator fails `type:'string'` on `null` — so mirror them as optional and use `?? x` /
 * `if (m.title)`, never `=== null` (Architect's null→absent ruling).
 */
export interface DirectoryMember {
  principal_id: string;
  display: string;
  kind?: 'human' | 'agent';
  name?: string;
}

/**
 * The value `org_directory` folds into `state.directory` (Architect ruling: `combine:'first'`,
 * `cardinality:'one'` → a SINGLE object, NOT an array). Mirrors oa_proxy's `OrgDirectory`
 * `{ org_id, members }`. Consume-refresh validates only the top-level object shape (R-1).
 */
export interface OrgDirectory {
  org_id: string;
  members: DirectoryMember[];
}

/** Tunable knobs; user-only to change (anti-self-modification). */
export interface ImConfig {
  /** verbatim messages kept per conversation window (default 20). */
  window: number;
  /** conversation-list upper bound (default 50). */
  max_conversations: number;
  /** push-coalesce window in ms (default 200; §4 wake-storm guard). */
  coalesce_ms: number;
}

/**
 * ImProxyState — a BOUNDED projection of the IM service plus the config. `account` holds
 * only the principal_id + display (the TOKEN is client-private, never here — INV #14 /
 * §3). `directory` is the consumed `org_directory` output (folded by consume-refresh,
 * §5); it is read-only enrichment for member display names.
 */
export interface ImProxyState {
  account?: { principal_id: string; display: string };
  conversations: ImConversation[];
  /** the focused conversation id (im.open switches it). */
  focus?: string;
  config: ImConfig;
  /**
   * Consumed from oa_proxy's `org_directory` contract (combine 'first' → a single
   * OrgDirectory object). Read-only enrichment to resolve principal_id → display name; it
   * is pure CONTENT (never identity). Absent until oa_proxy provides it (graceful fallback
   * to the sanitized label).
   */
  directory?: OrgDirectory;
}

const DEFAULT_CONFIG: ImConfig = {
  window: 20,
  max_conversations: 50,
  coalesce_ms: 200,
};

/** Clamp config to sane ranges (defends against bad file/input values). */
function clampConfig(cfg: ImConfig): ImConfig {
  return {
    window: Math.max(1, Math.floor(cfg.window)),
    max_conversations: Math.max(1, Math.floor(cfg.max_conversations)),
    coalesce_ms: Math.max(0, Math.floor(cfg.coalesce_ms)),
  };
}

/** INV #14: declare every state key so set_state is schema-checked. */
const STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['conversations', 'config'],
  properties: {
    account: {
      type: 'object',
      required: ['principal_id', 'display'],
      properties: { principal_id: { type: 'string' }, display: { type: 'string' } },
    },
    conversations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'members', 'recent', 'unread', 'consumed_seq'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          members: { type: 'array' },
          recent: { type: 'array' },
          unread: { type: 'number' },
          consumed_seq: { type: 'number' },
        },
      },
    },
    focus: { type: 'string' },
    config: {
      type: 'object',
      required: ['window', 'max_conversations', 'coalesce_ms'],
      properties: {
        window: { type: 'number' },
        max_conversations: { type: 'number' },
        coalesce_ms: { type: 'number' },
      },
    },
    // `org_directory` consumed as a single object (combine 'first'): { org_id, members }.
    // MUST be `type:'object'` — consume-refresh folds the whole OrgDirectory object here and
    // re-validates against this schema on its set_state; declaring `array` would fail every
    // refresh and silently downgrade the consumer. Shallow check only: do NOT drill into
    // `members.items` with nullable `type:'string'` fields (that reopens OA's null trap).
    directory: {
      type: 'object',
      properties: {
        org_id: { type: 'string' },
        members: { type: 'array' },
      },
    },
  },
};

// ============================================================================
// Pure helpers — project a wire message into state; resolve display names
// ============================================================================

/** Narrow an AppContext's state to ImProxyState (already schema-valid, INV #14). */
function stateOf(app_ctx: AppContext | undefined): ImProxyState | null {
  if (app_ctx === undefined) return null;
  const s = app_ctx.state;
  if (typeof s !== 'object' || s === null) return null;
  const cand = s as Partial<ImProxyState>;
  if (!Array.isArray(cand.conversations) || cand.config == null) return null;
  return s as ImProxyState;
}

/**
 * Project a wire message into the in-state `ImMessage` (§7): the raw `from` becomes the
 * SANITIZED `from_label`; `mentioned_me` is the proxy's `mentions.includes(self)` judgement
 * (live and backfill share this one path). Neither `from` nor `mentions` ever leaves
 * content — both are sanitized/compared as strings, never used as identity.
 */
function projectMessage(msg: WireMessage, selfId: string | undefined): ImMessage {
  const mentionedMe =
    selfId !== undefined && Array.isArray(msg.mentions) && msg.mentions.includes(selfId);
  const out: ImMessage = {
    id: msg.id,
    from_label: labelFor(msg.from),
    body: msg.body,
    seq: msg.seq,
  };
  if (mentionedMe) out.mentioned_me = true;
  return out;
}

/**
 * Append projected messages into a conversation's bounded window: dedupe by seq (drop
 * `seq <= consumed_seq`, idempotent), sort by seq, cap at `window`, advance `consumed_seq`,
 * and bump unread by the number of NEW inbound messages. Pure transform over the conv.
 */
function foldIntoConv(
  conv: ImConversation,
  incoming: ImMessage[],
  window: number,
): ImConversation {
  const fresh = incoming.filter((m) => m.seq > conv.consumed_seq);
  if (fresh.length === 0) return conv;
  // Merge, dedupe by id (a backfill + a live frame may carry the same message), sort by seq.
  const byId = new Map<string, ImMessage>();
  for (const m of conv.recent) byId.set(m.id, m);
  for (const m of fresh) byId.set(m.id, m);
  const merged = [...byId.values()].sort((a, b) => a.seq - b.seq);
  const windowed = merged.slice(-window);
  const maxSeq = Math.max(conv.consumed_seq, ...fresh.map((m) => m.seq));
  return {
    ...conv,
    recent: windowed,
    consumed_seq: maxSeq,
    unread: conv.unread + fresh.length,
  };
}

/**
 * Resolve a principal_id to a display name via the consumed `org_directory` (its `members`),
 * preferring `display`, then `name`; falling back to the SANITIZED label when the directory
 * is absent or the principal is unknown. The directory is content-only enrichment — this
 * never touches identity (§7).
 */
function displayName(principalId: string, directory: OrgDirectory | undefined): string {
  const hit = directory?.members.find((m) => m.principal_id === principalId);
  return hit?.display ?? hit?.name ?? labelFor(principalId);
}

// ============================================================================
// Builders — im_proxy:conversations (slow_changing) + im_proxy:chat (volatile)
// ============================================================================

/**
 * ConversationsBlockBuilder — owner of `im_proxy:conversations`. Renders the conversation
 * list (who, unread, focus). cache_tier `slow_changing`: changes only on open/close/unread
 * jumps, so it sits mid-prompt and stays cache-warm. Pure: reads `state` only (INV #1/#16).
 * Empty list → `null`, the block drops out of the prompt (mirrors `task:list`).
 */
const ConversationsBlockBuilder: BuilderManifest = {
  name: 'ConversationsBlockBuilder',
  version: '1.0.0',
  owner: 'system', // INV #4: 'agent' illegal.
  app_id: APP_ID,
  inputs: [],
  outputs: [CONVERSATIONS_BLOCK],
  cache_tier: 'slow_changing',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = stateOf(app_ctx);
    if (state === null || state.conversations.length === 0) return null;
    return {
      id: CONVERSATIONS_BLOCK,
      name: CONVERSATIONS_BLOCK,
      children: [],
      content_text: renderConversations(state),
      content_blob: null,
    };
  },
};

/** Deterministic text projection of the conversation list. */
function renderConversations(state: ImProxyState): string {
  const lines = state.conversations.map((c) => {
    const focusMark = c.id === state.focus ? '  <- focus' : '';
    const label =
      c.kind === 'group'
        ? `[group] ${displayName(c.id, state.directory)} (${c.members.length})`
        : `[dm] ${conversationPeerName(c, state)}`;
    const bullet = c.id === state.focus ? '*' : ' ';
    return `${bullet} ${label} — ${c.unread} unread${focusMark}`;
  });
  return ['# Conversations', ...lines].join('\n');
}

/** For a dm, the display name of the other member (not self); else the conv id. */
function conversationPeerName(conv: ImConversation, state: ImProxyState): string {
  const selfId = state.account?.principal_id;
  const peer = conv.members.find((m) => m.principal_id !== selfId) ?? conv.members[0];
  if (peer === undefined) return displayName(conv.id, state.directory);
  return peer.display.length > 0 ? peer.display : displayName(peer.principal_id, state.directory);
}

/**
 * ChatBlockBuilder — owner of `im_proxy:chat`. Renders the FOCUSED conversation's recent
 * window VERBATIM (where the agent reads message bodies). cache_tier `volatile` → tail of
 * the prompt. @-mentioned-self messages get an `@me` prefix. Pure: reads `state` only.
 */
const ChatBlockBuilder: BuilderManifest = {
  name: 'ChatBlockBuilder',
  version: '1.0.0',
  owner: 'system',
  app_id: APP_ID,
  inputs: [],
  outputs: [CHAT_BLOCK],
  cache_tier: 'volatile',
  async build(_ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
    const state = stateOf(app_ctx);
    if (state === null || state.focus === undefined) return null;
    const conv = state.conversations.find((c) => c.id === state.focus);
    if (conv === undefined) return null;
    return {
      id: CHAT_BLOCK,
      name: CHAT_BLOCK,
      children: [],
      content_text: renderChat(conv, state),
      content_blob: null,
    };
  },
};

/** Deterministic text projection of the focused conversation's window. */
function renderChat(conv: ImConversation, state: ImProxyState): string {
  const selfLabel = state.account ? labelFor(state.account.principal_id) : null;
  const header =
    conv.kind === 'group'
      ? `# Chat — group ${displayName(conv.id, state.directory)} (${conv.members.length})`
      : `# Chat — dm ${conversationPeerName(conv, state)}`;
  const window = conv.recent.slice(-state.config.window);
  if (window.length === 0) return `${header}\n(no messages)`;
  const lines = window.map((m) => {
    const who = selfLabel !== null && m.from_label === selfLabel ? '[me]' : `[${m.from_label}]`;
    const mention = m.mentioned_me ? ' @me' : '';
    return `${who}${mention} ${m.body}`;
  });
  return [header, ...lines].join('\n');
}

// ============================================================================
// Commands
// ============================================================================

/** A non-empty string arg, else null. */
function readString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * im.send({ conv, body, mentions? }) — outbound: forward to the IM service, optimistically
 * append the sent message to the focused window so the agent sees its own turn immediately.
 * The proxy owns the outbound port → it generates the `client_msg_id` (idempotency +
 * ack-dedupe key). `from` is NOT sent — the service derives it from the token (§7).
 * Caps [block:write, net:http]. All invokers (the agent may send).
 */
function sendCommand(app: ImProxyApp): CommandManifest<ImProxyState> {
  return {
    name: 'send',
    description: 'Send a message to a conversation. Put the text in `body`; target in `conv`.',
    args_schema: {
      type: 'object',
      required: ['conv', 'body'],
      properties: {
        conv: { type: 'string', description: 'The conversation id to send to.' },
        body: { type: 'string', description: 'The message text.' },
        mentions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional principal_ids to @-mention (must be conv members).',
        },
      },
    },
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = args as { conv?: unknown; body?: unknown; mentions?: unknown } | undefined;
      const conv = readString(a?.conv);
      const body = readString(a?.body);
      if (conv === null || body === null)
        return { ok: false, error: 'send requires string `conv` and `body`' };
      const mentions = Array.isArray(a?.mentions)
        ? (a!.mentions as unknown[]).filter((m): m is string => typeof m === 'string')
        : undefined;

      const clientMsgId = app.nextClientMsgId();
      let res: { id: string; seq: number; ts: number };
      try {
        res = await app.client.send({
          conv,
          body,
          client_msg_id: clientMsgId,
          ...(mentions ? { mentions } : {}),
        });
      } catch (err) {
        return { ok: false, error: `im.send failed: ${(err as Error).message}` };
      }

      // Optimistic append: fold the just-sent message into the conv window using the
      // service-assigned id/seq (advances this conv's consumed_seq — REST sync return is
      // the primary delivery path; a later WS `ack` with the same id is a no-op dedupe).
      const selfId = ctx.state.account?.principal_id;
      const sent: WireMessage = {
        id: res.id,
        conv,
        from: selfId ?? '',
        body,
        ts: res.ts,
        seq: res.seq,
        ...(mentions ? { mentions } : {}),
      };
      ctx.set_state((s) => app.foldMessages(s, [{ conv, msg: sent }]));
      return { ok: true, data: { id: res.id, seq: res.seq, client_msg_id: clientMsgId } };
    },
  };
}

/**
 * im.ingest({ messages }) — the inbound front door (the WS handler triggers it). Folds a
 * BATCH of `{conv, msg}` into state (dedupe by seq, advance per-conv consumed_seq, bump
 * unread). `allowed_invokers:['app']` — STRICTER than messages' `['user','app']`: only the
 * proxy's own WS handler (host-stamped `invoker:'app'`) may deliver inbound, so the agent
 * can NEVER forge a peer message into its own context (§7 anti-jailbreak). The peer `from`
 * is sanitized into `from_label` inside `foldMessages` — it never touches identity.
 */
function ingestCommand(app: ImProxyApp): CommandManifest<ImProxyState> {
  return {
    name: 'ingest',
    description: 'Deliver inbound IM messages into the conversation windows (app-only front door).',
    args_schema: {
      type: 'object',
      required: ['messages'],
      properties: {
        messages: {
          type: 'array',
          items: {
            type: 'object',
            required: ['conv', 'msg'],
            properties: { conv: { type: 'string' }, msg: { type: 'object' } },
          },
        },
      },
    },
    capabilities: [CAP_BLOCK_WRITE],
    allowed_invokers: ['app'],
    invoke: async (args, ctx): Promise<CommandResult> => {
      const a = args as { messages?: unknown } | undefined;
      if (!Array.isArray(a?.messages))
        return { ok: false, error: 'ingest requires an array `messages`' };
      const batch = (a!.messages as unknown[]).filter(
        (e): e is { conv: string; msg: WireMessage } =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as { conv?: unknown }).conv === 'string' &&
          typeof (e as { msg?: unknown }).msg === 'object',
      );
      if (batch.length === 0) return { ok: true, data: { ingested: 0 } };
      ctx.set_state((s) => app.foldMessages(s, batch));
      return { ok: true, data: { ingested: batch.length } };
    },
  };
}

/**
 * im.open({ conv }) — switch the focused conversation and clear its unread. All invokers.
 * Cap [block:write].
 */
function openCommand(): CommandManifest<ImProxyState> {
  return {
    name: 'open',
    description: 'Focus a conversation (renders its window in im_proxy:chat) and clear its unread.',
    args_schema: {
      type: 'object',
      required: ['conv'],
      properties: { conv: { type: 'string', description: 'The conversation id to focus.' } },
    },
    capabilities: [CAP_BLOCK_WRITE],
    invoke: async (args, ctx): Promise<CommandResult> => {
      const conv = readString((args as { conv?: unknown } | undefined)?.conv);
      if (conv === null) return { ok: false, error: 'open requires a string `conv`' };
      if (!ctx.state.conversations.some((c) => c.id === conv))
        return { ok: false, error: `unknown conversation '${conv}'` };
      ctx.set_state((s) => ({
        ...s,
        focus: conv,
        conversations: s.conversations.map((c) => (c.id === conv ? { ...c, unread: 0 } : c)),
      }));
      return { ok: true, data: { focus: conv } };
    },
  };
}

/**
 * im.list() — read-only conversation list for UIs. `allowed_invokers:['user','app']` (the
 * agent already reads the list from the `im_proxy:conversations` block).
 */
function listCommand(): CommandManifest<ImProxyState> {
  return {
    name: 'list',
    description: 'List conversations (data). For UIs; not in the agent tool catalog.',
    readonly: true,
    allowed_invokers: ['user', 'app'],
    args_schema: { type: 'object', properties: {} },
    invoke: async (_args, ctx): Promise<CommandResult> => {
      const conversations = ctx.state.conversations.map((c) => ({
        id: c.id,
        kind: c.kind,
        unread: c.unread,
        members: c.members.length,
      }));
      return { ok: true, data: { conversations, focus: ctx.state.focus } };
    },
  };
}

/**
 * im.unread_count() — the `message_count` contract's `via` (§5). readonly +
 * `result_schema:{type:'number'}` (matches the contract output_schema), `allowed_invokers:
 * ['app','user']` so it never enters the agent tool catalog. Returns the SCALAR total
 * unread across conversations; a `stats` app summing `message_count` adds it to messages'
 * count with zero coupling (INV #11).
 */
function unreadCountCommand(): CommandManifest<ImProxyState> {
  return {
    name: 'unread_count',
    description: 'Return total unread (a scalar number). Contract via; app/user only.',
    readonly: true,
    allowed_invokers: ['app', 'user'],
    result_schema: { type: 'number' },
    args_schema: { type: 'object', properties: {} },
    invoke: async (_args, ctx): Promise<CommandResult> => {
      const total = ctx.state.conversations.reduce((sum, c) => sum + c.unread, 0);
      return { ok: true, data: total };
    },
  };
}

/**
 * im.set_config({ window?, max_conversations?, coalesce_ms? }) — retune config at runtime.
 * USER-ONLY (`allowed_invokers:['user']`): the agent can never change its own window budget
 * (anti self-modification, same gate as messages.set_config). Validated + clamped.
 */
function setConfigCommand(): CommandManifest<ImProxyState> {
  return {
    name: 'set_config',
    description: 'Retune im_proxy config (window / max_conversations / coalesce_ms). User/UI only.',
    args_schema: {
      type: 'object',
      properties: {
        window: { type: 'number' },
        max_conversations: { type: 'number' },
        coalesce_ms: { type: 'number' },
      },
    },
    capabilities: [CAP_BLOCK_WRITE],
    allowed_invokers: ['user'],
    invoke: async (args, ctx, _invoker: InvokerContext): Promise<CommandResult> => {
      const patch = readConfigPatch(args);
      if (Object.keys(patch).length === 0)
        return { ok: false, error: 'set_config: no valid field (window/max_conversations/coalesce_ms)' };
      ctx.set_state((s) => ({ ...s, config: clampConfig({ ...s.config, ...patch }) }));
      return { ok: true, data: { updated: Object.keys(patch) } };
    },
  };
}

/** Pull the numeric config fields out of set_config args; ignore everything else. */
function readConfigPatch(args: unknown): Partial<ImConfig> {
  if (typeof args !== 'object' || args === null) return {};
  const a = args as Record<string, unknown>;
  const patch: Partial<ImConfig> = {};
  if (typeof a['window'] === 'number') patch.window = a['window'];
  if (typeof a['max_conversations'] === 'number') patch.max_conversations = a['max_conversations'];
  if (typeof a['coalesce_ms'] === 'number') patch.coalesce_ms = a['coalesce_ms'];
  return patch;
}

/**
 * im.create_group({ title, members }) — create a group. USER-ONLY: org/group structure is
 * human-defined; the agent structurally cannot create a group (anti-jailbreak). Forwards to
 * POST /im/group/create. Caps [block:write, net:http].
 */
function createGroupCommand(app: ImProxyApp): CommandManifest<ImProxyState> {
  return {
    name: 'create_group',
    description: 'Create a group conversation. User/console only.',
    args_schema: {
      type: 'object',
      required: ['title', 'members'],
      properties: {
        title: { type: 'string' },
        members: { type: 'array', items: { type: 'string' } },
      },
    },
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
    allowed_invokers: ['user'],
    invoke: async (args): Promise<CommandResult> => {
      const a = args as { title?: unknown; members?: unknown } | undefined;
      const title = readString(a?.title);
      const members = Array.isArray(a?.members)
        ? (a!.members as unknown[]).filter((m): m is string => typeof m === 'string')
        : null;
      if (title === null || members === null)
        return { ok: false, error: 'create_group requires string `title` and array `members`' };
      try {
        const res = await app.client.createGroup({ title, members });
        return { ok: true, data: { conv: res.conv.id } };
      } catch (err) {
        return { ok: false, error: `create_group failed: ${(err as Error).message}` };
      }
    },
  };
}

/**
 * im.add_member / im.remove_member({ conv, principal_id }) — owner/console membership edit.
 * USER-ONLY. Forwards to POST /im/group/{add,remove}_member. Caps [block:write, net:http].
 */
function memberCommand(app: ImProxyApp, op: 'add' | 'remove'): CommandManifest<ImProxyState> {
  const name = op === 'add' ? 'add_member' : 'remove_member';
  return {
    name,
    description: `${op === 'add' ? 'Add' : 'Remove'} a group member. User/console only.`,
    args_schema: {
      type: 'object',
      required: ['conv', 'principal_id'],
      properties: { conv: { type: 'string' }, principal_id: { type: 'string' } },
    },
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
    allowed_invokers: ['user'],
    invoke: async (args): Promise<CommandResult> => {
      const a = args as { conv?: unknown; principal_id?: unknown } | undefined;
      const conv = readString(a?.conv);
      const principalId = readString(a?.principal_id);
      if (conv === null || principalId === null)
        return { ok: false, error: `${name} requires string \`conv\` and \`principal_id\`` };
      try {
        const res =
          op === 'add'
            ? await app.client.addMember({ conv, principal_id: principalId })
            : await app.client.removeMember({ conv, principal_id: principalId });
        return { ok: true, data: { conv: res.conv.id, members: res.conv.members.length } };
      } catch (err) {
        return { ok: false, error: `${name} failed: ${(err as Error).message}` };
      }
    },
  };
}

/**
 * im.set_owner({ conv, owner_id }) — transfer group ownership. USER-ONLY. Forwards to
 * POST /im/group/set_owner. Caps [block:write, net:http].
 */
function setOwnerCommand(app: ImProxyApp): CommandManifest<ImProxyState> {
  return {
    name: 'set_owner',
    description: 'Transfer group ownership. User/console only.',
    args_schema: {
      type: 'object',
      required: ['conv', 'owner_id'],
      properties: { conv: { type: 'string' }, owner_id: { type: 'string' } },
    },
    capabilities: [CAP_BLOCK_WRITE, CAP_NET_HTTP],
    allowed_invokers: ['user'],
    invoke: async (args): Promise<CommandResult> => {
      const a = args as { conv?: unknown; owner_id?: unknown } | undefined;
      const conv = readString(a?.conv);
      const ownerId = readString(a?.owner_id);
      if (conv === null || ownerId === null)
        return { ok: false, error: 'set_owner requires string `conv` and `owner_id`' };
      try {
        const res = await app.client.setOwner({ conv, owner_id: ownerId });
        return { ok: true, data: { conv: res.conv.id, owner_id: res.conv.owner_id } };
      } catch (err) {
        return { ok: false, error: `set_owner failed: ${(err as Error).message}` };
      }
    },
  };
}

// ============================================================================
// ImProxyApp — the BlockApp (manifest + push→wake→ingest seam)
// ============================================================================

/** Options for constructing an ImProxyApp. */
export interface ImProxyAppOptions {
  /** IM service base URL (real client). Ignored if `client` is injected. */
  baseUrl?: string;
  /** Bearer token (real client). Ignored if `client` is injected. Held client-private. */
  token?: string;
  /** Injected client — tests pass a fake (no network); production omits it (real ImClient). */
  client?: ImClientApi;
  /** Pre-bound account (principal_id + display); usually set on register/boot. */
  account?: { principal_id: string; display: string };
}

/**
 * ImProxyApp — the concrete IM-proxy BlockApp. `manifest()` produces the AppManifest the
 * AppRegistry installs; the App captures its AppContext in `on_install` so the WS push
 * handler can drive the push→wake→ingest seam (durable-ish fold → set_state via ingest →
 * wake), mirroring messages' ingest front door (im-proxy.md §4).
 *
 * push→wake→ingest with COALESCE: incoming WS frames are buffered for `coalesce_ms`, then a
 * burst is folded in ONE `im.ingest` (host-stamped `invoker:'app'`) + ONE `ctx.wake`, so a
 * storm of pushes coalesces to a single re-render (wake-storm guard, §4).
 */
export class ImProxyApp {
  readonly client: ImClientApi;
  private ctx: AppContext<ImProxyState> | null = null;
  /** Monotonic counter for deterministic client_msg_ids within this instance. */
  private clientMsgSeq = 0;
  /** Buffered inbound frames awaiting coalesce flush. */
  private pending: { conv: string; msg: WireMessage }[] = [];
  /** The active coalesce timer (null between bursts). */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** WS unsubscribe thunk (set on_install, cleared on_uninstall). */
  private unsubscribe: (() => void) | null = null;
  private readonly seedAccount?: { principal_id: string; display: string };

  constructor(opts: ImProxyAppOptions = {}) {
    this.client =
      opts.client ??
      // Real client: endpoint + token from ENV (uniform with oa_proxy / task_proxy — the
      // token is env-ONLY, never config/flag/log, the ANTHROPIC_API_KEY rule). `IM_SERVICE_URL`
      // / `IM_SERVICE_TOKEN`; an explicit opt (tests) overrides. Unset → placeholder + empty
      // token → the proxy degrades to an empty projection (never throws). launch.ts installs
      // with `new ImProxyApp()` and lets this read env, so launch never handles a credential.
      new ImClient({
        baseUrl: opts.baseUrl ?? process.env['IM_SERVICE_URL'] ?? 'http://localhost:8083',
        token: opts.token ?? process.env['IM_SERVICE_TOKEN'] ?? '',
      });
    if (opts.account) this.seedAccount = opts.account;
  }

  /** The AppManifest to hand to AppRegistry.install. */
  manifest(): AppManifest {
    const app = this;
    const initial_state: ImProxyState = {
      conversations: [],
      config: { ...DEFAULT_CONFIG },
      ...(this.seedAccount ? { account: this.seedAccount } : {}),
    };
    const manifest: AppManifest<ImProxyState> = {
      id: APP_ID,
      version: '1.0.0',
      depends_on: [], // data deps go through contracts, never depends_on (deprecated)
      trust: 'trusted',
      host: 'in-process',
      // §5: provide the standard `message_count` contract via the app-facing readonly
      // `unread_count` command (a stats app sums it with messages' count, identity-free).
      provides: [{ contract: 'message_count', via: 'unread_count' }],
      // §5: consume oa_proxy's `org_directory` to resolve principal_id → display name.
      // Folded into state.directory by consume-refresh; pure enrichment, never identity.
      consumes: [{ contract: 'org_directory', as: 'directory' }],
      tree_namespace: TREE_NAMESPACE,
      initial_state,
      state_schema: STATE_SCHEMA,
      builders: [() => ConversationsBlockBuilder, () => ChatBlockBuilder],
      commands: [
        () => sendCommand(app),
        () => ingestCommand(app),
        () => openCommand(),
        () => listCommand(),
        () => unreadCountCommand(),
        () => setConfigCommand(),
        () => createGroupCommand(app),
        () => memberCommand(app, 'add'),
        () => memberCommand(app, 'remove'),
        () => setOwnerCommand(app),
      ],
      async on_install(ctx) {
        app.ctx = ctx as AppContext<ImProxyState>;
        // First screen + WS subscribe (best-effort; degrades if the service is down).
        await app.bootstrap();
        app.unsubscribe = app.client.subscribe((frame) => app.onFrame(frame));
      },
      async on_uninstall() {
        // Graceful teardown ONLY — never deletes durable data (INV #5). Close the WS and
        // cancel any pending coalesce flush.
        app.unsubscribe?.();
        app.unsubscribe = null;
        if (app.flushTimer !== null) {
          clearTimeout(app.flushTimer);
          app.flushTimer = null;
        }
        app.client.close();
      },
    };
    return manifest as AppManifest;
  }

  /**
   * bootstrap — first-screen load: GET /im/conversations, then per-conv backfill from
   * since=0. Pure-ish (network read only); folds the windows into state via set_state.
   * Degrades silently if the service is unreachable (the client returns empty).
   */
  async bootstrap(): Promise<void> {
    const ctx = this.ctx;
    if (ctx === null) return;
    const { conversations } = await this.client.listConversations();
    const cap = ctx.state.config.max_conversations;
    const window = ctx.state.config.window;
    const limited = conversations.slice(0, cap);

    // Seed empty conversation shells first (so foldMessages can find them).
    ctx.set_state((s) => {
      const focus = s.focus ?? limited[0]?.id;
      return {
        ...s,
        conversations: limited.map((c) => ({
          id: c.id,
          kind: c.kind,
          members: c.members.map((pid) => ({
            principal_id: pid,
            kind: 'human' as const,
            display: displayName(pid, s.directory),
          })),
          recent: [],
          unread: 0,
          consumed_seq: 0,
        })),
        ...(focus !== undefined ? { focus } : {}),
      };
    });

    // Per-conversation backfill (since each conv's consumed_seq, starting at 0).
    for (const c of limited) {
      const { messages } = await this.client.history(c.id, 0, window);
      if (messages.length === 0) continue;
      ctx.set_state((s) =>
        this.foldMessages(
          s,
          messages.map((msg) => ({ conv: c.id, msg })),
        ),
      );
    }
  }

  /** A deterministic, per-instance client_msg_id (idempotency key for im.send). */
  nextClientMsgId(): string {
    this.clientMsgSeq += 1;
    const selfId = this.ctx?.state.account?.principal_id ?? 'anon';
    return `${selfId}.${this.clientMsgSeq}`;
  }

  /**
   * foldMessages — pure transform: fold a batch of `{conv, msg}` into the matching
   * conversation windows (sanitizing `from` → `from_label`, judging `mentioned_me`, dedupe
   * by seq, advance per-conv consumed_seq, bump unread). A frame for an unknown conv is
   * dropped (the service is the truth source; an unseen conv arrives via a re-bootstrap).
   * Shared by im.send (optimistic), im.ingest (inbound), and bootstrap backfill.
   */
  foldMessages(state: ImProxyState, batch: { conv: string; msg: WireMessage }[]): ImProxyState {
    const selfId = state.account?.principal_id;
    const window = state.config.window;
    // Group projected messages by conv.
    const byConv = new Map<string, ImMessage[]>();
    for (const { conv, msg } of batch) {
      const list = byConv.get(conv) ?? [];
      list.push(projectMessage(msg, selfId));
      byConv.set(conv, list);
    }
    const conversations = state.conversations.map((c) => {
      const incoming = byConv.get(c.id);
      return incoming === undefined ? c : foldIntoConv(c, incoming, window);
    });
    return { ...state, conversations };
  }

  /**
   * onFrame — the WS push handler. `message` frames are buffered and coalesced; `presence`
   * and `ack` are handled inline (ack is a redundant fallback — the REST sync return already
   * reconciled the send, so a same-id ack is a no-op via dedupe-by-seq in foldMessages).
   */
  onFrame(frame: ImPushFrame): void {
    if (frame.type === 'message') {
      this.pending.push({ conv: frame.conv, msg: frame.msg });
      this.scheduleFlush();
    }
    // presence / ack: no state mutation needed in v1 (ack is reconciled by the REST return;
    // presence updates are folded on the next bootstrap/directory refresh).
  }

  /**
   * scheduleFlush — arm the coalesce timer if not already armed. A burst of pushes within
   * `coalesce_ms` flushes ONCE (one ingest + one wake), the wake-storm guard (§4).
   */
  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    const ms = this.ctx?.state.config.coalesce_ms ?? DEFAULT_CONFIG.coalesce_ms;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, ms);
  }

  /**
   * flush — drain the pending buffer: one `im.ingest` (host-stamps `invoker:'app'` — the
   * agent structurally cannot reach this front door) + one `ctx.wake` so the agent
   * re-renders once for the whole burst. The durable truth is the IM service; ingest folds
   * the bounded window. Exposed for tests to drive the seam without a real timer.
   */
  async flush(): Promise<void> {
    const ctx = this.ctx;
    if (ctx === null || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    // (1) ingest via invoke_command → host stamps invoker:'app' (the anti-jailbreak seam).
    await ctx.invoke_command(`${APP_ID}.ingest`, { messages: batch });
    // (2) one wake for the whole coalesced burst. A @-mention could raise priority, but it
    // still rides the single coalesced wake (does not break the wake-storm guard).
    const ref = batch[batch.length - 1]?.msg.id;
    const woke: WakeEvent = {
      kind: 'app_event',
      source: APP_ID,
      reason: 'im_message_arrived',
      ...(ref !== undefined ? { ref } : {}),
    };
    ctx.wake?.(woke);
  }
}

// Block names + defaults exported for tests / cross-app references.
export { CONVERSATIONS_BLOCK, CHAT_BLOCK, DEFAULT_CONFIG, labelFor, sanitizeId };
