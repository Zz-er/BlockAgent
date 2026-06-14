/**
 * server/ws_transport.ts — the WebSocket SessionProtocol transport (D2 §3.2).
 *
 * Each protocol frame is ONE JSON text frame. Inbound: parse, validate `{kind, v}`,
 * dispatch to the SessionHost. Outbound: JSON.stringify each broadcast/response frame and
 * send. `ws` lives ONLY in this package (the core-closure rule, D3 §3.2) — like Letta in
 * app-memory_letta. The host stays transport-agnostic; this is a thin adapter over it.
 *
 * Per connected socket we open ONE SessionHost subscription so the socket receives the
 * broadcast stream (thinking/error/turn/context_diff), and route per-request responses
 * (capabilities/context) to the same socket. A malformed/oversized frame is answered with
 * a benign `error` frame (the forward-compat rule, §4.1), never a dropped connection.
 *
 * NOTE: in v0 a single WS server fronts ONE SessionHost (one LaunchedAgent). Multiplexing
 * N sessions behind a supervisor (§4.4) is additive and out of scope here.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import type { SessionHost, OutboundSink, HealthSnapshot } from './session_host.js';
import type { InvokerContext } from '@block-agent/core/core/types.js';
import {
  PROTOCOL_VERSION,
  type InboundFrame,
  type OutboundFrame,
  type ErrorFrame,
} from '@block-agent/protocol/index.js';

/**
 * Per-connection info the auth membrane sees when deciding the invoker (D2 §4.3). v0 keeps
 * it minimal (the remote address + the `hello`, if any); D4 widens it (TLS client cert,
 * bearer token, operator grant). Deliberately small so the membrane stays cheap.
 */
export interface ConnectionInfo {
  /** The socket's remote address (e.g. '127.0.0.1' / '::1'), if the transport knows it. */
  remote_address?: string;
}

/**
 * The auth membrane (D2 §4.3): map an authenticated connection to the invoker the host will
 * stamp on its `submit`/`control`. Returning `null` REJECTS the connection (closed, no
 * frames dispatched). A local/operator grant returns `{invoker:'user'}`; a foreign driver
 * returns a non-user principal (`{invoker:'app', identity:'ext:<src>'}`). The wire NEVER
 * carries the invoker — this is the only place it is decided (anti-jailbreak, §4.3). v0
 * ships WITHOUT a default implementation: a non-loopback bind requires one (see below).
 */
export type AuthenticateFn = (info: ConnectionInfo) => InvokerContext | null;

/** Options for the WS transport. */
export interface WsTransportOptions {
  /** TCP port to listen on. */
  port: number;
  /** Bind host (default 127.0.0.1 — loopback; a local operator connection, §4.3). */
  host?: string;
  /**
   * The auth membrane (D2 §4.3). When provided, the host stamps each connection's invoker
   * from its return (null ⇒ reject the connection). When ABSENT, the transport stamps the
   * loopback-only default `{invoker:'user'}` — and so REFUSES a non-loopback bind (a remote
   * silently stamped 'user' would violate §4.3 rules 2/3; the real foreign→'app' /
   * unauthenticated→reject membrane is deferred to D4 §7-4). This is the forward seam that
   * lets D4 land remote auth without touching this transport's shape.
   */
  authenticate?: AuthenticateFn;
  /**
   * Optional liveness probe (D6 §8 seam 3). When supplied, the transport serves `GET /health`
   * with this snapshot as JSON on the SAME port the WS server binds — so a supervisor can poll
   * `{state, wake_seq, turn_index}` without opening the protocol. It is a READ-ONLY probe (no
   * invoker, no auth membrane needed): it exposes only liveness counters, never tree content
   * or a side effect, so it is safe even when the WS path itself is loopback-gated. Absent ⇒
   * no HTTP route is served (every request 426-upgrades, the prior WS-only behavior).
   */
  health?: () => HealthSnapshot;
}

/** Loopback hosts that need no auth membrane in v0 (a local operator connection, §4.3). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

/** Whether a bind host is loopback (so the unconditional 'user' stamp is sound, §4.3). */
function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** A running WS transport over a SessionHost. */
export interface WsTransport {
  /** The bound port (resolved once listening — useful when port:0 picks a free one). */
  readonly port: number;
  /** Stop accepting connections and close all sockets. */
  close(): Promise<void>;
}

/** Serialize one outbound frame to a JSON text frame. */
function serialize(frame: OutboundFrame): string {
  return JSON.stringify(frame);
}

/**
 * parseInbound — parse + minimally validate a received text frame. Returns the frame on
 * success, or an ErrorFrame to send back on a malformed/over-version payload (never
 * throws). We check it is an object with a string `kind` and the `v` envelope; deeper
 * shape validation is the host's switch (an unknown kind gets a benign error there).
 */
function parseInbound(data: string): InboundFrame | ErrorFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return benignError('malformed JSON frame');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return benignError('frame is not an object');
  }
  const obj = parsed as { kind?: unknown; v?: unknown };
  if (typeof obj.kind !== 'string') {
    return benignError('frame missing string `kind`');
  }
  // Major-version gate (§4.1): refuse a frame whose `v` major differs. v0 has one major.
  if (obj.v !== undefined && obj.v !== PROTOCOL_VERSION) {
    return benignError(`unsupported protocol version: ${String(obj.v)}`);
  }
  // Default the envelope `v` so a lenient client that omits it still dispatches.
  return { v: PROTOCOL_VERSION, ...(parsed as object) } as InboundFrame;
}

function benignError(message: string): ErrorFrame {
  return { kind: 'error', v: PROTOCOL_VERSION, message, phase: 'turn', spawn_depth: 0 };
}

/**
 * startWsTransport — start a WebSocket server fronting `host`. Resolves once listening
 * (so callers/tests can read the bound `port`). Each connection gets its own host
 * subscription; its inbound frames are dispatched to the host, its outbound frames sent
 * back over the socket.
 *
 * FAIL-CLOSED SECURITY GUARD (D2 §4.3): a non-loopback bind WITHOUT an `authenticate`
 * membrane THROWS synchronously, before binding. The host stamps `submit`/`control` with
 * `{invoker:'user'}` by default — sound ONLY for a trusted local connection — so exposing
 * the socket beyond loopback without an auth membrane would silently grant every remote the
 * `user` tier (a §4.3 rule 2/3 violation, the anti-jailbreak escape). The real remote
 * membrane (foreign→'app'+identity, unauthenticated→reject) is deferred to D4 §7-4; until
 * it ships, this guard makes the unsafe config unreachable rather than silent.
 */
export function startWsTransport(
  host: SessionHost,
  opts: WsTransportOptions,
): Promise<WsTransport> {
  const bindHost = opts.host ?? '127.0.0.1';

  // The fail-closed guard — thrown BEFORE the Promise/bind so a misconfig surfaces at the
  // call site, not as an async listen error.
  if (!isLoopbackHost(bindHost) && opts.authenticate === undefined) {
    throw new Error(
      `Refusing to bind the SessionProtocol WS server to a non-loopback host ('${bindHost}') ` +
        `without an auth membrane: the host stamps invoker:'user' by default, so a remote ` +
        `connection would be silently granted the 'user' tier (D2 §4.3 rules 2/3). Provide ` +
        `an \`authenticate\` hook (foreign → non-user, unauthenticated → reject) before ` +
        `exposing this non-locally — the remote auth membrane is deferred to D4 §7-4. ` +
        `For local use, bind 127.0.0.1 (the default).`,
    );
  }

  return new Promise((resolve, reject) => {
    // Own an explicit HTTP server so the WS upgrade AND the `GET /health` probe can share one
    // port (D6 §8 seam 3). `ws` would otherwise create its own bare server; we pass ours so a
    // plain HTTP request can be answered (health) while upgrades still reach the WS server.
    const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      handleHttp(req, res, opts.health);
    });
    const wss = new WebSocketServer({ server: httpServer });

    httpServer.on('error', reject);
    wss.on('error', reject);

    wss.on('connection', (socket: WebSocket, req: { socket?: { remoteAddress?: string } }) => {
      // This socket's outbound sink: serialize + send (only while OPEN). One subscription
      // per socket so it receives the broadcast stream; the same sink answers requests.
      const sink: OutboundSink = (frame: OutboundFrame) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(serialize(frame));
        }
      };

      // Resolve THIS connection's invoker at the membrane (D2 §4.3), never from the wire.
      // With an auth hook: its return is the stamp; `null` rejects the connection. Without
      // one (loopback-only, guarded above): the trusted-local default `{invoker:'user'}`.
      const info: ConnectionInfo = { remote_address: req?.socket?.remoteAddress ?? '' };
      const invoker = opts.authenticate
        ? opts.authenticate(info)
        : ({ invoker: 'user' } as InvokerContext);
      if (invoker === null) {
        // Unauthenticated → reject (§4.3 rule 3). Close without dispatching any frame.
        socket.close(1008, 'unauthenticated');
        return;
      }

      const unsubscribe = host.subscribe(sink);

      socket.on('message', (raw: unknown) => {
        const text = typeof raw === 'string' ? raw : String(raw);
        const frame = parseInbound(text);
        if (frame.kind === 'error') {
          sink(frame);
          return;
        }
        // Dispatch through the host with the CONNECTION's authenticated invoker (never a
        // wire-supplied one). A handler error becomes a benign error frame rather than
        // crashing the socket loop.
        void host.handle(frame, sink, invoker).catch((err: unknown) => {
          sink(benignError(err instanceof Error ? err.message : String(err)));
        });
      });

      socket.on('close', () => unsubscribe());
      socket.on('error', () => unsubscribe());
    });

    httpServer.on('listening', () => {
      const address = httpServer.address();
      const port = typeof address === 'object' && address !== null ? address.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const client of wss.clients) client.terminate();
            // Close the WS server first (detaches its upgrade handler), then the HTTP server.
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });

    httpServer.listen(opts.port, bindHost);
  });
}

/**
 * handleHttp — answer a plain (non-upgrade) HTTP request. The only route is the liveness
 * probe `GET /health` (D6 §8 seam 3): a supervisor polls it for `{state, wake_seq, turn_index}`
 * as JSON. Everything else gets 404. When no `health` callback is wired the route is absent
 * (404 too), preserving the prior WS-only posture. A throwing probe degrades to 500 rather
 * than crashing the server loop. No auth: the probe is read-only liveness, no tree content.
 */
function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  health: (() => HealthSnapshot) | undefined,
): void {
  // Strip any query string; we only match the path.
  const path = (req.url ?? '').split('?')[0];
  if (health !== undefined && req.method === 'GET' && path === '/health') {
    try {
      const body = JSON.stringify(health());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"health probe failed"}');
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
}
