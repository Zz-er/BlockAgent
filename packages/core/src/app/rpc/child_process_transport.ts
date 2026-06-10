/**
 * app/rpc/child_process_transport.ts — unified-host UH-2/SS3b: the real Transport
 * backing RpcChannel over a Node child_process IPC channel (impl-spec §3.3/§3.9).
 *
 * SS3a's RpcChannel is carrier-agnostic — it rides an injected `Transport`. This file
 * supplies the concrete one for the cross-process carrier: the parent side wraps a
 * forked `ChildProcess` (`child.send` / `child.on('message')`), the child side wraps
 * its own `process` (`process.send` / `process.on('message')`). Both speak the same
 * `RpcFrame` JSON the channel emits — Node's IPC structured-clones plain objects, and
 * our frames are already by-value + blob-handled (RpcChannel.toByValue), so nothing
 * extra is serialized here.
 *
 * ── channel ⟂ transport responsibility split (Raven SS3a forward-finding #2) ───────
 * The RpcChannel deep-copies + blob-handles OUTBOUND values. The INBOUND size/depth
 * cap is the TRANSPORT's job: a hostile child can flood huge / deeply-nested frames to
 * pressure the parent's memory. So this transport bounds every inbound frame (byte
 * size of its JSON form + structural depth) BEFORE handing it to the channel; an
 * over-limit frame is DROPPED (not delivered), so the channel's per-call deadline then
 * fires (degrade, never OOM). The channel trusts the transport to deliver bounded data.
 *
 * PURE wrt the closure: only `node:child_process` types (type-only) + plain logic — no
 * third-party deps (CI core-closure). The parent factory takes an already-forked
 * `ChildProcessLike`; forking itself lives in ChildProcessHost (so this stays testable
 * with a fake duplex).
 */

import type { RpcFrame, Transport } from './channel.js';

/** The slice of Node's `ChildProcess` we use (kept minimal + structurally typed so a
 * test fake satisfies it without importing node:child_process). */
export interface ChildProcessLike {
  send(message: unknown): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** The slice of the child's own `process` we use (send + message). */
export interface ProcessLike {
  send?(message: unknown): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

export interface TransportLimits {
  /** Max inbound frame size in bytes (JSON form). Over-limit frames are dropped. */
  max_frame_bytes: number;
  /** Max inbound structural nesting depth. Over-limit frames are dropped. */
  max_frame_depth: number;
}

export const DEFAULT_LIMITS: TransportLimits = {
  max_frame_bytes: 1_000_000, // 1 MB per frame — generous for state/data, caps a flood
  max_frame_depth: 64, // deep enough for real trees, shallow enough to stop a bomb
};

/**
 * A structurally-bounded inbound guard: returns false if the value's JSON byte length
 * exceeds `max_frame_bytes` or its nesting depth exceeds `max_frame_depth`. Cheap depth
 * walk that short-circuits on the first violation (never fully materializes a bomb).
 */
function withinLimits(value: unknown, limits: TransportLimits): boolean {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return false; // unserializable (cycle / BigInt) — reject
  }
  if (json === undefined) return false;
  if (Buffer.byteLength(json, 'utf8') > limits.max_frame_bytes) return false;
  return depthWithin(value, limits.max_frame_depth, 0);
}

function depthWithin(value: unknown, max: number, depth: number): boolean {
  if (depth > max) return false;
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) {
    for (const el of value) if (!depthWithin(el, max, depth + 1)) return false;
    return true;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (!depthWithin(v, max, depth + 1)) return false;
  }
  return true;
}

/** True iff `v` has the minimal RpcFrame shape (object with a string `t`). */
function looksLikeFrame(v: unknown): v is RpcFrame {
  return typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string';
}

/**
 * Parent-side transport over a forked child. `child` is already spawned (ChildProcessHost
 * forks it). Inbound frames are bounded by `limits` before reaching the channel; an
 * over-limit or malformed inbound message is dropped (the channel's deadline degrades).
 */
export function parentTransport(
  child: ChildProcessLike,
  limits: TransportLimits = DEFAULT_LIMITS,
): Transport {
  let closed = false;
  return {
    send(frame: RpcFrame): void {
      if (closed) throw new Error('child_process transport is closed');
      child.send(frame); // Node IPC structured-clones the plain frame
    },
    onMessage(handler: (frame: RpcFrame) => void): void {
      child.on('message', (message: unknown) => {
        if (closed) return;
        if (!looksLikeFrame(message)) return; // garbage from a buggy/hostile child
        if (!withinLimits(message, limits)) return; // size/depth bomb → drop, let deadline fire
        handler(message);
      });
    },
    close(): void {
      closed = true; // process kill is ChildProcessHost.dispose's job (signal + reap)
    },
  };
}

/**
 * Child-side transport over the child's own `process`. Same inbound bounding applies
 * (defense-in-depth: the child also caps what the parent sends it).
 */
export function childTransport(
  proc: ProcessLike,
  limits: TransportLimits = DEFAULT_LIMITS,
): Transport {
  let closed = false;
  return {
    send(frame: RpcFrame): void {
      if (closed) throw new Error('child process has no IPC channel (not forked with ipc)');
      if (!proc.send) throw new Error('child process has no IPC channel (not forked with ipc)');
      proc.send(frame);
    },
    onMessage(handler: (frame: RpcFrame) => void): void {
      proc.on('message', (message: unknown) => {
        if (closed) return;
        if (!looksLikeFrame(message)) return;
        if (!withinLimits(message, limits)) return;
        handler(message);
      });
    },
    close(): void {
      closed = true;
    },
  };
}
