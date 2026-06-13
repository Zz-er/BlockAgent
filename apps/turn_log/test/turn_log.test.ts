/**
 * turn_log store tests (D1 §7 "Apps"):
 *   - a TurnRecord with a stamped `ts` appends + readAll round-trips it;
 *   - a torn last line (crash-simulated) is truncated on open (reuse messages-store
 *     discipline — no reader ever sees a partial record);
 *   - the boot-style `onTurn` subscriber path appends each record with a stamped ts.
 *
 * The FILE is `runtime_log.jsonl`; the APP is `turn_log` (D1 §4 — names diverge on purpose).
 */

import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { TurnRecord } from '@block-agent/core/core/types.js';
import { TurnLogStore, type LedgerRecord } from '../src/manifest.js';

/** The runtime's onTurn listener shape (AgentRuntime.TurnListener; inlined to avoid pulling
 *  the whole runtime module into a store test). */
type TurnListener = (record: TurnRecord) => void;

const RUNTIME_LOG_FILE = 'runtime_log.jsonl';

/** A fresh temp storage dir per test so the repo's real `.block-agent` is never touched. */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'turn_log-test-'));
}

/** A representative core TurnRecord (clock-free; the `ts` is stamped at the ledger seam). */
function sampleRecord(turn_id: string, ended_by: TurnRecord['ended_by'] = 'reply'): TurnRecord {
  return {
    turn_id,
    spawn_depth: 0,
    wake_event: { kind: 'app_event', source: 'messages', ref: 'm1' },
    snapshot_hash: 'sha-abc',
    segment_hashes: { stable: 'h-stable', volatile: 'h-vol' },
    per_tier_bytes: { stable: 128, volatile: 42 },
    usage: { input_tokens: 100, output_tokens: 20 },
    ended_by,
  };
}

describe('TurnLogStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    // temp dirs are left to the OS reaper; tracking is enough to avoid cross-test bleed.
    dirs.length = 0;
  });

  function store(): { store: TurnLogStore; dir: string; file: string } {
    const dir = freshDir();
    dirs.push(dir);
    return { store: new TurnLogStore(dir), dir, file: join(dir, RUNTIME_LOG_FILE) };
  }

  it('appends a TurnRecord + stamped ts and readAll round-trips it', () => {
    const { store: s } = store();
    const ts = 1_700_000_000_000;
    const rec: LedgerRecord = { ...sampleRecord('1.0'), ts };
    s.append(rec);

    const all = s.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(rec);
    expect(all[0]?.ts).toBe(ts);
    expect(all[0]?.turn_id).toBe('1.0');
  });

  it('appends multiple records in order', () => {
    const { store: s } = store();
    s.append({ ...sampleRecord('1.0', 'tool_calls'), ts: 1 });
    s.append({ ...sampleRecord('1.1', 'reply'), ts: 2 });

    const all = s.readAll();
    expect(all.map((r) => r.turn_id)).toEqual(['1.0', '1.1']);
    expect(all.map((r) => r.ended_by)).toEqual(['tool_calls', 'reply']);
  });

  it('readAll on a missing file returns []', () => {
    const { store: s, file } = store();
    expect(existsSync(file)).toBe(false);
    expect(s.readAll()).toEqual([]);
  });

  it('truncates a torn last line on open (no reader sees a partial record)', () => {
    const { dir, file } = store();
    // Write one clean record, then a torn (no trailing newline, truncated JSON) line —
    // exactly what a crash mid-append leaves behind.
    const clean = `${JSON.stringify({ ...sampleRecord('1.0'), ts: 1 })}\n`;
    writeFileSync(file, clean);
    appendFileSync(file, '{"turn_id":"1.1","spawn_dep'); // torn tail, no '\n'

    // Re-open: the store truncates the torn tail at construction.
    const reopened = new TurnLogStore(dir);
    const all = reopened.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.turn_id).toBe('1.0');

    // The torn bytes are physically gone (file ends on a clean line boundary).
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).toBe(clean);
  });

  it('an empty file is left untouched on open', () => {
    const { dir, file } = store();
    writeFileSync(file, '');
    const reopened = new TurnLogStore(dir);
    expect(reopened.readAll()).toEqual([]);
  });

  it('subscribes to a fake runtime onTurn and appends each record with a stamped ts', () => {
    const { store: s } = store();

    // A minimal fake of the runtime's onTurn channel (Set + emit), mirroring the boot wiring
    // `runtime.onTurn(r => store.append({ ...r, ts: Date.now() }))`.
    const listeners = new Set<TurnListener>();
    const fakeRuntime = {
      onTurn(l: TurnListener): () => void {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      emit(record: TurnRecord): void {
        for (const l of listeners) l(record);
      },
    };

    let now = 1_000;
    const off = fakeRuntime.onTurn((r) => s.append({ ...r, ts: now }));

    fakeRuntime.emit(sampleRecord('1.0', 'tool_calls'));
    now = 2_000;
    fakeRuntime.emit(sampleRecord('1.1', 'reply'));
    off();
    fakeRuntime.emit(sampleRecord('1.2', 'idle')); // after unsubscribe → not recorded

    const all = s.readAll();
    expect(all.map((r) => r.turn_id)).toEqual(['1.0', '1.1']);
    expect(all.map((r) => r.ts)).toEqual([1_000, 2_000]);
  });
});
