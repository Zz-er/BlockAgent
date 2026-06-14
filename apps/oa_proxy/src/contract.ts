/**
 * apps/oa_proxy/src/contract.ts — the `org_directory` ContractDef (the ONE new contract
 * this proxy group adds; oa.md §4 / Architect phase-C ruling).
 *
 * SEPARATE FILE (Architect ruling) so the launcher imports JUST the ContractDef to register
 * it (`registry.registerContract(ORG_DIRECTORY)`) without pulling the whole manifest. This
 * mirrors how core's built-ins live in @block-agent/core/app/contracts.js (MESSAGE_COUNT /
 * TASK_COUNT) — but org_directory is NOT a core built-in, so it must be registered at boot
 * from here, BEFORE any provider/consumer installs, or the assemble-time check sees an
 * unknown contract, skips the R-1 type check, and silently drops the binding
 * (registry.ts:868).
 *
 * oa_proxy PROVIDES it (via `oa.org_directory`); im_proxy / task_proxy CONSUME it (each
 * resolves a principal_id → {name, title, employee_no} from the one OA projection). The
 * contract binds on TYPE, not identity — none of them names oa_proxy.
 *
 * Shape (Architect ruling, aligned to the FROZEN @blockai/contracts/oa.ts, NOT the stale
 * design doc):
 *   - `cardinality: 'one'` + `combine: 'first'` — the platform guarantees a SINGLE OA (OA is
 *     the one org-identity source of truth), so a consumer's `state[as]` is the OrgDirectory
 *     OBJECT itself, not an array (no unwrap).
 *   - `output_schema` = the whole `OrgDirectory` `{ org_id, members: DirectoryMember[] }`.
 *     R-1's assemble-time check only compares the TOP-LEVEL `type` of output_schema against
 *     the via command's `result_schema` (registry.ts checkProvides), so both are 'object';
 *     the nested member schema is the runtime (consume-refresh) validation surface.
 *   - `employee_no` is nullable (oa.ts §3) → intentionally NOT in members' `required`.
 */

import type { ContractDef } from '@block-agent/core/app/contracts.js';

/** The contract name — consumers declare `consumes: [{ contract: 'org_directory', as }]`. */
export const ORG_DIRECTORY_NAME = 'org_directory' as const;

/**
 * ORG_DIRECTORY — the `org_directory` ContractDef. Registered at boot by launch.ts.
 * `output_schema` is the whole OrgDirectory object; the via command's `result_schema`
 * points at THIS exact object so the R-1 declaration-vs-declaration check passes.
 */
export const ORG_DIRECTORY: ContractDef = {
  name: ORG_DIRECTORY_NAME,
  version: '1',
  input_schema: {},
  output_schema: {
    type: 'object',
    required: ['org_id', 'members'],
    properties: {
      org_id: { type: 'string' },
      members: {
        type: 'array',
        items: {
          type: 'object',
          // The four nullable fields (employee_no / dept_id / dept_path / title) are
          // intentionally NOT `required`: the client drops them when null (oa_client.ts
          // null→absent normalization), and validateAgainstSchema only checks a property
          // when present. org_id + roles are always emitted, so they ARE required.
          required: ['principal_id', 'kind', 'name', 'display', 'org_id', 'roles'],
          properties: {
            principal_id: { type: 'string' },
            kind: { type: 'string' },
            name: { type: 'string' },
            display: { type: 'string' },
            org_id: { type: 'string' },
            title: { type: 'string' },
            dept_id: { type: 'string' },
            dept_path: { type: 'string' },
            roles: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  cardinality: 'one',
  combine: 'first',
};
