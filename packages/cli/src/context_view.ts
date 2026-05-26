/**
 * cli/context_view.ts — /context summarize + /dump full (impl-cli-logic owned).
 *
 * Design: ai_com/block-agent-cli-design.md §5.
 *
 * Pure read-only helpers over the LaunchedAgent's renderer/operations/registry — they
 * build DATA (CtxView payloads / file contents); ui/ContextView.tsx renders it. Touch
 * NO per-invoker parameter and inject NO clock/random, so byte-identical rendering
 * (INV #1) is never disturbed — `renderer.render(operations.snapshot())` is the exact
 * call the runtime makes each turn, with no extra args.
 *
 *   summarize(agent)        → { snapshot_hash, segments: [{tier,bytes,boundary,preview}] }
 *   dumpFull(agent, file)   → render the full RenderedPrompt + write complete text to file
 *   appsView(agent)         → registry reflection (blocks + commands + user_only flag)
 */

import { writeFileSync } from 'node:fs';

import type { RenderedPrompt } from '@block-agent/core/core/types.js';
import type { LaunchedAgent, CtxView, SegmentSummary, AppSummary } from './types.js';

/** Byte length of a UTF-8 string (matches what a provider would actually send). */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Flatten a segment's rendered content to text. A segment is either a string or an
 * array of ContentParts; for non-text parts we substitute a compact placeholder so the
 * byte count + preview stay meaningful without inlining blob bytes.
 */
function segmentText(rendered: RenderedPrompt['segments'][number]['rendered']): string {
  if (typeof rendered === 'string') return rendered;
  return rendered
    .map((part) => (part.type === 'text' ? part.value : `[${part.type}${part.mime_type ? ` ${part.mime_type}` : ''}]`))
    .join('\n');
}

/** The first non-empty line of a block of text, trimmed and capped for the preview. */
function firstLinePreview(text: string, max = 80): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const flat = line.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * summarize — the abbreviated /context view (design §5). Renders the current snapshot
 * and reduces each tier segment to `{ tier, bytes, cache_boundary, preview }` plus the
 * snapshot hash. Read-only: no per-invoker params, no clock injection (INV #1 intact).
 */
export async function summarize(
  agent: LaunchedAgent,
): Promise<Extract<CtxView, { kind: 'context' }>> {
  const prompt = await agent.renderer.render(agent.operations.snapshot());
  const segments: SegmentSummary[] = prompt.segments.map((seg) => {
    const text = segmentText(seg.rendered);
    return {
      tier: seg.tier,
      bytes: utf8Bytes(text),
      cache_boundary: seg.cache_boundary,
      preview: firstLinePreview(text),
    };
  });
  return { kind: 'context', snapshot_hash: prompt.snapshot_hash, segments };
}

/**
 * dumpFull — render the FULL RenderedPrompt and write the complete segment text to
 * `file`, prefixed with a header (snapshot hash + per-segment tier/bytes/boundary). The
 * dump is the verbatim prompt the agent would see, so an operator can diff exactly what
 * is sent. Read-only over render; the only side effect is the file write.
 */
export async function dumpFull(agent: LaunchedAgent, file: string): Promise<void> {
  const prompt = await agent.renderer.render(agent.operations.snapshot());
  const lines: string[] = [];
  lines.push(`# block-agent context dump`);
  lines.push(`snapshot_hash: ${prompt.snapshot_hash}`);
  lines.push(`segments: ${prompt.segments.length}`);
  lines.push('');
  for (const seg of prompt.segments) {
    const text = segmentText(seg.rendered);
    lines.push(`## tier=${seg.tier} bytes=${utf8Bytes(text)} cache_boundary=${seg.cache_boundary}`);
    lines.push(text);
    lines.push('');
  }
  writeFileSync(file, lines.join('\n'), 'utf8');
}

/**
 * appsView — the /apps reflection (design §5). For each installed app: id, version, the
 * block names its builders own, and its full command names (`<id>.<cmd>`) each flagged
 * `user_only` when the command declares `allowed_invokers` that excludes `'agent'`
 * (e.g. `agent_identity.set`, `messages.set_config`, `tools.set_config`). Read-only over
 * the registry; this is the user-UI command-panel path the architecture allows (the
 * engine still enforces `allowed_invokers` at step 0 — this only ANNOTATES).
 */
export function appsView(agent: LaunchedAgent): AppSummary[] {
  return agent.registry.list().map((manifest) => {
    const blocks: string[] = [];
    for (const factory of manifest.builders) {
      // Builders read their state at render time via app_ctx, so calling the factory
      // with the manifest's initial_state is safe + deterministic for reflection.
      const builder = factory(manifest.initial_state);
      for (const out of builder.outputs) blocks.push(out);
    }
    const commands = manifest.commands.map((factory) => {
      const cmd = factory(manifest.initial_state);
      const full_name = `${manifest.id}.${cmd.name}`;
      const user_only =
        cmd.allowed_invokers !== undefined && !cmd.allowed_invokers.includes('agent');
      return { full_name, user_only };
    });
    return {
      id: manifest.id,
      version: manifest.version,
      blocks: [...blocks].sort(),
      commands,
    };
  });
}

// Re-export the summary shapes so the UI imports them from one place if preferred.
export type { SegmentSummary, AppSummary };
