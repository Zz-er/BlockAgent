/**
 * server/context_views.ts — the read-only `context` projections, built over the SAME
 * seams the CLI's context_view.ts uses (`renderer.render(operations.snapshot())` +
 * registry reflection). They produce protocol `ContextFrame` payloads.
 *
 * Design: ai_com/design/session-protocol-v0.md §2.4/§2.7 (the four context scopes) +
 * multi-terminal-and-web-inspector.md §4.4 (per-block layer). Read-only discipline:
 * every helper renders the live snapshot with NO per-invoker parameter and NO clock
 * injection — the exact call the runtime makes each turn — so INV #1 (byte-identical
 * rendering) is never disturbed. None of these ever calls invoke_command.
 *
 * Three of the four scopes wrap CLI helpers verbatim:
 *   - `summary`     → `summarize` (+ verbose full segment text, like `dumpFull`).
 *   - `attribution` → `appsView` (per-app reflection).
 *   - `app_preview` → `installedApps` filtered to one id.
 * The `blocks` scope is the per-block join the D3 sidebar binds to; it is derived here
 * from the live snapshot tree + `registry.resolve_builder`/`tier_of` (the SAME registry
 * reflection appsView uses), so the CLI and web inspectors report identical attribution.
 */

import { createHash } from 'node:crypto';

import type { LaunchedAgent } from '@block-agent/cli/types.js';
import { summarize, appsView, installedApps } from '@block-agent/cli/context_view.js';
import type {
  Block,
  CacheTier,
  RenderedPrompt,
} from '@block-agent/core/core/types.js';
import type {
  AppAttribution,
  AvailableApp,
  BlockAttribution,
  BlockBody,
  ContextFrame,
  SegmentSummary,
} from '@block-agent/protocol/index.js';

/** UTF-8 byte length (matches what a provider would actually send). */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Stable content hash of a block's rendered text (for the per-block changed flag). */
function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** First non-empty line, trimmed + capped — the collapsed-card preview. */
function firstLinePreview(text: string, max = 80): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const flat = line.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** Flatten a rendered segment to text (placeholder for non-text parts, like the CLI). */
function segmentText(rendered: RenderedPrompt['segments'][number]['rendered']): string {
  if (typeof rendered === 'string') return rendered;
  return rendered
    .map((part) =>
      part.type === 'text'
        ? part.value
        : `[${part.type}${part.mime_type ? ` ${part.mime_type}` : ''}]`,
    )
    .join('\n');
}

/**
 * contextSummary — the `summary` scope (§2.4a). Renders the live snapshot and reduces
 * each tier segment to `{ tier, bytes, cache_boundary, preview }` + the snapshot hash and
 * the per-tier `segment_hashes` (the map the diff is computed from). When `verbose`, each
 * segment also carries its full `text` (≈ the CLI's `dumpFull`). Read-only.
 */
export async function contextSummary(
  agent: LaunchedAgent,
  request_id: string,
  verbose: boolean,
): Promise<ContextFrame> {
  // summarize() does the exact render the runtime does (INV #1). We render once more here
  // only when verbose, to attach full segment text without widening the CLI helper.
  const summary = await summarize(agent);
  const segment_hashes: Partial<Record<CacheTier, string>> = {};
  let segments: SegmentSummary[];

  if (verbose) {
    const prompt = await agent.renderer.render(agent.operations.snapshot());
    for (const [tier, hash] of prompt.segment_hashes) {
      segment_hashes[tier as CacheTier] = hash;
    }
    segments = prompt.segments.map((seg) => {
      const text = segmentText(seg.rendered);
      return {
        tier: seg.tier,
        bytes: utf8Bytes(text),
        cache_boundary: seg.cache_boundary,
        preview: firstLinePreview(text),
        text,
      };
    });
  } else {
    // Re-render once to capture segment_hashes (summarize drops them). This is the same
    // read-only render — no extra args, INV #1 intact — and lets the diff layer work.
    const prompt = await agent.renderer.render(agent.operations.snapshot());
    for (const [tier, hash] of prompt.segment_hashes) {
      segment_hashes[tier as CacheTier] = hash;
    }
    segments = summary.segments.map((seg) => ({
      tier: seg.tier as CacheTier,
      bytes: seg.bytes,
      cache_boundary: seg.cache_boundary,
      preview: seg.preview,
    }));
  }

  return {
    kind: 'context',
    v: '0',
    request_id,
    scope: 'summary',
    snapshot_hash: summary.snapshot_hash,
    segments,
    segment_hashes,
  };
}

/** Map a CLI AppSummary into the protocol's AppAttribution (identical shape). */
function toAppAttribution(s: ReturnType<typeof installedApps>[number]): AppAttribution {
  return {
    id: s.id,
    version: s.version,
    blocks: s.blocks,
    commands: s.commands,
  };
}

/**
 * contextAttribution — the `attribution` scope (§2.4b): per-app reflection via the CLI's
 * `appsView` (installed apps with owned block names + each command's user_only flag, plus
 * the available-app catalog). Read-only registry reflection.
 */
export function contextAttribution(agent: LaunchedAgent, request_id: string): ContextFrame {
  const view = appsView(agent);
  const installed: AppAttribution[] = view.installed.map(toAppAttribution);
  const available: AvailableApp[] = view.available.map((a) => ({
    id: a.id,
    summary: a.summary,
    default_enabled: a.default_enabled,
    ...(a.requires !== undefined ? { requires: a.requires } : {}),
  }));
  return {
    kind: 'context',
    v: '0',
    request_id,
    scope: 'attribution',
    attribution: { installed, available },
  };
}

/**
 * contextAppPreview — the `app_preview` scope: a single installed app's reflection (the
 * CLI's `installedApps` filtered to one id). `app_preview` is null when the id is not
 * installed. Read-only.
 */
export function contextAppPreview(
  agent: LaunchedAgent,
  request_id: string,
  app_id: string | undefined,
): ContextFrame {
  const match =
    app_id === undefined
      ? undefined
      : installedApps(agent).find((s) => s.id === app_id);
  return {
    kind: 'context',
    v: '0',
    request_id,
    scope: 'app_preview',
    app_preview: match ? toAppAttribution(match) : null,
  };
}

/**
 * contextBlocks — the `blocks` scope (§2.4 / D3 §4.4): the per-block array the animated
 * sidebar binds to (weight bar + grow/shrink diff + per-block changed flag). For each
 * named block in the live snapshot tree we attach `{ name, app_id, owner, tier, bytes,
 * content_hash, preview }` via `registry.resolve_builder` (the SAME registry seam appsView
 * uses) + the snapshot block's stored content.
 *
 * Read-only: walks `operations.snapshot()` (a frozen copy-on-write capture — never the
 * live tree) and reflects the registry; it never renders with extra args, never mutates,
 * so INV #1 holds. The authoritative per-TIER byte/hash totals live in the `summary`
 * scope (driven by the real rendered prompt); this per-block layer is the registry-keyed
 * row-level join. Blocks with no owner builder (the tree root, grouping containers) are
 * skipped — they contribute no rendered content (matches the renderer, §7).
 */
export async function contextBlocks(agent: LaunchedAgent, request_id: string): Promise<ContextFrame> {
  const snapshot = agent.operations.snapshot();

  // The rendered text per block — the builder's OUTPUT, NOT the snapshot's stored
  // `content_text` (which is empty/placeholder for builder-owned blocks). Reading raw
  // content_text reported every card as 0 bytes; render_blocks runs the same build pass the
  // prompt does, so the sidebar's per-block sizes match what the model actually sees. A
  // renderer without render_blocks (a test double) degrades to the raw-content fallback.
  const renderedText = new Map<string, string>();
  if (agent.renderer.render_blocks) {
    for (const rb of await agent.renderer.render_blocks(snapshot)) renderedText.set(rb.name, rb.text);
  }

  const blocks: BlockAttribution[] = [];
  const walk = (block: Readonly<Block>): void => {
    const builder = agent.registry.resolve_builder(block.name);
    // Only attribute blocks an app builder owns (the cards the inspector draws). The
    // root + structural containers have no builder and render nothing.
    if (builder !== null) {
      // Prefer the rendered text; fall back to the raw stored content if the builder
      // rendered nothing this snapshot (or render_blocks is unavailable).
      const text = renderedText.get(block.name) ?? block.content_text ?? '';
      blocks.push({
        name: block.name,
        app_id: builder.app_id ?? null,
        owner: builder.owner,
        tier: agent.registry.tier_of(block.name),
        bytes: utf8Bytes(text),
        content_hash: contentHash(text),
        preview: firstLinePreview(text),
      });
    }
    for (const child of block.children) walk(child);
  };
  walk(snapshot.root);

  // Deterministic order (by namespaced name) — mirrors the renderer's within-tier sort.
  blocks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    kind: 'context',
    v: '0',
    request_id,
    scope: 'blocks',
    blocks,
  };
}

/**
 * contextBlock — the `block` scope (D3 §3.3/§4.2 body-on-expand): ONE named block's full
 * body, fetched lazily when a sidebar card expands. Returns `{ name, content_hash, text }`.
 *
 * It uses the EXACT same content source + hash as `contextBlocks` (the snapshot block's
 * stored `content_text`), so the `content_hash` here matches the one the `blocks` layer
 * reported for this name — that is what lets the client cache the body by hash and skip the
 * fetch when an unchanged hash recurs (D3 §3.3 cache key). `text` is null when the name is
 * absent from the snapshot (so the client can drop a stale card). `text` is content only —
 * no metadata (INV #2). Read-only: walks the frozen snapshot, never mutates, INV #1 intact.
 */
export async function contextBlock(
  agent: LaunchedAgent,
  request_id: string,
  block_name: string | undefined,
): Promise<ContextFrame> {
  // Resolve the block's RENDERED text (builder output) so this body — and its content_hash
  // — match what the `blocks` layer reported for the same name (the cache-key contract). The
  // raw snapshot content_text is empty for builder-owned blocks, so hashing it would mismatch
  // the sidebar and break body caching. Fall back to raw content if render_blocks is absent.
  let text: string | null = null;
  if (block_name !== undefined) {
    if (agent.renderer.render_blocks) {
      const rb = (await agent.renderer.render_blocks(agent.operations.snapshot())).find(
        (b) => b.name === block_name,
      );
      if (rb) text = rb.text;
    }
    if (text === null) {
      // Not produced by render_blocks (no builder / rendered nothing / no render_blocks):
      // fall back to the raw stored content if the block exists, else null (drop the card).
      const snapshot = agent.operations.snapshot();
      let found: Readonly<Block> | null = null;
      const walk = (block: Readonly<Block>): void => {
        if (found !== null) return;
        if (block.name === block_name) found = block;
        else for (const child of block.children) walk(child);
      };
      walk(snapshot.root);
      text = found !== null ? ((found as Readonly<Block>).content_text ?? '') : null;
    }
  }

  const body: BlockBody =
    text === null
      ? { name: block_name ?? '', content_hash: contentHash(''), text: null }
      : { name: block_name ?? '', content_hash: contentHash(text), text };

  return {
    kind: 'context',
    v: '0',
    request_id,
    scope: 'block',
    block: body,
  };
}
