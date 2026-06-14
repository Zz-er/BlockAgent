/**
 * @block-agent/server — SessionProtocol v0 host (barrel).
 *
 * Re-exports the SessionHost (transport-agnostic core) + the two transports (in-process,
 * WebSocket) + the `serve` entry. Design: ai_com/design/session-protocol-v0.md (D2) +
 * multi-terminal-and-web-inspector.md (D3) §3. `ws` lives only in this package.
 */

export { SessionHost, type OutboundSink } from './session_host.js';
export {
  connectInProcess,
  type InProcessConnection,
} from './in_process_transport.js';
export {
  startWsTransport,
  type WsTransport,
  type WsTransportOptions,
  type AuthenticateFn,
  type ConnectionInfo,
} from './ws_transport.js';
export { serve, type ServeOptions, type RunningServer } from './serve.js';
export { main as serveMain, resolveServeConfig } from './bin.js';
export { type HealthSnapshot } from './session_host.js';
