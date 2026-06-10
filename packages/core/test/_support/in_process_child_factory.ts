/**
 * test/_support/in_process_child_factory.ts — TEST-ONLY in-process child factory
 * (UH-2/SS3c footgun guard, single source of truth).
 *
 * Production forbids a sandboxed (`trust:'sandboxed'`) app from running in-process —
 * `AppRegistry.instantiate` resolves it to `'child-process'` and FAIL-CLOSED throws if
 * no `child_host_factory` is injected (the launcher injects a REAL ChildProcessHost
 * factory). But ENGINE tests (the PolicyEngine sandboxed row, the taint chain) need to
 * install a sandboxed MANIFEST and exercise it in-process WITHOUT forking a real child.
 *
 * This factory is the sanctioned, explicit way to do that IN TESTS: assign it to
 * `registry.child_host_factory` before installing a sandboxed manifest and the registry
 * builds an InProcessHost from the parts it already constructed (live ctx + hook-only
 * uninstall + local command runner). It is the EXACT same InProcessHost the trusted
 * lane uses — so the sandboxed manifest runs in-process and the engine's sandboxed
 * policy/taint behavior is exercised against a real in-process command path.
 *
 * SECURITY (Raven SS3c hard-gate): this lives in test/_support and is imported ONLY by
 * tests; production launch never imports it (it builds a real ChildProcessHost). So the
 * only path to "sandboxed runs in-process" is an explicit test injection — never a
 * production bypass. A `grep` for this symbol should hit only test files.
 */

import { InProcessHost } from '../../src/app/in_process_host.js';
import type { AppHost } from '../../src/app/app_host.js';
import type { AppContext, CommandResult } from '../../src/app/types.js';
import type { InvokerContext } from '../../src/core/types.js';

/** The registry-built pieces handed to a child_host_factory (mirror of registry's type). */
interface InProcessParts {
  ctx: AppContext;
  run_uninstall: () => void;
  run_command: (command: string, args: unknown, invoker: InvokerContext) => Promise<CommandResult>;
}

/**
 * A `child_host_factory` that builds an InProcessHost from the registry's parts. Assign
 * to `registry.child_host_factory` in a test BEFORE installing a sandboxed manifest:
 *
 *   registry.child_host_factory = inProcessChildFactory;
 *   registry.install({ id: 'evil', trust: 'sandboxed', ... }); // now runs in-process
 */
export function inProcessChildFactory(
  app_id: string,
  _manifest: unknown,
  parts: InProcessParts,
): AppHost {
  return new InProcessHost(app_id, parts.ctx, parts.run_uninstall, parts.run_command);
}
