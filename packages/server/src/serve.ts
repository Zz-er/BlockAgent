/**
 * server/serve.ts — the small entry that builds a LaunchedAgent + starts the WS server.
 *
 * Design: ai_com/design/multi-terminal-and-web-inspector.md §3.1 ("build/own agent
 * sessions" — call the SAME launch() the CLI uses). `serve` is non-blocking: it resolves a
 * handle once listening, so a test can await it, read the port, drive it, and `close()` —
 * it never hangs the caller (no readline/stdin loop).
 *
 * It does NOT own config resolution flags; the caller passes a resolved LauncherConfig
 * (e.g. from `loadConfig`, or a `{ provider: { kind: 'mock' } }` for an offline run).
 */

import { launch } from '@block-agent/cli/launch.js';
import type { LauncherConfig } from '@block-agent/cli/types.js';

import { SessionHost } from './session_host.js';
import { startWsTransport, type WsTransport, type AuthenticateFn } from './ws_transport.js';

/** Options for `serve`. */
export interface ServeOptions {
  /** TCP port for the WS server (0 → an OS-assigned free port). */
  port: number;
  /** Bind host (default 127.0.0.1). */
  host?: string;
  /**
   * The auth membrane (D2 §4.3), forwarded to the WS transport. REQUIRED to bind a
   * non-loopback host — without it, a non-loopback bind THROWS (the host's default
   * `invoker:'user'` stamp is sound only for a trusted local connection; the remote
   * membrane is deferred to D4 §7-4). Absent + loopback (the default) is the v0 local case.
   */
  authenticate?: AuthenticateFn;
}

/** A running server: the host, the WS transport, and a combined shutdown. */
export interface RunningServer {
  readonly host: SessionHost;
  readonly transport: WsTransport;
  /** The bound port (resolved). */
  readonly port: number;
  /** Stop the WS server + detach the host (does not delete the agent's durable data). */
  close(): Promise<void>;
}

/**
 * serve — launch one agent session from `config` and front it with a WS SessionHost.
 * Resolves once the WS server is listening. The returned handle exposes the bound port and
 * a `close()` that stops the transport and detaches the host.
 *
 * The LaunchedAgent's lifecycle is owned by this server: `close()` detaches the host's
 * subscriptions + restores the wakeHook, then closes the socket server. (Physical teardown
 * of the agent's durable data is out of scope — INV #5 archival semantics, never deleted
 * here.)
 */
export async function serve(config: LauncherConfig, opts: ServeOptions): Promise<RunningServer> {
  const agent = await launch(config);
  const host = new SessionHost(agent);
  const transport = await startWsTransport(host, {
    port: opts.port,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.authenticate !== undefined ? { authenticate: opts.authenticate } : {}),
  });
  return {
    host,
    transport,
    port: transport.port,
    close: async () => {
      await transport.close();
      host.close();
    },
  };
}
