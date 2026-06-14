/**
 * src/wire.ts — OA service wire types (TYPE-ONLY mirror).
 *
 * mirrors @blockai/contracts/oa.ts (BlockAI-team/packages/contracts/src/oa.ts) §3/§4 —
 * client-side wire types, re-declared to keep zero cross-repo + core zero-runtime-dep.
 *
 * Architect's ruling: oa_proxy must NOT depend on the BlockAI-team `@blockai/contracts`
 * package (cross-repo runtime coupling). Instead these are a HAND-MIRRORED, type-only copy
 * of that contract's shapes, header-cited so a drift is visible at review. No runtime values
 * live here — pure `interface`s, erased at compile time, so @block-agent/core's runtime
 * dependency closure stays empty (same isolation rule as memory_letta's SDK).
 *
 * SSOT on the BlockAI-team side: BlockAI-team/docs/services/oa.md §3 (types) + §4 (REST).
 * OA = the org-identity + personnel-data source of truth (org/dept/role/membership +
 * employee_no/name/title). v1 forms/approval are DEFERRED (oa.md §4b) — Form / FormStatus
 * are intentionally NOT mirrored here (no consumer references them in v1).
 *
 * The three personnel fields (oa.ts §3 note):
 *   - `name` vs `display` are two semantically-distinct names that coexist: `name` = the
 *     real / HR-authoritative name; `display` = the display name (same field as IM
 *     Principal.display, may differ from `name`).
 *   - `employee_no` is an OPTIONAL HR projection field (`string | null`, may be all-null in
 *     v1). NO downstream ruling may assume it is non-null.
 *
 * NULL → ABSENT normalization (Architect ruling): the FROZEN oa.ts declares the four
 * nullable fields (`employee_no` / `dept_id` / `dept_path` / `title`) as `string | null`,
 * but the consume-refresh runtime validator (`validateAgainstSchema`, contracts.ts) FAILS a
 * `type:'string'` schema when the value is `null`, and only checks a property when it is
 * PRESENT (`hasOwnProperty`). So `oa_client.ts` drops these keys entirely when the OA value
 * is null/missing rather than emitting `null`. These four fields are therefore declared
 * OPTIONAL (`field?: string`, i.e. present-string-or-absent) here — the faithful mirror of
 * the *normalized* wire value, not the raw `string | null`. Consumers treat absent == "no
 * value" (same as null), so nothing is lost.
 */

/** GET /oa/principal/{id} — the org identity of one principal (human or agent). */
export interface OrgIdentity {
  id: string; // principal_id
  kind: 'human' | 'agent';
  org_id: string;
  employee_no?: string; // HR projection field; ABSENT when null (oa.ts `string | null`)
  name: string; // real name / agent name (OA authoritative)
  display: string; // display name (IM Principal.display; may differ from name)
  dept_id?: string; // ABSENT when null
  dept_path?: string; // e.g. '/eng/backend'; ABSENT when null
  title?: string; // job / position title; ABSENT when null
  roles: string[]; // role-name array
}

/** One department node (flat list; `parent_id` chains it into a tree). */
export interface Dept {
  id: string;
  org_id: string;
  parent_id: string | null;
  name: string;
  path: string;
}

/** One role. */
export interface Role {
  id: string;
  org_id: string;
  name: string;
}

/** GET /oa/org — the org tree (flat departments + roles). */
export interface OrgTree {
  org_id: string;
  departments: Dept[]; // flat list; parent_id chains into a tree
  roles: Role[];
}

/**
 * GET /oa/directory — one flat directory member. This is the shape both im_proxy and
 * task_proxy consume via the shared `org_directory` contract (so each proxy does not
 * re-pull OA itself).
 */
export interface DirectoryMember {
  principal_id: string;
  kind: 'human' | 'agent';
  employee_no?: string; // HR projection field; ABSENT when null (oa.ts `string | null`)
  name: string; // real name / agent name (OA authoritative)
  display: string; // display name (IM Principal.display; may differ from name)
  org_id: string;
  dept_id?: string; // ABSENT when null
  dept_path?: string; // e.g. '/eng/backend'; ABSENT when null
  title?: string; // job / position title; ABSENT when null
  roles: string[]; // role-name array
}

/** GET /oa/directory — the org_directory contract's output: `{ org_id, members }`. */
export interface OrgDirectory {
  org_id: string;
  members: DirectoryMember[];
}
