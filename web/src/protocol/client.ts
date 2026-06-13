// ============================================================================
// SessionProtocolClient — the WebSocket transport (§3.2)
// ============================================================================
//
// A thin, read-mostly client: connect, do the hello→capabilities handshake,
// dispatch each inbound frame to subscribers, and expose typed sends. The ONLY
// write it ever issues is the user's `submit` (§4.7) — everything else is `query`
// (read-only) or `control` (wake-seam timing). It never sends `invoke_command`
// and never names its own invoker tier; the host stamps invoker:'user' at the
// trust membrane (§4.3).
//
// Forward-compat (§4.1): unknown frame kinds are ignored, not fatal.

import {
  isOutboundFrame,
  PROTOCOL_VERSION,
  V0_EMITS,
  type CapabilitiesFrame,
  type ControlFrame,
  type ControlOp,
  type HelloFrame,
  type OutboundFrame,
  type QueryFrame,
  type QueryTarget,
  type SubmitFrame,
} from './index.js';

export type ConnectionState = 'connecting' | 'open' | 'closed';

type FrameListener = (frame: OutboundFrame) => void;
type StateListener = (state: ConnectionState) => void;

export interface SessionProtocolClientOptions {
  url: string;
  /** auto-reconnect backoff base in ms (0 disables). */
  reconnectMs?: number;
}

export class SessionProtocolClient {
  private readonly url: string;
  private readonly reconnectMs: number;
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'closed';
  private reqCounter = 0;
  private disposed = false;

  private readonly frameListeners = new Set<FrameListener>();
  private readonly stateListeners = new Set<StateListener>();

  /** Host capabilities, populated from the `capabilities` handshake reply. */
  capabilities: CapabilitiesFrame | null = null;

  constructor(options: SessionProtocolClientOptions) {
    this.url = options.url;
    this.reconnectMs = options.reconnectMs ?? 1000;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.socket && (this.state === 'open' || this.state === 'connecting')) return;
    this.setState('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.setState('open');
      this.sendHello();
    };

    socket.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    socket.onerror = () => {
      // surfaced via onclose; nothing actionable here on the browser side.
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.setState('closed');
      this.scheduleReconnect();
    };
  }

  dispose(): void {
    this.disposed = true;
    this.frameListeners.clear();
    this.stateListeners.clear();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  }

  // --- subscriptions -------------------------------------------------------

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  // --- sends (the only write is `submit`) ----------------------------------

  /** User text → host stamps invoker:'user' (§2.6). The one write path. */
  submit(text: string): void {
    const frame: SubmitFrame = { kind: 'submit', v: PROTOCOL_VERSION, text };
    this.send(frame);
  }

  /**
   * Read-only inspection request (§2.7). Returns the request_id so the caller can
   * correlate the response (frames echo request_id back). `verbose` requests full
   * segment text; `app_id` scopes an app_preview.
   */
  query(
    target: QueryTarget,
    opts: {
      scope?: QueryFrame['scope'];
      verbose?: boolean;
      app_id?: string;
      block_name?: string;
    } = {},
  ): string {
    const request_id = `q-${++this.reqCounter}`;
    const frame: QueryFrame = {
      kind: 'query',
      v: PROTOCOL_VERSION,
      request_id,
      target,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.verbose ? { verbose: opts.verbose } : {}),
      ...(opts.app_id ? { app_id: opts.app_id } : {}),
      ...(opts.block_name ? { block_name: opts.block_name } : {}),
    };
    this.send(frame);
    return request_id;
  }

  /** Wake-seam timing control (§2.8). Never a tree write, never a policy decision. */
  control(op: ControlOp): void {
    const frame: ControlFrame = { kind: 'control', v: PROTOCOL_VERSION, op };
    this.send(frame);
  }

  // --- internals -----------------------------------------------------------

  private sendHello(): void {
    const frame: HelloFrame = {
      kind: 'hello',
      v: PROTOCOL_VERSION,
      client: 'block-agent-web',
      understands: [...V0_EMITS],
    };
    this.send(frame);
  }

  private send(frame: object): void {
    if (this.socket && this.state === 'open') {
      this.socket.send(JSON.stringify(frame));
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // malformed frame — ignore (forward-compat tolerance).
    }
    if (!isOutboundFrame(parsed)) return; // unknown kind — ignore (§4.1).

    if (parsed.kind === 'capabilities') {
      this.capabilities = parsed;
    }
    for (const listener of this.frameListeners) listener(parsed);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectMs <= 0) return;
    setTimeout(() => this.connect(), this.reconnectMs);
  }
}
