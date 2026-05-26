/**
 * AppRegistry install + namespace collision (§5.3) — owned by impl-runtime.
 *
 * Installing an App registers its commands/builders; installing a SECOND App that
 * wants an already-taken id is auto-renamed (`chat` → `chat_2`) with a warning,
 * keeping every block name unambiguous (INV #3 / §3.1). We also check that
 * commands resolve through the wave-2 CommandRegistry seam and that owner='agent'
 * builders are rejected at runtime (INV #4).
 */

import { describe, expect, it } from 'vitest';

import {
  AppRegistry,
  AppManifestError,
} from '../src/app/registry.js';
import type { AppManifest } from '../src/app/types.js';

function chatApp(): AppManifest {
  return {
    id: 'chat',
    version: '1.0.0',
    depends_on: [],
    tree_namespace: '/chat',
    initial_state: {},
    state_schema: {},
    builders: [],
    commands: [
      () => ({
        name: 'reply',
        description: 'reply to a message',
        capabilities: [{ name: 'block:write' }],
        invoke: async () => ({ ok: true }),
      }),
    ],
  };
}

describe('AppRegistry install + namespace collision', () => {
  it('installs an App and resolves its command via CommandRegistry', () => {
    const reg = new AppRegistry();
    const result = reg.install(chatApp());
    expect(result.installed_id).toBe('chat');
    expect(result.warnings).toEqual([]);

    expect(reg.resolve_command('chat.reply')).not.toBeNull();
    expect(reg.resolve_command('chat.nope')).toBeNull();
    expect(reg.get('chat')?.id).toBe('chat');
  });

  it('auto-renames a second App that collides on id, with a warning', () => {
    const reg = new AppRegistry();
    const first = reg.install(chatApp());
    const second = reg.install(chatApp());

    expect(first.installed_id).toBe('chat');
    expect(second.installed_id).toBe('chat_2');
    expect(second.warnings.join(' ')).toMatch(/auto-renamed.*chat_2/);

    // Both are installed and listed deterministically.
    expect(reg.list().map((m) => m.id)).toEqual(['chat', 'chat']); // manifest.id unchanged
    expect(reg.get('chat_2')).not.toBeNull();
  });

  it('rejects a builder with owner="agent" at runtime (INV #4)', () => {
    const reg = new AppRegistry();
    const badApp: AppManifest = {
      id: 'bad',
      version: '1.0.0',
      depends_on: [],
      tree_namespace: '/bad',
      initial_state: {},
      state_schema: {},
      // The contract union forbids 'agent', but a third-party manifest could
      // smuggle it across an untyped boundary; the registry must reject it.
      builders: [
        () =>
          ({
            name: 'evil',
            version: '1.0.0',
            owner: 'agent',
            inputs: [],
            outputs: ['bad:x'],
            cache_tier: 'volatile',
            build: async () => null,
          }) as unknown as ReturnType<AppManifest['builders'][number]>,
      ],
      commands: [],
    };
    expect(() => reg.install(badApp)).toThrow(AppManifestError);
  });

  it('bootstrap installs in depends_on order', () => {
    const reg = new AppRegistry();
    const base: AppManifest = {
      id: 'base',
      version: '1.0.0',
      depends_on: [],
      tree_namespace: '/base',
      initial_state: {},
      state_schema: {},
      builders: [],
      commands: [],
    };
    const dependent: AppManifest = { ...chatApp(), id: 'dep', depends_on: ['base'] };
    const results = reg.bootstrap([dependent, base]);
    expect(results.map((r) => r.installed_id)).toEqual(['base', 'dep']);
  });
});
