/**
 * core/renderer.ts — the Renderer (impl-render owned).
 *
 * Renderer.render(snapshot) walks a frozen BlockSnapshot, classifies every block
 * into one of three cache tiers via the BuilderRegistry, runs each block's owner
 * render-builder in a deterministic sandbox, and flattens the result into a
 * tier-segmented RenderedPrompt (stable → slow_changing → volatile). The output
 * is BYTE-IDENTICAL for a given (snapshot, registry) pair — this is what lets the
 * provider's prompt cache hit (INVARIANT #1, §10.3).
 *
 * Authoritative design: ai_com/block-agent-architecture-v3.1.md
 *   §7 BuilderRegistry / BuildContext · §10 Renderer pipeline · §16 invariants.
 *
 * House style (§0.5): Renderer is an actor → role name, no `Block` prefix.
 *
 * BYTE-IDENTICAL discipline enforced here:
 *   - tiers render in a fixed order; within a tier, blocks sort by name (stable).
 *   - we never iterate a Map for output order, never read Date.now/Math.random/
 *     process.env, and never embed a wall-clock value.
 *   - builders run in a BuildContext whose deterministic_* substitutes are pure
 *     functions of their inputs (INVARIANT #16); a builder reaching for a banned
 *     global is its own bug, but the context gives it no excuse.
 */

import { createHash } from 'node:crypto';

import type {
  Block,
  BlockName,
  BlockSnapshot,
  CacheTier,
  ContentPart,
  RenderedBlock,
  RenderedPrompt,
  Renderer as RendererContract,
} from './types.js';
import type {
  AppContext,
  BuildContext,
  BuilderManifest,
  BuilderRegistry,
} from '../app/types.js';

/** Fixed render order of the three cache tiers (§10.2 stable-first, volatile-last). */
const TIER_ORDER: readonly CacheTier[] = ['stable', 'slow_changing', 'volatile'] as const;

/**
 * The tier a block falls into when no owner builder is registered for its name.
 * An unmanaged block (e.g. a fixture block written straight into the tree) is
 * treated as `volatile` so it never poisons the stable cache prefix.
 */
const DEFAULT_TIER: CacheTier = 'volatile';

/**
 * Optional extras the Renderer can use, beyond its one required dependency
 * (the BuilderRegistry). Kept as a SEPARATE optional arg so the canonical
 * constructor stays `new Renderer(builders)` (core/types.ts contract) — the
 * runtime passes the registry directly; these knobs are opt-in.
 */
export interface RendererOptions {
  /**
   * Per-App runtime handle, keyed by app_id, passed to App-owned builders that
   * read their App state. A builder that needs no App state runs with `app_ctx`
   * undefined. STATIC snapshot — prefer `app_context_provider` for the live loop
   * (a Map captured at construction goes stale if Apps install/mutate afterward).
   */
  readonly app_contexts?: ReadonlyMap<string, AppContext>;
  /**
   * LIVE per-App context lookup (preferred over `app_contexts`). Resolved at EACH
   * render, so a builder that projects from `app_ctx.state` (e.g. `messages:recent`,
   * `tools:recent`) always sees the latest committed state after a command mutated
   * it. The runtime wires this to `AppRegistry.get_app_context` at boot. Falling
   * back through this (not just a captured Map) is what closes the state-driven
   * projection seam (an App installed/mutated after Renderer construction still
   * renders correctly). Builders only READ the context; rendering stays pure (INV #16).
   */
  readonly app_context_provider?: (app_id: string) => AppContext | null;
  /**
   * Deterministic config injected into every BuildContext in place of
   * process.env (INVARIANT #16). Keyed by app_id; merged under a `__global`
   * fallback.
   */
  readonly configs?: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

/** One block paired with the tier it renders into and its owner builder (if any). */
interface Classified {
  readonly name: BlockName;
  readonly block: Readonly<Block>;
  readonly tier: CacheTier;
  readonly builder: BuilderManifest | null;
}

export class Renderer implements RendererContract {
  /**
   * Canonical form: `new Renderer(builders)`. The BuilderRegistry is the one
   * stable dependency, injected once (NOT per render). `options` is opt-in for
   * App contexts / deterministic config injection.
   */
  constructor(
    private readonly builders: BuilderRegistry,
    private readonly options: RendererOptions = {},
  ) {}

  /**
   * Render a snapshot into a tier-segmented RenderedPrompt. Deterministic: the
   * same (snapshot, registry, configs) always yields byte-identical segments and
   * identical hashes.
   */
  async render(snapshot: BlockSnapshot): Promise<RenderedPrompt> {
    // 1. Flatten the tree into a name-keyed list, deduped by name (a block name
    //    has at most one owner, INV #3). We collect in tree order then sort, so
    //    the source iteration order can never leak into the output.
    const collected = new Map<BlockName, Readonly<Block>>();
    this.collect(snapshot.root, collected);

    // 2. Classify each block into a tier (via its owner builder) and run the
    //    builder to obtain its rendered block. Build calls are independent, so
    //    we await them together; ORDERING is imposed afterward by sort, never by
    //    completion order — Promise.all preserves index order regardless.
    const names = [...collected.keys()].sort();
    const classified = await Promise.all(
      names.map((name) => this.classifyAndBuild(name, collected.get(name)!, snapshot)),
    );

    // 3. Bucket by tier, then within each tier sort by name (stable, total order
    //    on the namespaced string) for byte-identical layout.
    const byTier = new Map<CacheTier, Classified[]>();
    for (const tier of TIER_ORDER) byTier.set(tier, []);
    for (const item of classified) {
      if (item === null) continue; // builder returned null → render nothing
      byTier.get(item.tier)!.push(item);
    }
    for (const tier of TIER_ORDER) {
      byTier.get(tier)!.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    // 4. Emit one segment per non-empty tier, in fixed tier order. A cache
    //    boundary is placed at the END of every emitted segment: the provider may
    //    insert a prompt-cache breakpoint there (the renderer marks where it is
    //    SAFE; the provider's cache_hint decides which to actually use, §11.3).
    const segments: RenderedPrompt['segments'] = [];
    const segment_hashes = new Map<string, string>();
    for (const tier of TIER_ORDER) {
      const items = byTier.get(tier)!;
      if (items.length === 0) continue;
      const rendered = this.renderTier(items);
      segments.push({ tier, rendered, cache_boundary: true });
      segment_hashes.set(tier, hashContent(rendered));
    }

    const snapshot_hash = this.computeSnapshotHash(snapshot, segment_hashes);
    return { segments, snapshot_hash, segment_hashes };
  }

  /**
   * render_blocks — the per-block projection behind the inspector's sidebar. Runs the
   * EXACT same collect → classifyAndBuild path as `render` (so each block's text is the
   * builder's authoritative output, not the snapshot's empty stored `content_text`), but
   * returns one `{name, tier, text}` per rendered block instead of joining into tier
   * segments. A block whose builder returns null / renders nothing is omitted (it
   * contributes no prompt bytes), matching `render`. Pure + deterministic (INV #1).
   */
  async render_blocks(snapshot: BlockSnapshot): Promise<RenderedBlock[]> {
    const collected = new Map<BlockName, Readonly<Block>>();
    this.collect(snapshot.root, collected);
    const names = [...collected.keys()].sort();
    const classified = await Promise.all(
      names.map((name) => this.classifyAndBuild(name, collected.get(name)!, snapshot)),
    );
    const out: RenderedBlock[] = [];
    for (const item of classified) {
      if (item === null) continue;
      out.push({ name: item.name, tier: item.tier, text: this.blockText(item.block) });
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Tree walk + classification
  // --------------------------------------------------------------------------

  /** Depth-first collect of every block keyed by name (dedupe; INV #3). */
  private collect(block: Readonly<Block>, into: Map<BlockName, Readonly<Block>>): void {
    into.set(block.name, block);
    for (const child of block.children) this.collect(child, into);
  }

  private async classifyAndBuild(
    name: BlockName,
    snapshotBlock: Readonly<Block>,
    snapshot: BlockSnapshot,
  ): Promise<Classified | null> {
    const builder = this.builders.resolve_builder(name);
    const tier = this.builders.tier_of(name) ?? DEFAULT_TIER;

    // No owner builder: render the block straight from the snapshot (unmanaged
    // block). With an owner builder, run it for the authoritative projection;
    // a `null` return means "render nothing this turn" (§7).
    if (!builder) {
      // A pure structural container (no text, no blob — e.g. the tree root or a
      // grouping node) renders nothing; only its children contribute content.
      if (!hasRenderableContent(snapshotBlock)) return null;
      return { name, block: snapshotBlock, tier, builder: null };
    }

    const built = await builder.build(
      this.makeBuildContext(snapshot, name),
      this.appContextFor(builder),
    );
    if (built === null) return null;
    if (!hasRenderableContent(built)) return null;
    return { name, block: built, tier: builder.cache_tier, builder };
  }

  private appContextFor(builder: BuilderManifest): AppContext | undefined {
    if (builder.app_id === undefined) return undefined;
    // Prefer the static Map (tests inject one); otherwise resolve LIVE via the
    // provider so state-driven projection builders see post-mutation state.
    const fromMap = this.options.app_contexts?.get(builder.app_id);
    if (fromMap !== undefined) return fromMap;
    return this.options.app_context_provider?.(builder.app_id) ?? undefined;
  }

  // --------------------------------------------------------------------------
  // Segment rendering
  // --------------------------------------------------------------------------

  /**
   * Render one tier's blocks into the segment payload. If every block is plain
   * text, we join into one string (cheapest cache key). If any block carries a
   * blob, we emit a ContentPart[] so multi-modal providers get structured parts;
   * a text-only provider's fallback is the builder's job (§10.5), not ours.
   */
  private renderTier(items: Classified[]): string | ContentPart[] {
    const hasBlob = items.some((it) => it.block.content_blob !== null);
    if (!hasBlob) {
      return items.map((it) => this.blockText(it.block)).join('\n');
    }
    const parts: ContentPart[] = [];
    for (const it of items) {
      const text = this.blockText(it.block);
      if (text.length > 0) parts.push({ type: 'text', value: text });
      const blob = it.block.content_blob;
      if (blob !== null) {
        const type: ContentPart['type'] = blob.mime_type.startsWith('audio/')
          ? 'audio'
          : 'image';
        parts.push({ type, value: blob.data, mime_type: blob.mime_type });
      }
    }
    return parts;
  }

  /** Deterministic text projection of one block: just its content (no metadata). */
  private blockText(block: Readonly<Block>): string {
    return block.content_text ?? '';
  }

  // --------------------------------------------------------------------------
  // Deterministic BuildContext (INVARIANT #16)
  // --------------------------------------------------------------------------

  /**
   * Construct the sandbox a builder's `build` runs in. Every "non-deterministic"
   * affordance is replaced by a pure function of its inputs so rendering stays
   * byte-identical:
   *   - deterministic_clock(): a fixed logical clock derived from the snapshot
   *     hash (NOT wall-clock). Same snapshot → same value.
   *   - deterministic_random(seed): SHA-256(seed) folded to [0,1).
   *   - content_addressed_id(content): SHA-256(content) hex (replaces randomUUID).
   *   - config: the injected env-substitute for this App.
   */
  private makeBuildContext(snapshot: BlockSnapshot, ownerName: BlockName): BuildContext {
    const appId = ownerName.slice(0, Math.max(0, ownerName.indexOf(':')));
    const config =
      this.options.configs?.get(appId) ??
      this.options.configs?.get('__global') ??
      EMPTY_CONFIG;
    // A logical clock that is stable for a given snapshot: fold the snapshot hash
    // into a number. Never wall-clock — that would break byte-identical render.
    const clock = foldHashToInt(snapshot.hash);
    return {
      snapshot,
      read: (name: BlockName) => snapshot.get(name),
      deterministic_clock: () => clock,
      deterministic_random: (seed: string) => hashToUnitInterval(seed),
      content_addressed_id: (content: string) =>
        createHash('sha256').update(content).digest('hex'),
      config,
    };
  }

  // --------------------------------------------------------------------------
  // Hashing
  // --------------------------------------------------------------------------

  /**
   * snapshot_hash binds together the snapshot's own content hash and the
   * per-segment hashes, so it changes iff the rendered bytes change. We feed the
   * segment hashes in FIXED tier order (not Map iteration order) to keep it
   * deterministic.
   */
  private computeSnapshotHash(
    snapshot: BlockSnapshot,
    segment_hashes: Map<string, string>,
  ): string {
    const h = createHash('sha256');
    h.update(snapshot.hash);
    for (const tier of TIER_ORDER) {
      const seg = segment_hashes.get(tier);
      if (seg !== undefined) h.update(` ${tier} ${seg}`);
    }
    return h.digest('hex');
  }
}

// ============================================================================
// Pure hashing helpers (module-level, no instance state → trivially deterministic)
// ============================================================================

const EMPTY_CONFIG: Readonly<Record<string, string>> = Object.freeze({});

/**
 * A block contributes to the prompt only if it carries content. A node with
 * `content_text === null` AND `content_blob === null` is a pure structural
 * container (the tree root, a grouping node) — its children render, it doesn't.
 * Note: an empty STRING (`''`) is still "content" the owner deliberately chose
 * to emit, so it is renderable (and contributes an empty line); only `null`
 * means "nothing here".
 */
function hasRenderableContent(block: Readonly<Block>): boolean {
  return block.content_text !== null || block.content_blob !== null;
}

/** Hash a segment's rendered payload (string or ContentPart[]) deterministically. */
function hashContent(rendered: string | ContentPart[]): string {
  const h = createHash('sha256');
  if (typeof rendered === 'string') {
    h.update(''); // tag: string
    h.update(rendered);
  } else {
    h.update(''); // tag: parts
    for (const part of rendered) {
      h.update(` ${part.type} ${part.mime_type ?? ''} `);
      h.update(part.value);
    }
  }
  return h.digest('hex');
}

/** Fold a hex hash into a non-negative 32-bit int (logical clock substitute). */
function foldHashToInt(hash: string): number {
  let acc = 0;
  for (let i = 0; i < hash.length; i += 1) {
    acc = (acc * 31 + hash.charCodeAt(i)) >>> 0;
  }
  return acc;
}

/** Map a seed string to a deterministic value in [0, 1). */
function hashToUnitInterval(seed: string): number {
  const digest = createHash('sha256').update(seed).digest();
  // Use the first 6 bytes (48 bits) → divide by 2^48 for a uniform [0,1).
  let n = 0;
  for (let i = 0; i < 6; i += 1) n = n * 256 + digest[i]!;
  return n / 2 ** 48;
}
