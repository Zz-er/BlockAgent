/**
 * test/oa_resolve_mock.test.ts — the context-reactive OA-resolve mock provider (offline dry-run).
 *
 * OaResolveMockProvider stands in for a real LLM in the platform OA NAME-RESOLUTION vertical (D2c,
 * team-lead method A): each `send` it reads the rendered prompt, takes the inbound sender's
 * principal (via the `[im:<label>]` chat line), resolves it to a real display name through the
 * `# Organization` (oa_proxy:directory) block — oa_proxy's projection of the live OA service, whose
 * lines carry a trailing `[<principal_id>]` join tag — and replies (`im_proxy.reply`) folding the
 * resolved name with the inbound body (the per-run nonce). If the sender is NOT in the directory it
 * emits an empty turn and WAITS — it never falls back to the `im:` label (anti-false-green). These
 * tests pin that behavior (which the cross-process e2e relies on) without spawning anything.
 */

import { describe, expect, it } from 'vitest';

import { OaResolveMockProvider } from '../src/provider/oa_resolve_mock.js';
import type { ProviderChunk } from '../src/provider/types.js';
import type { RenderedPrompt } from '../src/core/types.js';

/**
 * A RenderedPrompt with an `oa_proxy:directory` (`# Organization`) block carrying `dirLines` and an
 * `im_proxy:chat` block carrying `chatLines`. Mirrors the real render: org member lines end in a
 * `[<principal_id>]` join tag; chat inbound lines are `[im:<label>] <body>`.
 */
function prompt(dirLines: string[], chatLines: string[]): RenderedPrompt {
  const org = ['# Organization', ...dirLines].join('\n');
  const chat = ['# Chat — group room (2)', ...chatLines].join('\n');
  return {
    segments: [
      { tier: 'stable', rendered: org, cache_boundary: true },
      { tier: 'volatile', rendered: chat, cache_boundary: false },
    ],
    snapshot_hash: 'h',
    segment_hashes: new Map(),
  };
}

/** Just a chat block, no `# Organization` (OA not folded yet). */
function chatOnly(chatLines: string[]): RenderedPrompt {
  return {
    segments: [
      { tier: 'volatile', rendered: ['# Chat — group room (2)', ...chatLines].join('\n'), cache_boundary: false },
    ],
    snapshot_hash: 'h',
    segment_hashes: new Map(),
  };
}

async function drain(it: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}
function toolCall(chunks: ProviderChunk[]): Extract<ProviderChunk, { kind: 'tool_call' }> | undefined {
  return chunks.find((c): c is Extract<ProviderChunk, { kind: 'tool_call' }> => c.kind === 'tool_call');
}

describe('OaResolveMockProvider (method A — read directory, refuse label)', () => {
  it('resolves the sender via the directory and replies with the OA name + inbound body', async () => {
    const provider = new OaResolveMockProvider();
    const chunks = await drain(
      provider.send(
        prompt(['- Alice Anderson (human) [alice]'], ['[im:alice] ping msg-9q2']),
        {},
      ),
    );
    const call = toolCall(chunks);
    expect(call?.call.name).toBe('im_proxy.reply');
    expect(call?.call.args).toEqual({ body: 'resolved: Alice Anderson | ping msg-9q2' });
  });

  it('carries an OA-baked nonce in the display name verbatim (anti-false-green hard evidence)', async () => {
    // team-lead anti-false-green: the e2e bakes a nonce INTO the OA display name (`Alice Anderson
    // oa-7f3a`). The reply can only carry that oa-nonce by resolving through the LIVE OA directory.
    const provider = new OaResolveMockProvider();
    const chunks = await drain(
      provider.send(
        prompt(['- Alice Anderson oa-7f3a (human) — Eng, /eng [alice]'], ['[im:alice] hi msg-1']),
        {},
      ),
    );
    expect(toolCall(chunks)?.call.args).toEqual({
      body: 'resolved: Alice Anderson oa-7f3a | hi msg-1',
    });
  });

  it('matches the real D2c e2e shape: sender a2, OA name with nonce, reply carries it', async () => {
    // Mirrors services/e2e/test/oa_resolve.test.ts exactly: peer a2 (principal `a2`, sanitize-stable)
    // seeded in OA as `Agent Two <nonce>`; a2's IM display is deliberately different and NEVER read
    // (we resolve from the `# Organization` directory, not IM). The reply carries the OA name + nonce.
    const provider = new OaResolveMockProvider();
    const chunks = await drain(
      provider.send(
        prompt(['- Agent Two nonce-7x3k1q (agent) [a2]'], ['[im:a2] who is this msg-4a9']),
        {},
      ),
    );
    expect(toolCall(chunks)?.call.args).toEqual({
      body: 'resolved: Agent Two nonce-7x3k1q | who is this msg-4a9',
    });
  });

  it('WAITS (empty turn) when the sender is NOT in the directory — never falls back to the label', async () => {
    // The directory has someone else; the inbound sender `alice` is absent → no resolution → wait.
    const provider = new OaResolveMockProvider();
    const chunks = await drain(
      provider.send(prompt(['- Bob (human) [bob]'], ['[im:alice] hello msg-1']), {}),
    );
    expect(toolCall(chunks)).toBeUndefined();
    expect(chunks.some((c) => c.kind === 'done')).toBe(true);
  });

  it('WAITS when there is no `# Organization` block at all (OA not yet folded)', async () => {
    const provider = new OaResolveMockProvider();
    const chunks = await drain(provider.send(chatOnly(['[im:alice] hello msg-1']), {}));
    expect(toolCall(chunks)).toBeUndefined();
  });

  it('emits an empty turn when there is no inbound to answer', async () => {
    const provider = new OaResolveMockProvider();
    const chunks = await drain(provider.send(prompt(['- Alice (human) [alice]'], ['(no messages)']), {}));
    expect(toolCall(chunks)).toBeUndefined();
  });

  it("ignores the agent's own (`[me]`) lines — only inbound messages are answered", async () => {
    const provider = new OaResolveMockProvider();
    const chunks = await drain(
      provider.send(prompt(['- Alice (human) [alice]'], ['[me] my own turn']), {}),
    );
    expect(toolCall(chunks)).toBeUndefined();
  });

  it('answers each inbound exactly once (the loop terminates, no re-reply)', async () => {
    const provider = new OaResolveMockProvider();
    const dir = ['- Alice (human) [alice]'];
    const t1 = await drain(provider.send(prompt(dir, ['[im:alice] only once msg-1']), {}));
    expect(toolCall(t1)?.call.args).toEqual({ body: 'resolved: Alice | only once msg-1' });
    // Same inbound still in the window next turn → no second reply.
    const t2 = await drain(provider.send(prompt(dir, ['[im:alice] only once msg-1']), {}));
    expect(toolCall(t2)).toBeUndefined();
  });

  it('does not re-answer one of its own resolved replies fed back into the window', async () => {
    const provider = new OaResolveMockProvider();
    const chunks = await drain(
      provider.send(
        prompt(['- Alice (human) [alice]'], ['[im:alice] resolved: Alice | earlier']),
        {},
      ),
    );
    expect(toolCall(chunks)).toBeUndefined();
  });

  it('answers the NEWEST unanswered inbound when several are present', async () => {
    const provider = new OaResolveMockProvider();
    const chunks = await drain(
      provider.send(
        prompt(
          ['- Alice (human) [alice]', '- Bob (human) [bob]'],
          ['[im:alice] first msg-1', '[im:bob] second msg-2'],
        ),
        {},
      ),
    );
    expect(toolCall(chunks)?.call.args).toEqual({ body: 'resolved: Bob | second msg-2' });
  });

  it('resolves against the trailing `[...]` join tag even when the line carries meta', async () => {
    // Member line with title/dept meta before the join tag — the principal must come from the
    // TRAILING tag, and the display name from the head (`- <display> (`). A sanitize-stable id
    // (`carol2`: lowercase alphanumerics) so `im:<principal>` is exactly the chat label.
    const provider = new OaResolveMockProvider();
    const chunks = await drain(
      provider.send(
        prompt(['- Carol (agent) — Coder, /eng/team [carol2]'], ['[im:carol2] yo msg-7']),
        {},
      ),
    );
    expect(toolCall(chunks)?.call.args).toEqual({ body: 'resolved: Carol | yo msg-7' });
  });
});
