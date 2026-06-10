/**
 * app/rpc/channel.ts — unified-host UH-2/SS3a: the RpcChannel (impl-spec §3.3).
 *
 * A symmetric request/reply channel over an INJECTABLE transport. It is the wire
 * underneath ChildProcessHost ↔ child main (SS3b): the main process calls a method
 * the child registered (and vice-versa) without either side touching the carrier
 * directly. This file is carrier-AGNOSTIC on purpose — it takes a `Transport` (a
 * pair of `send` / `onMessage` / `close`), so it unit-tests against a pair of
 * in-memory ports with no process at all; SS3b supplies a child_process / MessagePort
 * transport with the same shape ("interface orthogonal to carrier", §3.3).
 *
 * Protocol (req/ack/reply, §3.3):
 *   - `req`   {id, method, args}  — one side invokes a method on the other.
 *   - `ack`   {id}                — optional liveness signal: the peer received the
 *                                   req and is working it. Resets the per-call deadline
 *                                   ONCE (so a slow-but-alive handler isn't killed by a
 *                                   200ms cap), but never disables it.
 *   - `reply` {id, ok, value|error} — the handler's result (ok) or a thrown error.
 *
 * Per-call deadline (§3.3/§3.7): every `call` arms a timer (default 200ms, matching
 * the per-provider consume-refresh timeout, §3.7). On expiry the pending call rejects
 * with a deadline error AND records a failure toward the circuit breaker.
 *
 * Circuit breaker (§3.3, non-blocking DoS item): consecutive deadline expiries or a
 * transport crash trip the channel to `dead`. A dead channel rejects every subsequent
 * `call` IMMEDIATELY (degrade, never hang) — this is what keeps one wedged child from
 * stalling the main process / a render turn. `dispose()` also moves to dead.
 *
 * Serialization (INV#18 by-value): everything crossing the wire is deep-copied and
 * any inline `Blob` bytes are replaced by a `blob://<sha256>` content-addressed handle
 * — NEVER inlined — in BOTH directions, args included (team-lead). See `toByValue`.
 *
 * PURE wrt the core closure: only `node:` primitives (`node:crypto` for the blob
 * hash), no third-party deps (CI core-closure). The transport itself is injected, so
 * this file imports no carrier.
 */

import { createHash } from 'node:crypto';

import type { Blob } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Public interface (impl-spec §3.3)
// ---------------------------------------------------------------------------

/**
 * A method handler. Return a value, a Promise of a value, or nothing (void → reply
 * null). `unknown` deliberately admits all three so a synchronous handler need not
 * wrap its result.
 */
export type RpcHandler = (args: unknown) => unknown;

export interface RpcChannel {
  /**
   * Invoke a method the peer registered with `on`. Resolves with the peer handler's
   * (by-value) return, rejects on a thrown handler error, a per-call deadline expiry,
   * or a dead channel. `deadline_ms` overrides the default (200ms, §3.7).
   */
  call(method: string, args: unknown, opts?: { deadline_ms?: number }): Promise<unknown>;
  /**
   * Register a handler for `method`. The peer's `call(method, …)` routes here; the
   * handler's return (or thrown error) is sent back as a `reply`. The return may be a
   * value, a Promise of a value, or void (replies with null). Last registration for a
   * method wins.
   */
  on(method: string, handler: RpcHandler): void;
  /** Tear down: reject all in-flight calls, stop listening, close the transport. */
  dispose(): void;
}

/**
 * Transport — the injected duplex the channel rides on. SS3b backs this with a
 * child_process IPC channel / MessagePort; tests back it with a paired in-memory
 * port. Frames are plain JSON-serializable objects (already by-value, blob-handled).
 */
export interface Transport {
  /** Hand one frame to the peer. May throw if the underlying carrier is gone. */
  send(frame: RpcFrame): void;
  /** Register the single inbound-frame sink. Called once by the channel. */
  onMessage(handler: (frame: RpcFrame) => void): void;
  /** Release the carrier. Idempotent. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export type RpcFrame =
  | { t: 'req'; id: number; method: string; args: unknown }
  | { t: 'ack'; id: number }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string };

// ---------------------------------------------------------------------------
// By-value serialization (INV#18): deep copy + inline Blob → blob://<sha256>
// ---------------------------------------------------------------------------

/** True for a `{ data, mime_type }` shape — the structural Blob marker (no class). */
function isBlob(v: unknown): v is Blob {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { data?: unknown }).data === 'string' &&
    typeof (v as { mime_type?: unknown }).mime_type === 'string'
  );
}

/** A blob whose `data` is already a `blob://<sha256>` handle (not inline bytes). */
function isBlobHandle(b: Blob): boolean {
  return b.data.startsWith('blob://');
}

/**
 * Deep-copy `value` for the wire and replace any inline-byte Blob with a
 * `blob://<sha256(data)>` handle (INV#18: blobs travel by handle across an untrusted
 * boundary, never inlined). An already-`blob://` handle passes through unchanged.
 * Rejects functions / symbols / cyclic graphs (a wire value must be plain data) so a
 * non-serializable arg fails loudly here rather than corrupting the peer.
 */
export function toByValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') {
    // undefined is allowed only as an absent property (handled in the object branch);
    // a bare top-level undefined is normalized by callers to a reply value of null.
    if (t === 'undefined') return undefined;
    throw new RpcSerializationError(`cannot serialize a ${t} across the RPC boundary`);
  }
  if (t !== 'object') return value; // string | number | boolean — primitives copy by value

  const obj = value as object;
  if (seen.has(obj)) throw new RpcSerializationError('cannot serialize a cyclic value');
  seen.add(obj);

  try {
    if (isBlob(obj)) {
      const b = obj as Blob;
      const data = isBlobHandle(b) ? b.data : `blob://${sha256(b.data)}`;
      // Copy only the known Blob fields (drops any smuggled extras), by value.
      const out: Blob = { data, mime_type: b.mime_type };
      if (b.filename !== undefined) out.filename = b.filename;
      if (b.size !== undefined) out.size = b.size;
      return out;
    }
    if (Array.isArray(obj)) return obj.map((el) => toByValue(el, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue; // drop undefined props (JSON semantics)
      out[k] = toByValue(v, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RpcDeadlineError extends Error {
  constructor(method: string, deadline_ms: number) {
    super(`rpc call '${method}' exceeded its ${deadline_ms}ms deadline`);
    this.name = 'RpcDeadlineError';
  }
}

export class RpcChannelDeadError extends Error {
  constructor(method: string, reason: string) {
    super(`rpc channel is dead (${reason}); call '${method}' rejected without dispatch`);
    this.name = 'RpcChannelDeadError';
  }
}

export class RpcSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcSerializationError';
  }
}

// ---------------------------------------------------------------------------
// FramedRpcChannel
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  acked: boolean;
  method: string;
  deadline_ms: number;
}

export interface FramedRpcChannelOptions {
  /** Default per-call deadline. §3.7: 200ms (consume-refresh per-provider timeout). */
  default_deadline_ms?: number;
  /** Consecutive failures that trip the breaker to `dead`. Default 3. */
  breaker_threshold?: number;
}

const DEFAULT_DEADLINE_MS = 200;
const DEFAULT_BREAKER_THRESHOLD = 3;

export class FramedRpcChannel implements RpcChannel {
  private readonly transport: Transport;
  private readonly defaultDeadlineMs: number;
  private readonly breakerThreshold: number;

  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, RpcHandler>();

  private consecutiveFailures = 0;
  private dead = false;
  private deadReason = '';

  constructor(transport: Transport, opts: FramedRpcChannelOptions = {}) {
    this.transport = transport;
    this.defaultDeadlineMs = opts.default_deadline_ms ?? DEFAULT_DEADLINE_MS;
    this.breakerThreshold = opts.breaker_threshold ?? DEFAULT_BREAKER_THRESHOLD;
    this.transport.onMessage((frame) => this.onFrame(frame));
  }

  /** Whether the breaker has tripped (exposed for the host/tests to observe degrade). */
  get is_dead(): boolean {
    return this.dead;
  }

  call(method: string, args: unknown, opts?: { deadline_ms?: number }): Promise<unknown> {
    if (this.dead) {
      // Degrade immediately — never hand a wedged channel another in-flight call.
      return Promise.reject(new RpcChannelDeadError(method, this.deadReason));
    }
    const deadline_ms = opts?.deadline_ms ?? this.defaultDeadlineMs;
    // Serialize args eagerly so a non-serializable arg rejects synchronously (before
    // we allocate an id / arm a timer), and so the breaker is never charged for it.
    let wireArgs: unknown;
    try {
      wireArgs = toByValue(args);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.onDeadline(id), deadline_ms);
      // Do not keep the event loop alive solely for an RPC timer (Node-only API).
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, timer, acked: false, method, deadline_ms });
      try {
        this.transport.send({ t: 'req', id, method, args: wireArgs });
      } catch (err) {
        // Transport threw on send (carrier gone): fail this call + trip the breaker.
        this.settle(id, false, err instanceof Error ? err.message : String(err));
        this.recordFailure('transport send failed');
      }
    });
  }

  on(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  dispose(): void {
    if (this.dead) {
      this.transport.close();
      return;
    }
    this.markDead('disposed');
    this.transport.close();
  }

  // -- inbound frame routing --------------------------------------------------

  private onFrame(frame: RpcFrame): void {
    // Harden against a hostile / buggy peer: a non-object or tag-less frame is garbage,
    // never let property access on it throw out of the inbound path.
    if (typeof frame !== 'object' || frame === null || typeof (frame as { t?: unknown }).t !== 'string') {
      this.recordFailure('malformed frame');
      return;
    }
    // A dead channel ignores late inbound frames (its pending map is already drained).
    if (this.dead && frame.t !== 'req') return;
    switch (frame.t) {
      case 'req':
        void this.handleReq(frame);
        return;
      case 'ack': {
        const p = this.pending.get(frame.id);
        if (p && !p.acked) {
          // Liveness: peer is working it. Re-arm the deadline ONCE so a slow-but-alive
          // handler isn't killed, but never disable it (a wedged handler still times out).
          p.acked = true;
          clearTimeout(p.timer);
          p.timer = setTimeout(() => this.onDeadline(frame.id), p.deadline_ms);
          (p.timer as { unref?: () => void }).unref?.();
        }
        return;
      }
      case 'reply':
        if (frame.ok) this.settle(frame.id, true, frame.value);
        else this.settle(frame.id, false, frame.error);
        return;
      default:
        // Unknown / malformed frame: ignore (a bad peer must not crash us). Charge a
        // failure so a peer that floods garbage eventually trips the breaker.
        this.recordFailure('malformed frame');
    }
  }

  private async handleReq(frame: { id: number; method: string; args: unknown }): Promise<void> {
    const handler = this.handlers.get(frame.method);
    // Acknowledge receipt so the caller's deadline reflects handler time, not queue time.
    this.trySend({ t: 'ack', id: frame.id });
    if (!handler) {
      this.trySend({ t: 'reply', id: frame.id, ok: false, error: `no handler for '${frame.method}'` });
      return;
    }
    try {
      const result = await handler(frame.args);
      const value = result === undefined ? null : toByValue(result);
      this.trySend({ t: 'reply', id: frame.id, ok: true, value });
    } catch (err) {
      this.trySend({
        t: 'reply',
        id: frame.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -- settlement + breaker ---------------------------------------------------

  private onDeadline(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.settle(id, false, `deadline ${p.deadline_ms}ms`, 'deadline');
    this.recordFailure('deadline expired');
  }

  /**
   * Resolve / reject a pending call and clear its timer. `kind:'deadline'` builds the
   * typed RpcDeadlineError; otherwise a generic Error carries the peer's message.
   */
  private settle(id: number, ok: boolean, payload: unknown, kind?: 'deadline'): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (ok) {
      this.consecutiveFailures = 0; // a clean reply resets the breaker
      p.resolve(payload);
    } else if (kind === 'deadline') {
      p.reject(new RpcDeadlineError(p.method, p.deadline_ms));
    } else {
      p.reject(new Error(String(payload)));
    }
  }

  private recordFailure(reason: string): void {
    if (this.dead) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.breakerThreshold) {
      this.markDead(`circuit breaker tripped after ${this.consecutiveFailures} failures (${reason})`);
    }
  }

  /** Trip to dead: reject every in-flight call so no caller hangs on a gone peer. */
  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.deadReason = reason;
    const inflight = [...this.pending.values()];
    this.pending.clear();
    for (const p of inflight) {
      clearTimeout(p.timer);
      p.reject(new RpcChannelDeadError(p.method, reason));
    }
  }

  /** Send a frame, swallowing a transport throw (an outbound failure can't crash us). */
  private trySend(frame: RpcFrame): void {
    try {
      this.transport.send(frame);
    } catch {
      this.recordFailure('transport send failed');
    }
  }
}
