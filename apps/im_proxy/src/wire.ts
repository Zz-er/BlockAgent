/**
 * apps/im_proxy/src/wire.ts — IM service client wire types (TYPE-ONLY mirror).
 *
 * mirrors @blockai/contracts/im.ts §3 (types) + §4 (REST) + §5 (WS frames).
 *
 * These are a hand-mirrored, `import type`-only copy of the IM service API contract.
 * im_proxy is NOT allowed a dependency on BlockAI-team (Architect ruling) — instead we
 * re-declare the client-side wire shapes here, header-cited, so a contract drift is
 * caught by review against the SSOT, not by a cross-repo dep. Nothing here has a runtime
 * value (pure interfaces / string-literal unions) — it never enters core's runtime
 * closure (CI core-closure), same discipline as memory_letta isolating the Letta SDK.
 *
 * SECURITY (im-proxy.md §7): `from` and `mentions[]` are CONTENT channels, never
 * identity. They flow into state + the pure builder (sanitized `im:` label), and MUST
 * NEVER reach `ctx.identity`. The service derives `from` from the bearer token and
 * ignores any request-body `from` — that is an orthogonal second fence on the server.
 */

/** A principal is a human or an agent (im.ts §3). */
export type PrincipalKind = 'human' | 'agent';

/** Online presence (im.ts §3 / §5 presence frame). */
export type PresenceStatus = 'online' | 'offline';

/**
 * Conversation kind — dm (单聊) or group (群聊). Application `notice` is v1 DEFERRED
 * (im.ts §3 / §4.7 placeholder) and intentionally NOT in this union.
 */
export type ConvKind = 'dm' | 'group';

/** A directory principal as the IM service projects it (im.ts §3). */
export interface WirePrincipal {
  id: string;
  kind: PrincipalKind;
  org_id: string | null;
  display: string;
  /** agent-only: its SessionProtocol/WS endpoint. */
  endpoint?: string;
  status: PresenceStatus;
}

/** A conversation as the IM service returns it (im.ts §3 / §4.4). */
export interface WireConversation {
  id: string;
  kind: ConvKind;
  /** group may carry a title; dm leaves it undefined. */
  title?: string;
  /** group owner principal_id (membership-edit authority); undefined for dm. */
  owner_id?: string;
  /** principal_id[]. */
  members: string[];
}

/**
 * One message on the wire (im.ts §3). `from` is a principal_id the SERVICE derives from
 * the token (never the request body); `mentions` is the @-list. Both are CONTENT — the
 * proxy sanitizes them for display and never lets them touch identity (§7).
 */
export interface WireMessage {
  id: string;
  conv: string;
  /** principal_id — service-derived from token; CONTENT, never authority (§7). */
  from: string;
  body: string;
  /** @-mentioned principal_id[] (group). CONTENT — self-@ is a string-equality check. */
  mentions?: string[];
  /** wall-clock epoch ms (display only). */
  ts: number;
  /** per-conversation monotonic seq — sort + dedupe key (im.ts §3). */
  seq: number;
}

// ── REST contract (im.ts §4). base: /im, with Authorization: Bearer <token>. ──────────

/** §4.1 POST /im/register — console-mediated; mints a principal + token. */
export interface ImRegisterRequest {
  id: string;
  kind: PrincipalKind;
  display: string;
  org_id?: string;
  endpoint?: string;
}
export interface ImRegisterResponse {
  principal_id: string;
  token: string;
}

/** §4.2 POST /im/send — send a message. Idempotent on (from, client_msg_id). */
export interface ImSendRequest {
  conv: string;
  body: string;
  /** sender idempotency key (uuid). */
  client_msg_id: string;
  /** @-mentioned principal_id[] (must be conv members). `from` is token-derived, NOT here. */
  mentions?: string[];
}
export interface ImSendResponse {
  id: string;
  /** service-assigned authoritative seq. */
  seq: number;
  ts: number;
}

/**
 * §4.3 GET /im/history?conv=&since=&limit= — backfill main path. Returns the messages
 * with seq > since, ascending. PER-CONVERSATION cursor (im-proxy.md §4): each conv has
 * its own independent seq space.
 */
export interface ImHistoryResponse {
  messages: WireMessage[];
  /** the conv's current max seq. */
  latest_seq: number;
}

/** §4.4 GET /im/conversations — this principal's conversation list (first screen). */
export interface ImConversationsResponse {
  conversations: WireConversation[];
}

/** §4.5 GET /im/directory — address book (projected from OA). */
export interface ImDirectoryResponse {
  principals: WirePrincipal[];
}

/** §4.6.1 POST /im/group/create — create a group (owner defaults to the creator). */
export interface ImGroupCreateRequest {
  title: string;
  /** principal_id[] (initial members, incl. owner). */
  members: string[];
}
export interface ImGroupCreateResponse {
  conv: WireConversation;
}

/** §4.6.2 POST /im/group/{add,remove}_member — owner/console membership edit. */
export interface ImGroupMemberRequest {
  conv: string;
  principal_id: string;
}
export interface ImGroupMemberResponse {
  conv: WireConversation;
}

/** §4.6.3 POST /im/group/set_owner — transfer ownership (new owner must be a member). */
export interface ImGroupSetOwnerRequest {
  conv: string;
  owner_id: string;
}
export interface ImGroupSetOwnerResponse {
  conv: WireConversation;
}

/**
 * §5 WS push frames. WS /im/subscribe, with token. ONE multiplexed WS covers every
 * conversation this principal belongs to. `msg.seq` is the dedupe/sort key; "I was @-ed"
 * is the proxy's own `msg.mentions.includes(self)` self-judgement (the frame does NOT
 * carry `mentioned_me`). The `ack` frame is a redundant fallback — the REST sync return
 * is the primary delivery confirmation (im-proxy.md §8).
 */
export type ImPushFrame =
  | { type: 'message'; conv: string; msg: WireMessage }
  | { type: 'presence'; principal_id: string; status: PresenceStatus }
  | { type: 'ack'; client_msg_id: string; id: string; seq: number };
