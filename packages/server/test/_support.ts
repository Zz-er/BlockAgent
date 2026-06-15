/**
 * server/test/_support.ts — shared test helpers.
 *
 * Builds a mock-provider LauncherConfig (offline, no key, no network — the `mock` branch
 * of launch's buildProviderOrThrow replies once with messages.reply then ends the loop)
 * and a tiny collecting sink. Used to drive the SessionHost in-process / over a ws
 * loopback without a real backend.
 */

import type { LauncherConfig } from '@block-agent/cli/types.js';
import type { OutboundFrame } from '@block-agent/protocol/index.js';

/**
 * mockConfig — a full LauncherConfig on the `mock` provider. messages is enabled (so
 * submit → messages.ingest routes and the mock reply is delivered); the rest mirror the
 * compiled defaults. `storage_dir` is left to cwd; the apps write under a temp-ish
 * `.block-agent` — fine for a test run.
 */
export function mockConfig(overrides: Partial<LauncherConfig> = {}): LauncherConfig {
  return {
    provider: { kind: 'mock', model: 'mock' },
    apps: {
      agent_identity: { enabled: true },
      messages: { enabled: true },
      base: { enabled: true },
      memory: { enabled: false },
      memory_letta: { enabled: false },
      task: { enabled: true },
      stats: { enabled: false },
      im_proxy: { enabled: false },
      oa_proxy: { enabled: false },
      task_proxy: { enabled: false },
    },
    welcome: { cube: false },
    ...overrides,
  };
}

/** A sink that records every outbound frame it receives, with kind-filtered getters. */
export function collectingSink(): {
  sink: (frame: OutboundFrame) => void;
  frames: OutboundFrame[];
  ofKind: <K extends OutboundFrame['kind']>(kind: K) => Array<Extract<OutboundFrame, { kind: K }>>;
} {
  const frames: OutboundFrame[] = [];
  return {
    sink: (frame: OutboundFrame) => frames.push(frame),
    frames,
    ofKind: <K extends OutboundFrame['kind']>(kind: K) =>
      frames.filter((f): f is Extract<OutboundFrame, { kind: K }> => f.kind === kind),
  };
}
