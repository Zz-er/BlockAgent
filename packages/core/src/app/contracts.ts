/**
 * app/contracts.ts — CONTRACT FILE (owned by architect; import-only for everyone else)
 *
 * The CONTRACT MODEL: a `ContractDef` is a typed, identity-free data dependency
 * between Apps. A provider App declares `provides: [{contract, via}]` (its command
 * `via` returns the contract's `output_schema`); a consumer declares
 * `consumes: [{contract, as}]` and the merged provider outputs land in
 * `state[as]`. Contracts are what `depends_on` is NOT: they bind on a TYPE, never
 * on a concrete app-id, so a MessageApp can be swapped for a wechatLikeApp with no
 * consumer change (§3.2 "别名让接得上，类型让换得安全").
 *
 * This module sits in the `app/` area (reusing the `./app/*` exports map, DR-DX4),
 * NOT at the repo root, and is modeled on apps/memory_store.ts: PURE types + const
 * + one pure function, ZERO external dependencies (it imports only the `JsonSchema`
 * TYPE from ./types.js, erased at compile time — @block-agent/core's runtime dep
 * closure stays empty). No fs, no clock, no random.
 *
 * Authoritative design: ai_com/design/blockapp-multi-app-architecture.md §3.2-3.4
 * and ai_com/design/plan-review/resolutions.md R-1 / R-2 / R-3 (the executing delta).
 *
 * Three things live here, all consumed by the registry (assemble-time check, R-1)
 * and the runtime (consume-refresh validation, R-4/CM-1):
 *   1. `ContractDef`            — the contract shape (§3.2).
 *   2. `validateAgainstSchema`  — the REAL scalar/object validator (R-2). NOT the
 *      registry's `assertMatchesSchema` (registry.ts:164), which only checks
 *      `required` keys, gives `{type:'number'}` zero coverage, and is not exported.
 *   3. `MESSAGE_COUNT` / `TASK_COUNT` — the built-in scalar-number count contracts.
 */

import type { JsonSchema } from './types.js';

// ============================================================================
// §3.2 ContractDef — a typed, identity-free data dependency between Apps
// ============================================================================

/**
 * ContractDef — one named, versioned data contract (§3.2). A provider's `via`
 * command returns `output_schema`; when several providers satisfy the same
 * contract (fan-in), their outputs are merged by `combine` and the result lands
 * in the consumer's `state[as]`.
 *
 * `output_schema` is the REPLACEABILITY guarantee: every provider's via command
 * must return this shape (checked declaration-vs-declaration at assemble time, R-1,
 * against the via command's `result_schema`), so one provider can stand in for
 * another safely. `input_schema` is `{}` for a no-arg (e.g. count) contract.
 */
export interface ContractDef {
  /** Globally-unique contract name, e.g. `message_count`. */
  name: string;
  /** Version, for evolution / type-hash purposes. */
  version: string;
  /** Args shape a provider's via command takes; `{}` means no args. */
  input_schema: JsonSchema;
  /**
   * The shape ONE provider's via command returns (its `CommandResult.data`).
   * This is the substitutability key — all providers return this shape.
   */
  output_schema: JsonSchema;
  /** How many providers are expected: exactly `one`, or `many` (fan-in). */
  cardinality: 'one' | 'many';
  /**
   * How to merge multiple providers' outputs into the value placed in the
   * consumer's `state[as]` (the `as` field's type MUST equal the merged type):
   *   - `'sum'`   → outputs must be number scalars; merged = their sum (number).
   *                 The count contracts use this.
   *   - `'list'`  → merged = the outputs collected into an array (output[]).
   *   - `'first'` → merged = the first provider's output (pairs with cardinality 'one').
   */
  combine?: 'sum' | 'list' | 'first';
}

// ============================================================================
// R-2 (C-API-2) — the REAL schema validator (scalar + shallow object)
// ============================================================================

/**
 * The outcome of `validateAgainstSchema`: `{ok:true}` when the value conforms,
 * otherwise `{ok:false, error}` with a human-facing reason (surfaced in an
 * InstallResult warning or used to downgrade a consume-refresh entry). A
 * discriminated union so a caller can narrow on `ok`.
 */
export type SchemaCheck = { ok: true } | { ok: false; error: string };

/**
 * validateAgainstSchema — a PURE, deterministic check of a runtime value against a
 * minimal JSON-Schema subset (R-2). This is the validator the assemble-time check
 * (R-1, declaration-vs-declaration) and the consume-refresh data check (R-4/CM-1)
 * BOTH use. It is deliberately NOT the registry's `assertMatchesSchema`
 * (registry.ts:164), which only enforces `required` keys, gives `{type:'number'}`
 * zero coverage, throws instead of returning, and is not exported.
 *
 * Supported keywords (the subset the contract model needs — count contracts are
 * `{type:'number'}` scalars; param contracts are shallow objects):
 *   - `type`: 'number' | 'string' | 'boolean' | 'object' | 'array' — scalar/kind
 *     check. (`integer` is accepted as a number that is also an integer.)
 *   - `required: string[]` (only meaningful with `type:'object'`): each named key
 *     must be present on the value.
 *   - `properties: Record<string, JsonSchema>` (object): each present property is
 *     recursively validated against its sub-schema.
 *   - `items: JsonSchema` (array): every element is recursively validated.
 *
 * A schema with NO `type` is treated as "no constraint" → `{ok:true}` (matching
 * the lenient `{}` = no-arg contract input_schema). Unknown keywords are ignored
 * (forward-compatible). NaN / Infinity are rejected as numbers (a `sum` combine
 * over them would poison the merged scalar). It returns a result — it never
 * throws — so a caller can downgrade gracefully (B2's three-layer guardrail)
 * rather than crash a turn.
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema): SchemaCheck {
  return checkAt(value, schema, '');
}

/** Recursive worker; `path` is a dotted/bracketed locator for the error message. */
function checkAt(value: unknown, schema: JsonSchema, path: string): SchemaCheck {
  const where = path === '' ? 'value' : `value at ${path}`;
  const type = schema['type'];

  // No declared type ⇒ no constraint (e.g. an empty `{}` input_schema).
  if (typeof type !== 'string') return { ok: true };

  switch (type) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value))
        return fail(where, `expected a finite ${type}`, value);
      if (type === 'integer' && !Number.isInteger(value))
        return fail(where, 'expected an integer', value);
      return { ok: true };
    }
    case 'string':
      return typeof value === 'string' ? { ok: true } : fail(where, 'expected a string', value);
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true } : fail(where, 'expected a boolean', value);
    case 'array': {
      if (!Array.isArray(value)) return fail(where, 'expected an array', value);
      const items = schema['items'];
      if (isSchema(items)) {
        for (let i = 0; i < value.length; i += 1) {
          const r = checkAt(value[i], items, `${path}[${i}]`);
          if (!r.ok) return r;
        }
      }
      return { ok: true };
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return fail(where, 'expected an object', value);
      const obj = value as Record<string, unknown>;
      const required = schema['required'];
      if (Array.isArray(required)) {
        for (const key of required) {
          if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(obj, key))
            return { ok: false, error: `${where} is missing required key '${key}'` };
        }
      }
      const properties = schema['properties'];
      if (isPlainRecord(properties)) {
        for (const [key, sub] of Object.entries(properties)) {
          if (isSchema(sub) && Object.prototype.hasOwnProperty.call(obj, key)) {
            const r = checkAt(obj[key], sub, path === '' ? key : `${path}.${key}`);
            if (!r.ok) return r;
          }
        }
      }
      return { ok: true };
    }
    default:
      // An unknown `type` keyword is not a value error — treat as no constraint.
      return { ok: true };
  }
}

function fail(where: string, expected: string, value: unknown): SchemaCheck {
  return { ok: false, error: `${where}: ${expected}, got ${describe(value)}` };
}

/** A compact, deterministic description of a value's runtime kind for errors. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A JsonSchema is any non-null, non-array object (Record<string, unknown>). */
function isSchema(v: unknown): v is JsonSchema {
  return isPlainRecord(v);
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ============================================================================
// §3.2 — built-in standard contracts (scalar-number counts, combine sum)
// ============================================================================
//
// Count contracts are SCALAR numbers (NOT a `{count:number}` object), so a `sum`
// combine just adds the providers' outputs. The via command's `result_schema` is
// declared `{type:'number'}` to match output_schema (the R-1 assemble-time check).

/**
 * MESSAGE_COUNT — total message count across every chat-like provider. `many`
 * providers (MessageApp + any wechatLikeApp) fan in; `sum` adds their counts so a
 * StatsApp consuming it sees the total with zero change when a chat App is added.
 */
export const MESSAGE_COUNT: ContractDef = {
  name: 'message_count',
  version: '1',
  input_schema: {},
  output_schema: { type: 'number' },
  cardinality: 'many',
  combine: 'sum',
};

/**
 * TASK_COUNT — total task count across every task-like provider. Same scalar-sum
 * shape as MESSAGE_COUNT; a TaskApp provides it via `task.count`.
 */
export const TASK_COUNT: ContractDef = {
  name: 'task_count',
  version: '1',
  input_schema: {},
  output_schema: { type: 'number' },
  cardinality: 'many',
  combine: 'sum',
};
