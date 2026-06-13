/**
 * server/in_process_transport.ts — the in-process SessionProtocol transport (D2 §3.1).
 *
 * The protocol with NO serialization: `send` is a direct `SessionHost.handle`, the stream
 * is a direct subscription. This is what the CLI already does (cli_channel + context_view),
 * re-expressed as "the in-process transport of SessionProtocol" — behavior-preserving
 * (D3 §2.1). It needs no new dependency; it is direct method calls.
 *
 * Usage: `connect(onFrame)` registers an outbound listener and returns a handle whose
 * `send(frame)` drives one inbound frame. The handle's per-request responses AND the
 * broadcast stream both arrive on `onFrame` (one client, one sink).
 */

import type { SessionHost, OutboundSink } from './session_host.js';
import type { InboundFrame, OutboundFrame } from '@block-agent/protocol/index.js';

/** A live in-process connection to a SessionHost. */
export interface InProcessConnection {
  /** Drive one inbound frame. Resolves after the host has handled it (turns settled, etc.). */
  send(frame: InboundFrame): Promise<void>;
  /** Detach this connection's outbound listener. The host keeps running. */
  close(): void;
}

/**
 * connectInProcess — open an in-process connection to a host. `onFrame` receives every
 * outbound frame for this connection: both the per-request responses (capabilities,
 * context) and the broadcast stream (thinking, error, turn, context_diff).
 */
export function connectInProcess(host: SessionHost, onFrame: OutboundSink): InProcessConnection {
  const sink: OutboundSink = (frame: OutboundFrame) => onFrame(frame);
  const unsubscribe = host.subscribe(sink);
  return {
    send: (frame: InboundFrame) => host.handle(frame, sink),
    close: () => unsubscribe(),
  };
}
