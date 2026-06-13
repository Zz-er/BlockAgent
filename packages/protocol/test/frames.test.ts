/**
 * protocol/test/frames.test.ts — frame round-trip (parse/serialize) + envelope/discriminant
 * sanity. The protocol is type-only, so these are structural assertions: a frame survives
 * JSON.stringify → JSON.parse byte-stable, the discriminated unions narrow on `kind`, and
 * the v0 negotiation constants are coherent.
 */

import { describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  V0_ACCEPTS,
  V0_EMITS,
  type InboundFrame,
  type OutboundFrame,
  type TurnFrame,
} from '@block-agent/protocol/index.js';

describe('SessionProtocol v0 frames', () => {
  it('round-trips an inbound submit frame', () => {
    const frame: InboundFrame = { kind: 'submit', v: PROTOCOL_VERSION, text: 'hi' };
    const round = JSON.parse(JSON.stringify(frame)) as InboundFrame;
    expect(round).toEqual(frame);
    expect(round.kind).toBe('submit');
  });

  it('round-trips a query frame with scope + verbose', () => {
    const frame: InboundFrame = {
      kind: 'query',
      v: PROTOCOL_VERSION,
      request_id: 'q1',
      target: 'context',
      scope: 'summary',
      verbose: true,
    };
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
  });

  it('round-trips a turn frame (TurnRecord ∩ {kind, ts})', () => {
    const frame: TurnFrame = {
      kind: 'turn',
      v: PROTOCOL_VERSION,
      ts: '2026-06-13T10:21:04.512Z',
      turn_id: '7.0',
      spawn_depth: 0,
      wake_event: { kind: 'app_event', source: 'messages' },
      snapshot_hash: 'a7b1',
      segment_hashes: { stable: 'a1', volatile: 'c9' },
      per_tier_bytes: { stable: 1840, volatile: 455 },
      ended_by: 'reply',
    };
    const round = JSON.parse(JSON.stringify(frame)) as TurnFrame;
    expect(round).toEqual(frame);
    // Discriminant narrows.
    const out: OutboundFrame = round;
    if (out.kind === 'turn') expect(out.ended_by).toBe('reply');
  });

  it('round-trips a context_diff frame', () => {
    const frame: OutboundFrame = {
      kind: 'context_diff',
      v: PROTOCOL_VERSION,
      from_snapshot_hash: '9f2c',
      to_snapshot_hash: 'a7b1',
      changed_tiers: ['volatile'],
      changed_apps: ['messages'],
    };
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
  });

  it('the v0 negotiation constants are coherent', () => {
    expect(PROTOCOL_VERSION).toBe('0');
    expect(V0_ACCEPTS).toContain('submit');
    expect(V0_ACCEPTS).toContain('hello');
    expect(V0_EMITS).toContain('turn');
    expect(V0_EMITS).toContain('capabilities');
    // No overlap between inbound-accepted and outbound-emitted kinds.
    for (const k of V0_ACCEPTS) expect(V0_EMITS).not.toContain(k as never);
  });
});
