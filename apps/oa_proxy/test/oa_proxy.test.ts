/**
 * test/oa_proxy.test.ts — unit tests for the oa_proxy package.
 *
 * Test strategy:
 *   - Inject a `FakeOaClient` (constructor injection through OaProxyApp opts) — no real OA
 *     service, no network.
 *   - Assert: stable directory block renders byte-identically (INV #1); the org_directory
 *     provide via returns an OrgDirectory whose `members` carry the three personnel fields
 *     (employee_no nullable, name, title) and conforms to ORG_DIRECTORY.output_schema +
 *     combine 'first'; there is NO write command for the agent; set_config is user-only;
 *     refresh caps to dir_limit + degrades when OA is unavailable.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  OaProxyApp,
  ORG_DIRECTORY,
  OA_DIRECTORY_BLOCK,
  type OaProxyState,
  type OrgDirectory,
  type DirectoryMember,
} from '../src/manifest.js';
import { OaServiceClient, type OaClient } from '../src/oa_client.js';
import type { OrgIdentity, OrgTree } from '../src/wire.js';
import { validateAgainstSchema, combineResults } from '@block-agent/core/app/contracts.js';
import type {
  AppContext,
  AppManifest,
  BuilderManifest,
  CommandManifest,
} from '@block-agent/core/app/types.js';
import type { BlockSnapshot, BlockName, InvokerContext } from '@block-agent/core/core/types.js';

// ============================================================================
// FakeOaClient — in-memory stub, no fetch
// ============================================================================

class FakeOaClient implements OaClient {
  getDirectoryCalls = 0;
  getPrincipalCalls: string[] = [];

  constructor(
    private readonly directory: OrgDirectory | null,
    private readonly principals: Record<string, OrgIdentity> = {},
  ) {}

  async getDirectory(): Promise<OrgDirectory | null> {
    this.getDirectoryCalls += 1;
    // Return a fresh copy so the test can prove the app does not alias the client's data.
    if (this.directory === null) return null;
    return { org_id: this.directory.org_id, members: this.directory.members.map((m) => ({ ...m })) };
  }

  async getOrg(): Promise<OrgTree | null> {
    return null;
  }

  async getPrincipal(id: string): Promise<OrgIdentity | null> {
    this.getPrincipalCalls.push(id);
    return this.principals[id] ?? null;
  }
}

// ============================================================================
// Sample data — employee_no intentionally ABSENT on the agent (null → key dropped,
// Architect ruling: client normalizes null to absent so R-4 validation stays green).
// ============================================================================

const MEMBERS: DirectoryMember[] = [
  {
    principal_id: 'p_zhang',
    kind: 'human',
    employee_no: 'E1001',
    name: '张三',
    display: '张三',
    org_id: 'org_1',
    dept_id: 'd_be',
    dept_path: '/eng/backend',
    title: '后端 Lead',
    roles: ['lead', 'engineer'],
  },
  {
    // agent: employee_no / dept fields ABSENT (not null) — the normalized wire shape.
    principal_id: 'agent_coder',
    kind: 'agent',
    name: 'agent_coder',
    display: 'Coder',
    org_id: 'org_1',
    title: '编码岗',
    roles: ['coder'],
  },
];

const SAMPLE_DIR: OrgDirectory = { org_id: 'org_1', members: MEMBERS };

// ============================================================================
// AppContext / BuildContext stubs
// ============================================================================

function makeCtx(initialState: OaProxyState): AppContext<OaProxyState> {
  let state = initialState;
  return {
    app_id: 'oa_proxy',
    get state() { return state; },
    set_state(updater: (s: OaProxyState) => OaProxyState) { state = updater(state); },
    list_commands: () => [],
    list_builders: () => [],
    list_blocks: () => [],
    async invoke_command() { return { ok: true }; },
    async read() { return []; },
    on() {},
    emit() {},
    spawn_system_agent() { return { id: 'fake', stop() {} }; },
  } as unknown as AppContext<OaProxyState>;
}

function makeInvoker(role: 'user' | 'agent' | 'app' = 'agent'): InvokerContext {
  return { invoker: role };
}

function initialState(dirLimit = 100): OaProxyState {
  return { org_id: '', directory: [], config: { dir_limit: dirLimit, base_url: 'http://localhost:8284' } };
}

const FAKE_SNAPSHOT: BlockSnapshot = {
  root: {
    id: 'root',
    name: 'core:root' as BlockName,
    children: [],
    content_text: null,
    content_blob: null,
  },
  hash: 'fake-hash',
  get: () => null,
} as unknown as BlockSnapshot;

const FAKE_BUILD_CTX = {
  snapshot: FAKE_SNAPSHOT,
  read: () => null,
  deterministic_clock: () => 0,
  deterministic_random: () => 0,
  content_addressed_id: (s: string) => `sha-${s.slice(0, 8)}`,
  config: {},
} as unknown as import('@block-agent/core/app/types.js').BuildContext;

// ============================================================================
// Manifest extraction helpers
// ============================================================================

function getCommand(manifest: AppManifest, name: string): CommandManifest<OaProxyState> {
  const factory = manifest.commands.find((f) => f(undefined as never).name === name);
  if (!factory) throw new Error(`Command '${name}' not found`);
  return factory(undefined as never) as CommandManifest<OaProxyState>;
}

function getBuilder(manifest: AppManifest, outputBlock: string): BuilderManifest {
  const factory = manifest.builders.find((f) => f(undefined as never).outputs.includes(outputBlock as never));
  if (!factory) throw new Error(`Builder for '${outputBlock}' not found`);
  return factory(undefined as never);
}

// ============================================================================
// Contract definition
// ============================================================================

describe('ORG_DIRECTORY contract', () => {
  it('is one/first with an object output_schema', () => {
    expect(ORG_DIRECTORY.name).toBe('org_directory');
    expect(ORG_DIRECTORY.cardinality).toBe('one');
    expect(ORG_DIRECTORY.combine).toBe('first');
    expect(ORG_DIRECTORY.output_schema['type']).toBe('object');
  });
});

// ============================================================================
// Directory block — stable, pure, byte-identical (INV #1 / #16)
// ============================================================================

describe('oa_proxy:directory block', () => {
  it('renders as a stable tier block', () => {
    const builder = getBuilder(new OaProxyApp().manifest(), OA_DIRECTORY_BLOCK);
    expect(builder.cache_tier).toBe('stable');
    expect(builder.owner).toBe('system');
  });

  it('returns null on an empty directory (block disappears)', async () => {
    const builder = getBuilder(new OaProxyApp().manifest(), OA_DIRECTORY_BLOCK);
    const ctx = makeCtx(initialState());
    const block = await builder.build(FAKE_BUILD_CTX, ctx);
    expect(block).toBeNull();
  });

  it('renders byte-identically for the same state (INV #1)', async () => {
    const builder = getBuilder(new OaProxyApp().manifest(), OA_DIRECTORY_BLOCK);
    const state: OaProxyState = { ...initialState(), org_id: 'org_1', directory: MEMBERS };
    const a = await builder.build(FAKE_BUILD_CTX, makeCtx(state));
    const b = await builder.build(FAKE_BUILD_CTX, makeCtx(state));
    expect(a).not.toBeNull();
    expect(a!.content_text).toBe(b!.content_text);
    // Stable snapshot of the rendered bytes.
    expect(a!.content_text).toBe(
      '# Organization\n- 张三 (human) — 后端 Lead, /eng/backend\n- Coder (agent) — 编码岗',
    );
  });
});

// ============================================================================
// org_directory provide — shape + contract conformance
// ============================================================================

describe('oa.org_directory (contract via)', () => {
  it('is readonly and excluded from the agent tool catalog', () => {
    const cmd = getCommand(new OaProxyApp().manifest(), 'org_directory');
    expect(cmd.readonly).toBe(true);
    expect(cmd.allowed_invokers).toEqual(['app', 'user']);
    expect(cmd.allowed_invokers).not.toContain('agent');
  });

  it('result_schema matches the contract output_schema (R-1)', () => {
    const cmd = getCommand(new OaProxyApp().manifest(), 'org_directory');
    expect(cmd.result_schema).toBe(ORG_DIRECTORY.output_schema);
  });

  it('returns an OrgDirectory whose members carry the 3 personnel fields, employee_no absent on agent', async () => {
    const app = new OaProxyApp({ client: new FakeOaClient(SAMPLE_DIR) });
    const manifest = app.manifest();
    const cmd = getCommand(manifest, 'org_directory');
    const state: OaProxyState = { ...initialState(), org_id: 'org_1', directory: MEMBERS };
    const res = await cmd.invoke({}, makeCtx(state), makeInvoker('app'));
    expect(res.ok).toBe(true);
    const out = res.data as OrgDirectory;
    expect(out.org_id).toBe('org_1');
    expect(out.members).toHaveLength(2);
    // The three personnel fields.
    const human = out.members[0]!;
    expect(human.name).toBe('张三');
    expect(human.title).toBe('后端 Lead');
    expect(human.employee_no).toBe('E1001');
    // employee_no ABSENT on the agent (null → key dropped); not in required.
    const agent = out.members.find((m) => m.kind === 'agent')!;
    expect(agent.employee_no).toBeUndefined();
    expect('employee_no' in agent).toBe(false);
    expect(res.ops).toBeUndefined(); // readonly — no tree mutations
  });

  it('output conforms to ORG_DIRECTORY.output_schema and folds via combine first', async () => {
    const app = new OaProxyApp({ client: new FakeOaClient(SAMPLE_DIR) });
    const cmd = getCommand(app.manifest(), 'org_directory');
    const state: OaProxyState = { ...initialState(), org_id: 'org_1', directory: MEMBERS };
    const res = await cmd.invoke({}, makeCtx(state), makeInvoker('app'));
    const check = validateAgainstSchema(res.data, ORG_DIRECTORY.output_schema);
    expect(check).toEqual({ ok: true });
    // cardinality 'one' + combine 'first' → the single provider output is the merged value.
    const merged = combineResults([res.data], ORG_DIRECTORY.combine);
    expect(merged).toEqual(res.data);
  });
});

// ============================================================================
// OaServiceClient null → absent normalization (Architect ruling) — via a stubbed fetch
// ============================================================================

describe('OaServiceClient null → absent normalization', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('drops nullable keys when the OA value is null, and the result conforms to the contract', async () => {
    // An OA /oa/directory body whose agent record has null employee_no / dept_id /
    // dept_path / title — the raw `string | null` wire shape.
    const body = {
      org_id: 'org_1',
      members: [
        {
          principal_id: 'agent_coder', kind: 'agent', employee_no: null, name: 'agent_coder',
          display: 'Coder', org_id: 'org_1', dept_id: null, dept_path: null, title: null,
          roles: ['coder'],
        },
      ],
    };
    globalThis.fetch = (async () =>
      ({ ok: true, json: async () => body }) as Response) as typeof fetch;

    const client = new OaServiceClient({ baseUrl: 'http://oa.test' });
    const dir = await client.getDirectory();
    expect(dir).not.toBeNull();
    const member = dir!.members[0]!;
    // The null fields are ABSENT (key dropped), not null.
    expect('employee_no' in member).toBe(false);
    expect('dept_id' in member).toBe(false);
    expect('dept_path' in member).toBe(false);
    expect('title' in member).toBe(false);
    // org_id + roles + the always-present fields survive.
    expect(member.org_id).toBe('org_1');
    expect(member.roles).toEqual(['coder']);
    // Crucially: a null-bearing OA record, normalized, passes R-4 validation against the
    // contract output_schema (validateAgainstSchema fails type:'string' on null, so the
    // null→absent normalization is what keeps consume-refresh green).
    const check = validateAgainstSchema(dir, ORG_DIRECTORY.output_schema);
    expect(check).toEqual({ ok: true });
  });
});

// ============================================================================
// refresh_directory — pull, cap, degrade
// ============================================================================

describe('oa.refresh_directory', () => {
  it('pulls the directory into state and reports org_id + count', async () => {
    const client = new FakeOaClient(SAMPLE_DIR);
    const cmd = getCommand(new OaProxyApp({ client }).manifest(), 'refresh_directory');
    const ctx = makeCtx(initialState());
    const res = await cmd.invoke({}, ctx, makeInvoker('agent'));
    expect(res.ok).toBe(true);
    expect(ctx.state.org_id).toBe('org_1');
    expect(ctx.state.directory).toHaveLength(2);
    expect(res.data).toEqual({ org_id: 'org_1', count: 2 });
  });

  it('caps the directory to dir_limit (INV #14)', async () => {
    const client = new FakeOaClient(SAMPLE_DIR);
    const cmd = getCommand(new OaProxyApp({ client }).manifest(), 'refresh_directory');
    const ctx = makeCtx(initialState(1));
    await cmd.invoke({}, ctx, makeInvoker('agent'));
    expect(ctx.state.directory).toHaveLength(1);
  });

  it('degrades (ok:false) when OA is unavailable', async () => {
    const client = new FakeOaClient(null);
    const cmd = getCommand(new OaProxyApp({ client }).manifest(), 'refresh_directory');
    const ctx = makeCtx(initialState());
    const res = await cmd.invoke({}, ctx, makeInvoker('agent'));
    expect(res.ok).toBe(false);
    expect(ctx.state.directory).toHaveLength(0);
  });

  it('declares block:write + net:http capabilities', () => {
    const cmd = getCommand(new OaProxyApp().manifest(), 'refresh_directory');
    const caps = (cmd.capabilities ?? []).map((c) => c.name);
    expect(caps).toContain('block:write');
    expect(caps).toContain('net:http');
  });
});

// ============================================================================
// lookup — readonly principal resolve
// ============================================================================

describe('oa.lookup', () => {
  it('resolves a principal and is readonly / app+user only', async () => {
    const identity: OrgIdentity = {
      id: 'p_zhang', kind: 'human', org_id: 'org_1', employee_no: 'E1001',
      name: '张三', display: '张三', dept_id: 'd_be', dept_path: '/eng/backend',
      title: '后端 Lead', roles: ['lead'],
    };
    const client = new FakeOaClient(SAMPLE_DIR, { p_zhang: identity });
    const cmd = getCommand(new OaProxyApp({ client }).manifest(), 'lookup');
    expect(cmd.readonly).toBe(true);
    expect(cmd.allowed_invokers).toEqual(['user', 'app']);
    const res = await cmd.invoke({ principal_id: 'p_zhang' }, makeCtx(initialState()), makeInvoker('app'));
    expect(res.ok).toBe(true);
    expect((res.data as OrgIdentity).name).toBe('张三');
  });

  it('rejects a missing principal_id arg', async () => {
    const cmd = getCommand(new OaProxyApp({ client: new FakeOaClient(SAMPLE_DIR) }).manifest(), 'lookup');
    const res = await cmd.invoke({}, makeCtx(initialState()), makeInvoker('app'));
    expect(res.ok).toBe(false);
  });
});

// ============================================================================
// No write path for the agent + set_config user-only
// ============================================================================

describe('write gating', () => {
  it('exposes no org/membership write command (read-heavy, oa.md §6)', () => {
    const manifest = new OaProxyApp().manifest();
    const names = manifest.commands.map((f) => f(undefined as never).name).sort();
    expect(names).toEqual(['lookup', 'org_directory', 'refresh_directory', 'set_config'].sort());
    // None of submit_form / approve / write directory.
    expect(names).not.toContain('submit_form');
    expect(names).not.toContain('approve');
  });

  it('set_config is user-only (anti-self-modification)', async () => {
    const cmd = getCommand(new OaProxyApp().manifest(), 'set_config');
    expect(cmd.allowed_invokers).toEqual(['user']);
    const ctx = makeCtx(initialState());
    const res = await cmd.invoke({ dir_limit: 50 }, ctx, makeInvoker('user'));
    expect(res.ok).toBe(true);
    expect(ctx.state.config.dir_limit).toBe(50);
  });
});

// ============================================================================
// Manifest wiring — provides org_directory, in-process trusted
// ============================================================================

describe('manifest', () => {
  it('provides org_directory via org_directory', () => {
    const manifest = new OaProxyApp().manifest();
    expect(manifest.provides).toEqual([{ contract: 'org_directory', via: 'org_directory' }]);
    expect(manifest.consumes ?? []).toEqual([]);
  });
});
