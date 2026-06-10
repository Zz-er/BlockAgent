/**
 * app/child_process_host.ts — unified-host UH-2/SS3b: the child-process AppHost
 * (impl-spec §3.2/§4). The MAIN-process side of the cross-process carrier.
 *
 * ChildProcessHost lazily forks a sandboxed app into its own OS process, bridges it
 * with an RpcChannel over child_process IPC, and exposes the AppHost surface the
 * registry/runtime already use. The app's command handlers run in the CHILD (with the
 * AppContextProxy, app/rpc/app_context_proxy.ts); this file is the trusted main side
 * that drives the child and SECURES every frame coming back.
 *
 * ── The two seams (main side) ──────────────────────────────────────────────────────
 * 1. DRIVE the child to run a command (`route_command`): the registry's `route` calls
 *    this polymorphically (no `if(kind)`; InProcessHost runs the handler locally,
 *    ChildProcessHost frames it to the child). This hop does NOT self-establish taint —
 *    `Operations.invoke_command_detailed` ALREADY wraps `route` in `run_in_chain` (SS3-
 *    taint touchpoint 1), so the main→child hop's chain is already live.
 * 2. SECURE the child's cross-app calls (the frame handlers): the proxy frames
 *    `invoke_command` / `set_state` / `read` / `emit` / `wake` BACK to us. This is the
 *    CROSS-PROCESS TAINT-CHAIN START POINT (Atlas clarification / Raven hard-gate #5):
 *    the callback frame crossed the process+async boundary, so the ALS chain is BROKEN —
 *    the `invoke_command` handler MUST `run_in_chain('sandboxed', …)` to re-establish it,
 *    so a nested cross-app call the target makes inherits the sandboxed floor. We
 *    single-side-stamp `{invoker:'app', identity:app_id, trust:'sandboxed'}` (INV#11),
 *    run set_state through the AUTHORITATIVE schema gate (补强①), and never trust any
 *    trust/identity/full_name in the frame (C2: cross-app full_name allowed, not rejected).
 *
 * Process fault tolerance (D2): `child.on('exit'|'error')` → mark the channel dead and
 * reject in-flight calls, so a crashed/wedged child never hangs a turn (per-call
 * deadline already covers slow; this covers gone). A time-window failure-rate trip is a
 * documented follow-up (Raven SS3a ff#1), not implemented here.
 *
 * Decoupling: the main-side seams (run a command through Operations+PolicyEngine, write
 * a cell, dispatch an event, wake) are INJECTED as `HostDeps`, so this file imports no
 * concrete Operations/AppRegistry (no core↔app cycle) and unit-tests with a fake child
 * + fake deps. The fork itself is injected too (`spawn`), default = tsx fork.
 */

import type { AppContext, CommandResult } from './types.js';
import type { AppHost } from './app_host.js';
import type { Block, BlockName, InvokerContext, WakeEvent } from '../core/types.js';
import { FramedRpcChannel, type RpcChannel } from './rpc/channel.js';
import { parentTransport, type ChildProcessLike } from './rpc/child_process_transport.js';

/**
 * The main-side capabilities ChildProcessHost needs, injected so it stays decoupled.
 * Each runs in the MAIN process (trusted): they re-enter the chokepoint / write cells /
 * dispatch — the child never holds these.
 */
export interface HostDeps {
  /**
   * Run a command through Operations (PolicyEngine + chokepoint, INV#11). The host calls
   * this for BOTH (a) the agent-driven command the child should execute and (b) a
   * cross-app `invoke_command` the child's handler frames back. The caller has already
   * established the sandboxed taint chain (run_in_chain) around it.
   */
  invoke_command(full_name: string, args: unknown, ctx: InvokerContext): Promise<CommandResult>;
  /**
   * Write the app's authoritative core-side cell from a child set_state (§3.6). MUST
   * re-validate against the app's state_schema HERE (补强①: child is untrusted, its
   * own validation is only a fail-fast hint). Returns nothing; throws on schema breach.
   */
  write_cell(app_id: string, next: unknown): void;
  /** Read another app's public blocks; returns deep COPIES (INV#22/#18). */
  read_blocks(blockname: BlockName): Block[];
  /** Dispatch an app event (emit doorbell, §3.5 — no render data carried). */
  dispatch_event(app_id: string, event: string, payload: unknown): void;
  /** Wake the runtime (scheduling signal, not policy-gated). */
  wake(event: WakeEvent): void;
  /**
   * Run `fn` inside the sandboxed taint chain (ALS). Injected from core/taint so this
   * file does not import the store directly; it is the cross-process taint splice
   * (澄清#5): the host establishes `sandboxed` because ALS does not cross the fork.
   */
  run_sandboxed<T>(fn: () => T): T;
}

/** How to fork the child. Injected so e2e forks a real tsx child and units use a fake. */
export type SpawnChild = (app_id: string, pkg_path: string) => ChildProcessLike;

export interface ChildProcessHostOptions {
  app_id: string;
  /** The app package path the child imports (passed as argv, never via env). */
  pkg_path: string;
  deps: HostDeps;
  spawn: SpawnChild;
  /** Per-call deadline for frames to the child (default the channel's 200ms). */
  deadline_ms?: number;
}

export class ChildProcessHost implements AppHost {
  readonly app_id: string;
  readonly kind = 'child-process' as const;

  private readonly pkg_path: string;
  private readonly deps: HostDeps;
  private readonly spawn: SpawnChild;
  private readonly deadline_ms: number | undefined;

  private channel: RpcChannel | null = null;
  private child: ChildProcessLike | null = null;
  private dead = false;
  private activating: Promise<AppContext> | null = null;

  constructor(opts: ChildProcessHostOptions) {
    this.app_id = opts.app_id;
    this.pkg_path = opts.pkg_path;
    this.deps = opts.deps;
    this.spawn = opts.spawn;
    this.deadline_ms = opts.deadline_ms;
  }

  /** Active once the child is forked + channel up and not dead. */
  get active(): boolean {
    return this.channel !== null && !this.dead;
  }

  /**
   * Synchronous render-path accessor (impl-spec §3.6): for a child-process app this is
   * `null` until activated — the caller then reads the core-side cell (the pull source),
   * NEVER forks for a render. We do not return a main-side AppContext facade here: the
   * render path needs `state` from the cell, not a cross-process proxy. (A future
   * cached-state snapshot could back a non-null facade; SS3b keeps it null = pull cell.)
   */
  current_context(): AppContext | null {
    return null;
  }

  /**
   * Lazy activation: fork the child + bring up the channel + register the main-side
   * frame handlers. Idempotent (concurrent callers share one activation promise). The
   * returned AppContext is a thin main-side facade — see note; for SS3b the registry
   * drives the child via `route_command`, not via this facade's methods, so the facade
   * is intentionally minimal.
   */
  activate(): Promise<AppContext> {
    if (this.activating) return this.activating;
    this.activating = (async () => {
      const child = this.spawn(this.app_id, this.pkg_path);
      this.child = child;
      // Process fault tolerance (D2): a gone child marks the channel dead + rejects
      // in-flight. Per-call deadline covers slow; this covers crashed/exited.
      child.on('exit', () => this.markDead());
      child.on('error', () => this.markDead());

      const channel = new FramedRpcChannel(parentTransport(child));
      this.channel = channel;
      this.registerMainHandlers(channel);
      // Minimal facade; the real driving is `route_command`.
      return this.mainSideFacade();
    })();
    return this.activating;
  }

  /**
   * route_command — the AppHost-polymorphic entry `registry.route` calls (no `if(kind)`
   * in route; InProcessHost runs the handler locally, ChildProcessHost frames it to the
   * child). Runs ONE of THIS app's commands in the child and returns its CommandResult
   * (ops/data); Operations applies the ops through the chokepoint (INV#11) — the child
   * never applies.
   *
   * TAINT (Atlas clarification): this hop does NOT need its own `run_in_chain` — when
   * the agent invokes a sandboxed command, `Operations.invoke_command_detailed` ALREADY
   * wraps `route` (hence this call) in `run_in_chain(stricter(chain, effective))`
   * (SS3-taint touchpoint 1). So the main→child hop's taint is already live. The NEW
   * chain-start point is the OTHER direction — the child's own cross-app frames coming
   * BACK (see `registerMainHandlers.invoke_command`), which crossed the process/async
   * boundary and lost the ALS context, so THAT handler self-establishes `sandboxed`.
   */
  async route_command(command: string, args: unknown, _invoker: InvokerContext): Promise<CommandResult> {
    if (this.dead) return { ok: false, error: `app '${this.app_id}' child is dead` };
    if (!this.channel) await this.activate(); // lazy: first command forks the child
    const ch = this.channel;
    if (!ch) return { ok: false, error: `app '${this.app_id}' child not active` };
    try {
      return (await ch.call(
        'invoke',
        { command, args },
        this.deadline_ms === undefined ? undefined : { deadline_ms: this.deadline_ms },
      )) as CommandResult;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Graceful teardown (sequence SS2 dispose_app→forget): frame 'dispose' so the child
   * runs on_uninstall, then terminate + reclaim. Best-effort: a wedged child is force
   * dropped after the channel dispose (which rejects in-flight).
   */
  async dispose(): Promise<void> {
    const ch = this.channel;
    if (ch && !this.dead) {
      try {
        await ch.call('dispose', {}, { deadline_ms: this.deadline_ms ?? 200 });
      } catch {
        /* child may already be gone / slow — proceed to terminate */
      }
    }
    this.markDead();
  }

  // -- main-side frame handlers (SECURE the child's cross-app calls) ------------------

  private registerMainHandlers(channel: RpcChannel): void {
    const app_id = this.app_id;
    // The child's `ctx.invoke_command` frames BACK here — this is the CROSS-PROCESS
    // TAINT-CHAIN START POINT (Atlas clarification / Raven hard-gate #5). The frame
    // crossed the process + async boundary, so the ALS chain is BROKEN; we MUST
    // re-establish it with `run_sandboxed` so a nested cross-app call the target command
    // makes (e.g. child → trustedA → trustedB.hard) inherits the sandboxed floor and
    // cannot be laundered. We single-side stamp `{invoker:'app', identity:app_id,
    // trust:'sandboxed'}` and NEVER read trust/identity/full_name from the frame (C2:
    // cross-app full_name is allowed, not rejected). Re-enters the chokepoint (INV#11).
    channel.on('invoke_command', async (payload): Promise<CommandResult> => {
      const { full_name, args } = payload as { full_name: string; args: unknown };
      const ctx: InvokerContext = { invoker: 'app', identity: app_id, trust: 'sandboxed' };
      return this.deps.run_sandboxed(() => this.deps.invoke_command(full_name, args, ctx));
    });

    // set_state → write the AUTHORITATIVE cell (补强①: main re-validates schema). The
    // child's local copy is just its handler view; this is the pull/projection source.
    channel.on('set_state', async (payload): Promise<null> => {
      const { next } = payload as { next: unknown };
      this.deps.write_cell(app_id, next); // throws on schema breach → frames back as error
      return null;
    });

    // read → deep COPIES across the boundary (INV#22/#18).
    channel.on('read', async (payload): Promise<Block[]> => {
      const { blockname } = payload as { blockname: BlockName };
      return this.deps.read_blocks(blockname);
    });

    // emit → dispatch the doorbell (§3.5, no render data).
    channel.on('emit', async (payload): Promise<null> => {
      const { event, payload: data } = payload as { event: string; payload: unknown };
      this.deps.dispatch_event(app_id, event, data);
      return null;
    });

    // wake → scheduling signal (not policy-gated).
    channel.on('wake', async (payload): Promise<null> => {
      const { event } = payload as { event: WakeEvent };
      this.deps.wake(event);
      return null;
    });

    // __ready / spawn_system_agent stubs: ack so the child's handshake/spawn calls
    // resolve. spawn_system_agent's real wiring is a follow-up (in-process is a v3.0 stub
    // too); we return an id so the proxy handle is well-formed.
    channel.on('__ready', async () => null);
    channel.on('spawn_system_agent', async () => ({ id: `${app_id}:system_agent:0` }));
    channel.on('system_agent_stop', async () => null);
  }

  private markDead(): void {
    if (this.dead) return;
    this.dead = true;
    this.channel?.dispose(); // rejects in-flight calls (degrade, never hang)
    this.channel = null;
    this.child = null;
  }

  /**
   * Minimal main-side AppContext facade. SS3b drives the child via `route_command`
   * (route's child-process branch), so this facade is not the primary path; it exists
   * so `activate()` honors the AppHost contract (returns an AppContext). Its members
   * frame to the child / read the cell as needed. Kept minimal + clearly a facade.
   */
  private mainSideFacade(): AppContext {
    const app_id = this.app_id;
    const host = this;
    return {
      app_id,
      get state(): unknown {
        return undefined; // the authoritative state is the core-side cell, read there
      },
      set_state(): void {
        /* main side never sets the child's state; the child frames set_state to us */
      },
      list_commands: () => [],
      list_builders: () => [],
      list_blocks: () => [],
      async invoke_command(full_name: string, args: unknown): Promise<CommandResult> {
        // A main-side caller invoking this app's command drives the child.
        const { command } = splitOwnCommand(full_name, app_id);
        return host.route_command(command, args, { invoker: 'app', identity: app_id, trust: 'sandboxed' });
      },
      async read(blockname: BlockName) {
        return host.deps.read_blocks(blockname);
      },
      on: () => undefined,
      emit: (event: string, payload: unknown) => host.deps.dispatch_event(app_id, event, payload),
      spawn_system_agent: () => ({ id: `${app_id}:system_agent:0`, stop: () => undefined }),
      wake: (event: WakeEvent) => host.deps.wake(event),
    };
  }
}

/** Split `<app_id>.<command>`; for a bare command assume it belongs to this app. */
function splitOwnCommand(full_name: string, app_id: string): { command: string } {
  const dot = full_name.indexOf('.');
  if (dot < 0) return { command: full_name };
  const owner = full_name.slice(0, dot);
  return { command: owner === app_id ? full_name.slice(dot + 1) : full_name };
}
