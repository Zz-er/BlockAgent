/**
 * src/oa_client.ts — OaServiceClient: the isolated HTTP client to the OA service.
 *
 * Lives ONLY in the oa_proxy workspace (cli runtime dep, core devDep) so the OA wire
 * client never enters @block-agent/core's runtime closure — same isolation rule as
 * memory_letta's LettaMemoryStore (DR-M4).
 *
 * Trust model (INV #18): the OA service is an UNTRUSTED external backend. Every response
 * is parsed into our own plain-JSON shape (a fresh deep copy via the `to*` mappers below)
 * before it crosses back into block-agent code — a malicious/ buggy OA cannot smuggle a
 * prototype-polluted or aliased object into app state. Outbound calls require the `net:http`
 * capability, declared on the COMMANDS in manifest.ts, not here.
 *
 * Graceful degradation: when the OA service is unreachable or returns non-2xx, methods
 * RETURN `null` (or an empty list) rather than throwing, so a turn never crashes on a flaky
 * backend. The caller (a command) reports a clear SETUP_NEEDED-style error.
 *
 * Config: base URL from the `baseUrl` constructor param (default http://localhost:8284).
 * Token from the `OA_SERVICE_TOKEN` env ONLY — never passed through config / state / log
 * (same key discipline as the provider API keys).
 *
 * OA service API (BlockAI-team/docs/services/oa.md §4 — frozen):
 *   GET /oa/org              → OrgTree        { org_id, departments[], roles[] }
 *   GET /oa/directory        → OrgDirectory   { org_id, members[] }
 *   GET /oa/principal/{id}   → OrgIdentity    one principal's org identity
 *
 * There is NO write path on this client (org/membership writes are console-side, oa.md §6).
 */

import type {
  DirectoryMember,
  OrgDirectory,
  OrgIdentity,
  OrgTree,
} from './wire.js';

/** Options for constructing an OaServiceClient. */
export interface OaServiceClientOptions {
  /** OA service base URL. Default: http://localhost:8284. */
  baseUrl?: string;
  /**
   * Bearer token for the OA service. Read from `OA_SERVICE_TOKEN` env when omitted.
   * Held privately on the instance; never logged, never written to state.
   */
  token?: string;
  /** Per-request timeout in ms. Default: 5000. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'http://localhost:8284';
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * OaServiceClient — a thin `fetch` wrapper over the three read endpoints. Stateless
 * besides its base URL / token / timeout; safe to construct per command (cheap).
 */
export class OaServiceClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: OaServiceClientOptions = {}) {
    // Base URL: explicit option, else the platform-injected `OA_SERVICE_URL` env (the same
    // convention im_proxy/task_proxy follow — `IM_SERVICE_URL`/`TASK_SERVICE_URL`), else the
    // local default. Without the env read, the console-injected per-instance OA endpoint is
    // ignored and oa_proxy silently degrades against localhost (Phase C oversight — oa_proxy was
    // the only proxy not reading its `*_SERVICE_URL` env).
    this.baseUrl = (opts.baseUrl ?? process.env['OA_SERVICE_URL'] ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Token from explicit option, else env ONLY (never config/state/log).
    this.token = opts.token ?? process.env['OA_SERVICE_TOKEN'] ?? undefined;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * GET /oa/directory → OrgDirectory. The data source for both the `oa_proxy:directory`
   * block and the `org_directory` contract. Returns null on any failure (unreachable /
   * non-2xx / malformed) so the caller degrades instead of crashing the turn.
   */
  async getDirectory(): Promise<OrgDirectory | null> {
    const body = await this.get('/oa/directory');
    if (body === null) return null;
    return toOrgDirectory(body);
  }

  /**
   * GET /oa/org → OrgTree. The org/dept/role structure (used to enrich the directory
   * projection). Returns null on failure.
   */
  async getOrg(): Promise<OrgTree | null> {
    const body = await this.get('/oa/org');
    if (body === null) return null;
    return toOrgTree(body);
  }

  /**
   * GET /oa/principal/{id} → OrgIdentity. Look up one principal's org identity (the
   * `oa.lookup` read). Returns null on failure / unknown id.
   */
  async getPrincipal(id: string): Promise<OrgIdentity | null> {
    const body = await this.get(`/oa/principal/${encodeURIComponent(id)}`);
    if (body === null) return null;
    return toOrgIdentity(body);
  }

  /**
   * Issue a GET, returning the parsed JSON body or null on any failure. All network /
   * parse errors are swallowed into null (graceful degrade) — the OA backend being down
   * must never throw out of a command.
   */
  private async get(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.token) headers['authorization'] = `Bearer ${this.token}`;
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ============================================================================
// Untrusted-response mappers — fresh plain-JSON copies (INV #18 deep-copy fence)
// ============================================================================
//
// Each `to*` builds a NEW object from primitive reads of the untrusted body, so nothing
// from the OA response (prototype, getters, extra keys, aliased arrays) survives into app
// state. Unknown / malformed fields normalize to the contract's nullable shape rather than
// throwing — a partial OA record degrades to a partial member, it does not poison the turn.

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function kindOf(v: unknown): 'human' | 'agent' {
  return v === 'agent' ? 'agent' : 'human';
}

function roleList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is string => typeof r === 'string');
}

/**
 * NULL → ABSENT normalization (Architect ruling): the four nullable wire fields
 * (`employee_no` / `dept_id` / `dept_path` / `title`) are `string | null` in the frozen
 * oa.ts, but consume-refresh's `validateAgainstSchema` FAILS a `type:'string'` schema on a
 * `null` value and only checks a property when PRESENT. So we set the key ONLY when the OA
 * value is a non-empty string; a null / missing / empty value drops the key entirely (the
 * field is `field?: string` in wire.ts). This keeps the R-4 runtime validation green without
 * widening the contract's per-field schema to allow null.
 */
function assignIfStr(target: Record<string, unknown>, key: string, v: unknown): void {
  if (typeof v === 'string' && v.length > 0) target[key] = v;
}

function toDirectoryMember(v: unknown): DirectoryMember {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const m: DirectoryMember = {
    principal_id: str(o['principal_id']),
    kind: kindOf(o['kind']),
    name: str(o['name']),
    display: str(o['display']),
    org_id: str(o['org_id']),
    roles: roleList(o['roles']),
  };
  // Nullable fields: present only when a non-empty string (null/absent → key dropped).
  assignIfStr(m as unknown as Record<string, unknown>, 'employee_no', o['employee_no']);
  assignIfStr(m as unknown as Record<string, unknown>, 'dept_id', o['dept_id']);
  assignIfStr(m as unknown as Record<string, unknown>, 'dept_path', o['dept_path']);
  assignIfStr(m as unknown as Record<string, unknown>, 'title', o['title']);
  return m;
}

function toOrgDirectory(v: unknown): OrgDirectory {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const members = Array.isArray(o['members']) ? o['members'].map(toDirectoryMember) : [];
  return { org_id: str(o['org_id']), members };
}

function toOrgIdentity(v: unknown): OrgIdentity {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const ident: OrgIdentity = {
    id: str(o['id']),
    kind: kindOf(o['kind']),
    org_id: str(o['org_id']),
    name: str(o['name']),
    display: str(o['display']),
    roles: roleList(o['roles']),
  };
  // Same null → absent normalization as toDirectoryMember.
  assignIfStr(ident as unknown as Record<string, unknown>, 'employee_no', o['employee_no']);
  assignIfStr(ident as unknown as Record<string, unknown>, 'dept_id', o['dept_id']);
  assignIfStr(ident as unknown as Record<string, unknown>, 'dept_path', o['dept_path']);
  assignIfStr(ident as unknown as Record<string, unknown>, 'title', o['title']);
  return ident;
}

function toOrgTree(v: unknown): OrgTree {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const departments = Array.isArray(o['departments'])
    ? o['departments'].map((d) => {
        const dd = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>;
        return {
          id: str(dd['id']),
          org_id: str(dd['org_id']),
          parent_id: strOrNull(dd['parent_id']),
          name: str(dd['name']),
          path: str(dd['path']),
        };
      })
    : [];
  const roles = Array.isArray(o['roles'])
    ? o['roles'].map((r) => {
        const rr = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
        return { id: str(rr['id']), org_id: str(rr['org_id']), name: str(rr['name']) };
      })
    : [];
  return { org_id: str(o['org_id']), departments, roles };
}

/**
 * OaClient — the structural interface the manifest's commands depend on, so a test can
 * inject a FakeOaClient without the real `fetch`. The concrete OaServiceClient satisfies it.
 */
export interface OaClient {
  getDirectory(): Promise<OrgDirectory | null>;
  getOrg(): Promise<OrgTree | null>;
  getPrincipal(id: string): Promise<OrgIdentity | null>;
}
