/**
 * app/rpc/app_context_proxy.ts — unified-host UH-2/SS3b: the cross-process AppContext
 * (impl-spec §3.3). Runs in the CHILD process; it is the AppContext handed to a
 * sandboxed app's command handler. Every member maps to an RpcChannel call/handler so
 * the app code is unaware it is out-of-process ("interface orthogonal to carrier").
 *
 * ── Whitelist parity (Raven SS3 hard-gate) ─────────────────────────────────────────
 * The proxy exposes EXACTLY the in-process AppContext's members and NOTHING else —
 * never the RpcChannel, the transport, an Operations/apply handle, the AppHost, or the
 * taint write-end (`run_in_chain`/`taintStore`). The shared whitelist assertion
 * (test/_support/appcontext_whitelist) pins both carriers to one set. The channel is a
 * CLOSURE-CAPTURED private, never a member — so member enumeration (own+proto) cannot
 * reach it. This is what makes the escalation chain unreachable from app code (a
 * sandboxed handler can never obtain the write-end to forge a trusted frame).
 *
 * ── Function args never cross the wire ─────────────────────────────────────────────
 * `set_state(updater)` and `on(event, handler)` take FUNCTIONS. Functions are not
 * serializable and must not leave the child. So: `set_state` runs the updater LOCALLY
 * against a child-local state copy, then frames only the resulting next-state value
 * back to the main process (which is the authoritative schema gate + cell writer,
 * §3.6 / 补强①). `on` registers the handler LOCALLY; the main process delivers events
 * by framing `__event` payloads to the child, which dispatches to local handlers.
 *
 * ── Sync `state` over an async boundary (§3.6) ─────────────────────────────────────
 * `state` is a synchronous getter, but the wire is async. The child holds a LOCAL
 * working copy of state (seeded at handshake, updated by set_state); `state` returns
 * that copy synchronously. The AUTHORITATIVE source for pull/projection is the
 * main-process cell (set_state frames write it) — the child copy is just the handler's
 * own view. set_state double-writes: local copy + frame to the cell.
 *
 * PURE wrt the closure: only the RpcChannel + AppContext types. No node:child_process
 * here (the child entry wires the transport); this file is the pure mapping.
 */

import type { RpcChannel } from './channel.js';
import type {
  AppContext,
  AppEvent,
  BuilderManifest,
  CommandManifest,
  CommandResult,
  SystemAgentHandle,
  TokenBudget,
} from '../types.js';
import type {
  Block,
  BlockName,
  BlockView,
  InputDescriptor,
  WakeEvent,
} from '../../core/types.js';

/** Handshake payload the child receives to seed the proxy (by-value, no functions). */
export interface ProxySeed<TState = unknown> {
  app_id: string;
  initial_state: TState;
  /** The app's command/builder manifests, reflected by value for list_* (no handlers). */
  commands: CommandManifest[];
  builders: BuilderManifest[];
}

/**
 * Build the child-side AppContext proxy over `channel`. The returned object's OWN
 * members are exactly the AppContext whitelist; `channel` and the mutable state copy
 * are closure-captured privates, never members (parity + no write-end leak).
 */
export function makeAppContextProxy<TState = unknown>(
  channel: RpcChannel,
  seed: ProxySeed<TState>,
  opts: { deadline_ms?: number } = {},
): AppContext<TState> {
  // Child-local working copy of state (the handler's synchronous view). The MAIN
  // process holds the authoritative cell; set_state frames the next value there.
  let state = seed.initial_state;
  const deadline = opts.deadline_ms;
  const call = (method: string, args: unknown): Promise<unknown> =>
    channel.call(method, args, deadline === undefined ? undefined : { deadline_ms: deadline });

  // Local event subscriptions; the main process frames `__event` to the child and we
  // dispatch here. Handlers NEVER cross the wire.
  const subscriptions = new Map<string, Array<(e: AppEvent) => void>>();
  channel.on('__event', (payload: unknown) => {
    const e = payload as { event?: string; appEvent?: AppEvent };
    if (typeof e?.event !== 'string') return;
    for (const h of subscriptions.get(e.event) ?? []) {
      try {
        h(e.appEvent ?? ({ topic: e.event, payload: undefined } as AppEvent));
      } catch {
        /* a subscriber throw must not crash the child's event pump */
      }
    }
  });

  return {
    app_id: seed.app_id,

    // state: synchronous local copy (§3.6). Never frames on read.
    get state(): TState {
      return state;
    },

    // set_state: run updater LOCALLY (functions don't cross the wire), then frame the
    // next value to the main process — the AUTHORITATIVE schema gate + cell writer.
    // We optimistically update the local copy; the main process re-validates (补强①)
    // and is the source of truth for pull/projection.
    set_state(updater: (s: TState) => TState): void {
      const next = updater(state);
      state = next;
      void call('set_state', { next }); // fire-and-forget toward the cell; main re-validates
    },

    // Reflection: manifests are loaded in the child (§3.9), so list_commands/builders
    // return the seeded by-value reflections locally (no frame). list_blocks needs the
    // tree, which lives in the main process → frame.
    list_commands(): CommandManifest[] {
      return [...seed.commands];
    },
    list_builders(): BuilderManifest[] {
      return [...seed.builders];
    },
    list_blocks(): Block[] {
      // NOTE: list_blocks is declared sync on AppContext but blocks live in the main
      // process. The proxy returns an empty snapshot synchronously (no fork/IPC on a
      // sync path); a child that needs blocks uses `read` (async) instead. This matches
      // §3.6 "sync paths never trigger cross-process work". (Kept conservative; SS3c
      // may seed a cached snapshot at handshake if a sandboxed app needs it.)
      return [];
    },

    // invoke_command: frame to the main process, which runs Operations.invoke_command
    // INSIDE a sandboxed taint chain (run_in_chain) and re-enters PolicyEngine (INV#11).
    // The proxy does NOT stamp trust itself — the main process is the sole authority
    // (单边 stamp). Returns a by-value CommandResult.
    async invoke_command(full_name: string, args: unknown): Promise<CommandResult> {
      return (await call('invoke_command', { full_name, args })) as CommandResult;
    },

    // read: frame to the main process; returns deep COPIES (INV#22/#18 across boundary).
    async read(blockname: BlockName): Promise<Block[] | BlockView[]> {
      return (await call('read', { blockname })) as Block[];
    },

    // on: register LOCALLY (handler never crosses the wire); main frames __event in.
    on(event: string, handler: (e: AppEvent) => void): void {
      const list = subscriptions.get(event) ?? [];
      list.push(handler);
      subscriptions.set(event, list);
    },
    // emit: frame to the main process (§3.5: invalidation doorbell only, no render data).
    emit(event: string, payload: unknown): void {
      void call('emit', { event, payload });
    },

    spawn_system_agent(spec: {
      goal: string;
      trigger: 'post_turn' | 'on_idle' | 'on_event';
      budget: TokenBudget;
    }): SystemAgentHandle {
      // Frame the spawn; the main process owns the real agent. We return a handle whose
      // id is filled asynchronously and whose stop() frames back. (Inert until the main
      // reply lands — matches the in-process v3.0 stub's fire-and-forget shape.)
      const handle: SystemAgentHandle = {
        id: `${seed.app_id}:system_agent:pending`,
        stop(): void {
          void call('system_agent_stop', { id: handle.id });
        },
      };
      void call('spawn_system_agent', { spec }).then((res) => {
        const id = (res as { id?: string })?.id;
        if (typeof id === 'string') handle.id = id;
      });
      return handle;
    },

    // wake: frame to the main process → AppRegistry.wakeHook (scheduling signal, not a
    // command; not routed through PolicyEngine).
    wake(event: WakeEvent): void {
      void call('wake', { event });
    },

    // report_input: frame to the main process → AppRegistry.inputHook (input telemetry,
    // actions §2.1; not a command, not routed through PolicyEngine — like wake).
    report_input(d: InputDescriptor): void {
      void call('report_input', { descriptor: d });
    },
  };
}
