/**
 * apps/im_proxy/src/im_client.ts — ImClient: the IM service binding (network-isolated).
 *
 * This is the ONLY file in apps/im_proxy with a network dependency (`fetch` + a lazily
 * imported `ws`), mirroring memory_letta's `LettaMemoryStore` (DR-M4): the SDK/transport
 * is locked in here, the manifest only `import { ImClient, type ImClientApi }`. core's
 * runtime closure stays empty (CI core-closure) — apps/im_proxy is a cli runtime dep +
 * core devDep.
 *
 * Two surfaces:
 *   - `ImClientApi`  — the narrow interface the manifest depends on (so a test injects a
 *     fake client with zero network). REST request/response + history/conversations +
 *     a `subscribe(onFrame)` push seam.
 *   - `ImClient`     — the real, fetch/ws-backed implementation. The token is held
 *     PRIVATELY here (constructor param), never in App state, never rendered (im-proxy.md
 *     §3) — same discipline as memory_letta keeping base_url/key out of state.
 *
 * Trust (im-proxy.md §6): the IM service is the remote source of truth. The proxy is a
 * THIN projection — it forwards commands and folds pushes; it implements no service logic.
 *
 * Outbound `net:http` capability is declared on the COMMANDS (manifest.ts), not here.
 */

import type {
  ImConversationsResponse,
  ImGroupCreateResponse,
  ImGroupMemberResponse,
  ImGroupSetOwnerResponse,
  ImHistoryResponse,
  ImPushFrame,
  ImSendResponse,
} from './wire.js';

/**
 * ImClientApi — the narrow network surface the BlockApp depends on. The manifest holds
 * one of these; the real `ImClient` and the test fake both implement it, so the manifest
 * never touches `fetch`/`ws` directly. Every method is the proxy's THIN forward to a REST
 * endpoint, plus `subscribe` for the WS push seam.
 */
export interface ImClientApi {
  /** GET /im/conversations — this principal's conversation list (first screen). */
  listConversations(): Promise<ImConversationsResponse>;
  /** GET /im/history?conv=&since=&limit= — per-conv backfill (seq > since, ascending). */
  history(conv: string, since: number, limit?: number): Promise<ImHistoryResponse>;
  /** POST /im/send — send a message (from is token-derived server-side, §7). */
  send(req: {
    conv: string;
    body: string;
    client_msg_id: string;
    mentions?: string[];
  }): Promise<ImSendResponse>;
  /** POST /im/group/create — create a group (user/console only at the command gate). */
  createGroup(req: { title: string; members: string[] }): Promise<ImGroupCreateResponse>;
  /** POST /im/group/add_member. */
  addMember(req: { conv: string; principal_id: string }): Promise<ImGroupMemberResponse>;
  /** POST /im/group/remove_member. */
  removeMember(req: { conv: string; principal_id: string }): Promise<ImGroupMemberResponse>;
  /** POST /im/group/set_owner — transfer ownership. */
  setOwner(req: { conv: string; owner_id: string }): Promise<ImGroupSetOwnerResponse>;
  /**
   * WS /im/subscribe — open the multiplexed push stream. `onFrame` is called for each
   * frame; the returned thunk closes the stream. The proxy's WS handler does dedupe +
   * coalesce + ingest on top of this raw frame feed (manifest.ts §4).
   */
  subscribe(onFrame: (frame: ImPushFrame) => void): () => void;
  /** Graceful teardown — close the WS (on_uninstall; never deletes durable data, INV #5). */
  close(): void;
}

/** Construction options for the real ImClient. */
export interface ImClientOptions {
  /** IM service base URL, e.g. http://localhost:8083 — the `/im` REST + WS host. */
  baseUrl: string;
  /**
   * Opaque bearer token bound to this principal. Held privately here; NEVER stored in App
   * state, NEVER rendered (im-proxy.md §3). The service derives `from`/`owner` from it.
   */
  token: string;
}

/**
 * Lazy-loaded `ws` module cache. Imported on first `subscribe` so a build that does not
 * actually open a WS (e.g. a REST-only or offline run) never loads the transport, and
 * core — which only `import type`s through the manifest — never pulls it in (DR-M4).
 */
let _wsModule: typeof import('ws') | null = null;
async function getWs(): Promise<typeof import('ws')> {
  if (_wsModule === null) _wsModule = await import('ws');
  return _wsModule;
}

/**
 * ImClient — the real fetch/ws-backed IM service binding. Degrades rather than throwing
 * on a transport failure where it can (mirrors LettaMemoryStore): `listConversations`/
 * `history` return empty on a network error so a boot/backfill never crashes the turn
 * loop; `send` and the group-management calls surface the error to the command (the
 * command reports `ok:false`).
 */
export class ImClient implements ImClientApi {
  private readonly baseUrl: string;
  private readonly token: string;
  /** The open WS, lazily created by `subscribe`; closed by `close`. */
  private socket: { close(): void } | null = null;

  constructor(opts: ImClientOptions) {
    // Normalize trailing slash so `${base}/im/...` never doubles up.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    };
  }

  private async getJson<T>(path: string, fallback: T): Promise<T> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
      if (!res.ok) return fallback;
      return (await res.json()) as T;
    } catch {
      // Transport down → degrade (the proxy is a bounded window; the service is truth).
      return fallback;
    }
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`IM ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async listConversations(): Promise<ImConversationsResponse> {
    return this.getJson<ImConversationsResponse>('/im/conversations', { conversations: [] });
  }

  async history(conv: string, since: number, limit?: number): Promise<ImHistoryResponse> {
    const q = new URLSearchParams({ conv, since: String(since) });
    if (limit !== undefined) q.set('limit', String(limit));
    return this.getJson<ImHistoryResponse>(`/im/history?${q.toString()}`, {
      messages: [],
      latest_seq: since,
    });
  }

  async send(req: {
    conv: string;
    body: string;
    client_msg_id: string;
    mentions?: string[];
  }): Promise<ImSendResponse> {
    // NB: no `from` in the body — the service derives it from the token (§7 server fence).
    return this.postJson<ImSendResponse>('/im/send', req);
  }

  async createGroup(req: { title: string; members: string[] }): Promise<ImGroupCreateResponse> {
    return this.postJson<ImGroupCreateResponse>('/im/group/create', req);
  }

  async addMember(req: { conv: string; principal_id: string }): Promise<ImGroupMemberResponse> {
    return this.postJson<ImGroupMemberResponse>('/im/group/add_member', req);
  }

  async removeMember(req: { conv: string; principal_id: string }): Promise<ImGroupMemberResponse> {
    return this.postJson<ImGroupMemberResponse>('/im/group/remove_member', req);
  }

  async setOwner(req: { conv: string; owner_id: string }): Promise<ImGroupSetOwnerResponse> {
    return this.postJson<ImGroupSetOwnerResponse>('/im/group/set_owner', req);
  }

  subscribe(onFrame: (frame: ImPushFrame) => void): () => void {
    // Open the WS lazily (and asynchronously — the `ws` import is dynamic). The returned
    // thunk closes whatever socket has been opened by the time it runs.
    void this.openSocket(onFrame);
    return () => this.close();
  }

  private async openSocket(onFrame: (frame: ImPushFrame) => void): Promise<void> {
    const { WebSocket } = await getWs();
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/im/subscribe`;
    const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${this.token}` } });
    this.socket = socket;
    // CRITICAL: the `ws` WebSocket is an EventEmitter — an unhandled 'error' event is RE-THROWN
    // by Node and crashes the whole process. A connection failure (the IM service is absent /
    // not yet up) MUST be a graceful degrade, not a crash: drop the socket, no live push this
    // session (the HTTP fetch path already degrades and on_install never throws). Without this
    // handler, enabling im_proxy before its service is running kills the agent process.
    socket.on('error', () => {
      this.socket = null;
    });
    socket.on('message', (data: { toString(): string }) => {
      try {
        const frame = JSON.parse(data.toString()) as ImPushFrame;
        onFrame(frame);
      } catch {
        // A malformed frame is dropped — never crashes the push handler.
      }
    });
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      /* already closed — closing twice is harmless */
    }
    this.socket = null;
  }
}
