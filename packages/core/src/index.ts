/**
 * src/index.ts — demo boot (owned by impl-runtime)
 *
 * Proves the v3.0 core loop end-to-end with the REAL classes:
 *   empty BlockTree → Operations(+PolicyEngine) → AppRegistry → Renderer →
 *   MockProvider → AgentRuntime.
 *
 * It installs ONE one-off fixture App (an `echo` demo stub — clearly NOT a
 * standard app; v3.0 ships zero predefined apps, see ARCHITECTURE.md), feeds a
 * scripted "message", runs a single turn driven by the MockProvider, and prints
 * the RenderedPrompt and the resulting tree.
 *
 * The runtime drives Operations/Renderer through the contract interfaces in
 * core/types.ts; the concrete Operations/Renderer classes satisfy them directly,
 * so they are wired in with no adapter.
 *
 * Run: `npm run dev`.
 */

import { BlockTree } from './core/block.js';
import { Operations } from './core/operations.js';
import { Renderer } from './core/renderer.js';
import { AppRegistry } from './app/registry.js';
import { MockProvider } from './provider/mock.js';
import { AgentRuntime } from './runtime/agent_runtime.js';
import type { AppManifest } from './app/types.js';
import type { Block, BlockOp, WakeEvent } from './core/types.js';

// ============================================================================
// One-off fixture App (DEMO STUB — not a standard app)
// ============================================================================

/**
 * The `echo` demo App: a single command `echo.say(text)` that writes the text
 * into the block `echo:last`. This exists only to give the loop something to do;
 * it is explicitly a fixture, not part of the framework.
 */
function echoApp(): AppManifest {
  return {
    id: 'echo',
    version: '0.0.0',
    depends_on: [],
    tree_namespace: '/echo',
    initial_state: {},
    state_schema: {},
    builders: [],
    commands: [
      () => ({
        name: 'say',
        description: 'Echo text into echo:last (demo fixture).',
        capabilities: [{ name: 'block:write' }],
        invoke: async (args: unknown) => {
          const text =
            typeof (args as { text?: unknown })?.text === 'string'
              ? (args as { text: string }).text
              : '';
          const op: BlockOp = {
            kind: 'create',
            parent: 'root:root',
            block: {
              id: 'echo-last',
              name: 'echo:last',
              children: [],
              content_text: `echo: ${text}`,
              content_blob: null,
            },
          };
          return { ok: true, ops: [op], data: { echoed: text } };
        },
      }),
    ],
  };
}

// ============================================================================
// Boot
// ============================================================================

async function main(): Promise<void> {
  // 1) Empty tree.
  const root: Block = {
    id: 'root',
    name: 'root:root',
    children: [],
    content_text: null,
    content_blob: null,
  };
  const tree = new BlockTree(root);

  // 2) AppRegistry + install the fixture App. AppRegistry directly implements
  //    both CommandRegistry and BuilderRegistry (one class, three faces), so it is
  //    passed straight to Operations (as CommandRegistry) and Renderer (as
  //    BuilderRegistry) — core depends on the interfaces, never on this class.
  const registry = new AppRegistry();
  const install = registry.install(echoApp());

  // 3) Operations with the default PolicyEngine — the canonical factory wires the
  //    capability / allowed_invokers / trust resolvers off the registry in one place
  //    (operations.ts with_default_policy), so this demo harness stays consistent with
  //    the production boot (cli/launch.ts) and the UH-2 sandboxed-trust lane is honored
  //    here too. (This harness only installs a trusted fixture app, so the lane never
  //    triggers — but using the factory means index.ts can't drift into a missing-
  //    resolver footgun if it is ever copied as a template.)
  const operations = Operations.with_default_policy({ tree, registry });

  // 4) Renderer over the BuilderRegistry seam (positional ctor per contract).
  //    Wire the LIVE App-context provider so state-driven projection builders
  //    (messages:recent / tools:recent, etc.) read post-mutation App state each
  //    render (the seam impl-tools flagged; backed by AppRegistry.get_app_context).
  const renderer = new Renderer(registry, {
    app_context_provider: (app_id) => registry.get_app_context(app_id),
  });

  // 5) MockProvider: turn 1 issues the echo command; turn 2 is empty (loop ends).
  const provider = new MockProvider([
    { thinking: ['user said hi; I should echo it back'], tool_calls: [{ id: 't1', name: 'echo.say', args: { text: 'hi' } }] },
    {},
  ]);

  // 6) Runtime, driving the real Operations + Renderer + provider directly. It takes
  //    the registry handle (R-5) and, in its constructor, registers its two bookkeeping
  //    system builders (`runtime:commands_only_feedback` / `runtime:command_error`, B1)
  //    via registry.registerSystemBuilder — so they must exist BEFORE we seed (below).
  const runtime = new AgentRuntime({
    operations,
    renderer,
    provider,
    registry,
  });

  // 6b) Seed projection-block placeholders AFTER the runtime registered its system
  //     builders (CM-5 order) and seed them under the runtime's actual tree root
  //     (CM-4): registry.seedProjectionBlocks defaults `parent` to `core:root`, which
  //     is NOT the empty-tree root (`root:root`) — passing runtime.root keeps the
  //     bookkeeping blocks attached to the live root so they actually render. The
  //     creates flow through Operations.apply({invoker:'app', trust:'trusted'}) — no
  //     chokepoint bypass. The explicit `trust:'trusted'` is required by apply()'s
  //     fail-closed default (task#10): this is a TRUSTED system seed (it writes pinned
  //     system blocks), so it opts into full trust explicitly; an unstamped app call
  //     would now be gated to the sandboxed lane.
  await registry.seedProjectionBlocks(
    (name) => operations.has(name),
    (ops) => operations.apply(ops, { invoker: 'app', trust: 'trusted' }),
    runtime.root,
  );

  // Subscribe a UI to the thinking channel (§4.3): thoughts are EMITTED here, never
  // written to the tree or fed back into the prompt. This is the only place they
  // surface. The messages-wake seam is wired the same way (registry.wakeHook).
  registry.wakeHook = (event) => void runtime.on_wake(event);
  runtime.onThinking((e) => {
    console.log(`\n[thinking depth=${e.spawn_depth}] ${e.text}`);
  });

  // Feed a "message" by waking the runtime, then run the loop. WakeEvent is
  // base-ified (A5): kind='app_event' + source/reason/ref (core never reads
  // reason/ref); this demo stands in for the messages App's front-door wake.
  const wake: WakeEvent = {
    kind: 'app_event',
    source: 'messages',
    reason: 'message_arrived',
    ref: 'demo-1',
  };

  console.log('=== block-agent v3.0 demo boot ===');
  console.log(`installed fixture app: ${install.installed_id}`);
  console.log(`initial state: ${runtime.state.kind}`);

  // Print the prompt the FIRST turn will render (before the loop runs).
  const before = await renderer.render(tree.snapshot());
  console.log('\n--- RenderedPrompt (turn 1, before commands) ---');
  console.log(JSON.stringify(toPrintable(before), null, 2));

  await runtime.on_wake(wake);

  console.log(`\nfinal state: ${runtime.state.kind}`);
  console.log(`turns consumed by provider: ${provider.turns_consumed}`);

  // Show the resulting tree + the post-turn rendered prompt.
  console.log('\n--- echo:last block ---');
  console.log(tree.get('echo:last')?.content_text ?? '(none)');

  const after = await renderer.render(tree.snapshot());
  console.log('\n--- RenderedPrompt (after turn) ---');
  console.log(JSON.stringify(toPrintable(after), null, 2));
}

/** Make a RenderedPrompt JSON-printable (its segment_hashes is a Map). */
function toPrintable(p: Awaited<ReturnType<Renderer['render']>>): unknown {
  return {
    segments: p.segments,
    snapshot_hash: p.snapshot_hash,
    segment_hashes: Object.fromEntries(p.segment_hashes),
  };
}

main().catch((err: unknown) => {
  console.error('demo boot failed:', err);
  process.exitCode = 1;
});
