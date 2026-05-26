/**
 * invoke_command + PolicyEngine (§9.1 / §9.4) — owned by impl-runtime.
 *
 * The PolicyEngine check runs INSIDE Operations.invoke_command, before routing,
 * with no bypass. We exercise the three outcomes against the default §9.4 table:
 *   - allow:  agent invokes an ordinary write command → command runs, op applied.
 *   - deny:   agent invokes a command needing a flatly-denied capability → no run.
 *   - pending: agent invokes an `op:dangerous` command → approval token, no run.
 *
 * This wires the REAL Operations + REAL PolicyEngine + REAL AppRegistry, so it is
 * the integration check for the security chokepoint, not just a fixture.
 */

import { describe, expect, it } from 'vitest';

import { BlockTree } from '../src/core/block.js';
import { Operations } from '../src/core/operations.js';
import { PolicyEngine } from '../src/core/policy.js';
import type { AppManifest } from '../src/app/types.js';
import { AppRegistry } from '../src/app/registry.js';
import type { Block, BlockOp, InvokerContext } from '../src/core/types.js';

const AGENT: InvokerContext = { invoker: 'agent', identity: 'main' };
const USER: InvokerContext = { invoker: 'user', identity: 'human' };

function emptyTree(): BlockTree {
  const root: Block = {
    id: 'root',
    name: 'root:root',
    children: [],
    content_text: null,
    content_blob: null,
  };
  return new BlockTree(root);
}

/**
 * A demo fixture App (NOT a standard app) exposing four commands:
 *   write.put      — needs block:write (granted to agent) → allow
 *   danger.run     — needs op:dangerous (agent → pending)
 *   harddelete.go  — needs block:delete_physical (agent → deny)
 *   set            — allowed_invokers:['user'] (agent → deny, user → allow)
 */
function demoApp(): AppManifest {
  const putOp = (text: string): BlockOp => ({
    kind: 'create',
    parent: 'root:root',
    block: { id: 'demo-out', name: 'demo:out', children: [], content_text: text, content_blob: null },
  });
  return {
    id: 'demo',
    version: '0.0.0',
    depends_on: [],
    tree_namespace: '/demo',
    initial_state: {},
    state_schema: {},
    builders: [],
    commands: [
      () => ({
        name: 'put',
        description: 'write demo:out (needs block:write)',
        capabilities: [{ name: 'block:write' }],
        invoke: async (args: unknown) => ({
          ok: true,
          ops: [putOp(typeof (args as { text?: unknown })?.text === 'string' ? (args as { text: string }).text : '')],
        }),
      }),
      () => ({
        name: 'run',
        description: 'a dangerous op (needs op:dangerous)',
        capabilities: [{ name: 'op:dangerous' }],
        invoke: async () => ({ ok: true }),
      }),
      () => ({
        name: 'go',
        description: 'physical delete (needs block:delete_physical)',
        capabilities: [{ name: 'block:delete_physical' }],
        invoke: async () => ({ ok: true }),
      }),
      () => ({
        name: 'set',
        description: 'user-only identity set (allowed_invokers gate)',
        capabilities: [{ name: 'block:write' }],
        allowed_invokers: ['user'],
        invoke: async () => ({ ok: true }),
      }),
    ],
  };
}

function wire() {
  const tree = emptyTree();
  const registry = new AppRegistry();
  registry.install(demoApp());
  const policy = new PolicyEngine({
    capability_resolver: (full_name) => registry.resolve_command(full_name)?.capabilities ?? [],
    allowed_invokers_resolver: (full_name) =>
      registry.resolve_command(full_name)?.allowed_invokers ?? null,
  });
  const ops = new Operations(tree, policy, registry);
  return { tree, ops };
}

describe('invoke_command + PolicyEngine', () => {
  it('ALLOWS an agent block:write command and applies its op', async () => {
    const { tree, ops } = wire();
    const res = await ops.invoke_command('demo.put', { text: 'hello' }, AGENT);
    expect(res.ok).toBe(true);
    expect(tree.get('demo:out')?.content_text).toBe('hello');
  });

  it('DENIES an agent command needing block:delete_physical (INV #5)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.go', {}, AGENT);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
  });

  it('marks an agent op:dangerous command PENDING (approval)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.run', {}, AGENT);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'pending' });
    expect((res.data as { token?: unknown }).token).toEqual(expect.any(String));
  });

  it('detailed outcome distinguishes allow / deny / pending for the runtime', async () => {
    const { ops } = wire();
    expect((await ops.invoke_command_detailed('demo.put', { text: 'x' }, AGENT)).status).toBe('ok');
    expect((await ops.invoke_command_detailed('demo.go', {}, AGENT)).status).toBe('denied');
    expect((await ops.invoke_command_detailed('demo.run', {}, AGENT)).status).toBe('pending');
  });

  it('the SAME dangerous command is allowed for a user invoker (user > agent trust)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.run', {}, USER);
    expect(res.ok).toBe(true);
  });

  it('DENIES a user-only command (allowed_invokers) for the agent — anti-jailbreak', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.set', {}, AGENT);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    // The deny happens on the invoker gate, before capabilities — even though the
    // agent DOES hold block:write, it is not in allowed_invokers.
    expect(res.error).toMatch(/not permitted/);
  });

  it('ALLOWS the same user-only command for a user invoker', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('demo.set', {}, USER);
    expect(res.ok).toBe(true);
  });

  it('an app invoker is also denied a user-only command (allowed_invokers excludes app)', async () => {
    const { ops } = wire();
    // `app` is normally system-level (everything granted), but the invoker gate is
    // about the invoker ROLE, not capabilities: `set` lists only `user`.
    const denied = await ops.invoke_command('demo.set', {}, { invoker: 'app' });
    expect(denied.ok).toBe(false);
    expect(denied.data).toMatchObject({ policy: 'deny' });
  });
});
