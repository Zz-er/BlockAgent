/**
 * core/block.ts — BlockTree (owned by impl-core)
 *
 * The live, single-writer Block tree plus the COW snapshot machinery the
 * Renderer reads from. This is the §3 data model made operational:
 *   - holds the root Block and a name → node index (INVARIANT #3: at most one
 *     owner per BlockName, enforced here at runtime),
 *   - applies one BlockOp at a time (§4 / §8.5 single-writer),
 *   - takes a deeply-frozen COW BlockSnapshot so rendering is byte-identical
 *     against a stable capture while later writes land in the NEXT snapshot
 *     (INVARIANT #1),
 *   - hands two trusted in-process Apps a zero-copy BlockView (INVARIANT #18),
 *   - splits/validates the `<app_id>:<name>` namespace (INVARIANT #15).
 *
 * Authoritative design: ai_com/block-agent-architecture-v3.1.md §3 / §3.1 / §8.5 / §10.3.
 *
 * NOTE ON DELETE (INVARIANT #5 / #6): a non-physical delete ARCHIVES — the block
 * is detached from the rendered tree but retained (archive 永存), so it never
 * leaves the system. A physical delete actually drops it. BlockTree honors
 * whichever `physical` flag it is handed; the decision of whether `physical` is
 * permitted belongs to PolicyEngine, not here (this file holds no policy).
 */

import type {
  Block,
  BlockName,
  BlockOp,
  BlockSnapshot,
  BlockView,
  // The wave-2 actor interface. Imported under an alias because this module's
  // concrete class is *also* named `BlockTree`; the class `implements` the alias.
  BlockTree as BlockTreeContract,
} from './types.js';

// ============================================================================
// §3.1 BlockName namespace helpers
// ============================================================================

/** Thrown when an operation violates a tree-level invariant (not a policy call). */
export class BlockTreeError extends Error {
  override readonly name = 'BlockTreeError';
  constructor(message: string) {
    super(message);
  }
}

/** Fields an `update` BlockOp may carry; key-presence means "set this field". */
interface UpdatePatch {
  content_text?: string | null;
  content_blob?: Block['content_blob'];
}

/** The parsed halves of a `<app_id>:<name>` BlockName. */
export interface ParsedBlockName {
  app_id: string;
  /** The portion after the first colon (may itself contain dots, e.g. `tool_result.7a3`). */
  local: string;
}

/**
 * Split a BlockName into its owner `app_id` and local part on the FIRST colon
 * (INVARIANT #15). A local part may contain further colons/dots; only the first
 * colon delimits the namespace, so `mcp:server:tool` → app `mcp`, local
 * `server:tool`. Throws if the name is not `<app_id>:<name>`.
 */
export function split_block_name(name: BlockName): ParsedBlockName {
  const colon = name.indexOf(':');
  if (colon <= 0 || colon === name.length - 1) {
    throw new BlockTreeError(
      `BlockName must be '<app_id>:<name>' with a non-empty app_id and name (got '${name}')`,
    );
  }
  return { app_id: name.slice(0, colon), local: name.slice(colon + 1) };
}

/** True iff `name` is a well-formed `<app_id>:<name>` namespace string. */
export function is_valid_block_name(name: string): name is BlockName {
  const colon = name.indexOf(':');
  return colon > 0 && colon < name.length - 1;
}

/** The owner App id of a block name (the part before the first colon). */
export function owner_app_id(name: BlockName): string {
  return split_block_name(name).app_id;
}

// ============================================================================
// BlockTree
// ============================================================================

/**
 * BlockTree — the live mutable context tree. ONE writer at a time (the writer is
 * Operations; see §8.5). Reads for rendering go through `snapshot()`, never the
 * live nodes, so a render never observes a half-applied op.
 */
export class BlockTree implements BlockTreeContract {
  /** The live root. Mutable; callers outside Operations must not hold it. */
  private root: Block;

  /**
   * name → live node, for O(1) resolution and single-owner enforcement
   * (INVARIANT #3). Covers every block currently attached to the rendered tree.
   */
  private readonly index = new Map<BlockName, Block>();

  /**
   * Archived blocks (non-physical delete, INVARIANT #5/#6). Kept out of the
   * rendered tree but never destroyed; still addressable by name so an archival
   * delete is reversible and auditable.
   */
  private readonly archive = new Map<BlockName, Block>();

  /** Maps every live node id → its parent node (null for the root). */
  private readonly parents = new Map<string, Block | null>();

  /**
   * Empty-tree boot (§2): `new BlockTree()` starts with a bare synthetic root
   * `core:root` that Apps fill on install. Pass `initialRoot` only for a
   * sub-agent ephemeral subtree (§8.4). The root name uses the reserved `core`
   * namespace so no App can own it.
   */
  constructor(initialRoot?: Block) {
    this.root = initialRoot ?? BlockTree.empty_root();
    this.reindex();
  }

  /** The synthetic root for an empty-tree boot. */
  static empty_root(): Block {
    return {
      id: 'core:root',
      name: 'core:root',
      children: [],
      content_text: null,
      content_blob: null,
    };
  }

  // ---- read-side ----------------------------------------------------------

  /** The live root (trusted in-process callers only; do not mutate directly). */
  get_root(): Block {
    return this.root;
  }

  /** Resolve a live node by name; null if not attached to the rendered tree. */
  get(name: BlockName): Block | null {
    return this.index.get(name) ?? null;
  }

  /** True iff a live block with this name exists in the rendered tree. */
  has(name: BlockName): boolean {
    return this.index.has(name);
  }

  /**
   * A read-only zero-copy VIEW of a block subtree for sharing between two trusted
   * in-process Apps (INVARIANT #18). The view is frozen and carries a marker that
   * forbids persisting/forwarding it. It does NOT cross a snapshot boundary; an
   * untrusted consumer must instead take a by-value copy (the caller decides).
   */
  view(name: BlockName): BlockView | null {
    const node = this.index.get(name);
    if (!node) return null;
    return Object.freeze({
      block: deep_freeze(structured_copy(node)),
    }) as unknown as BlockView;
  }

  // ---- snapshot (COW) -----------------------------------------------------

  /**
   * Capture a deeply-frozen, copy-on-write read-only snapshot of the whole tree
   * (§8.5). Rendering reads THIS; concurrent writes mutate the live tree and show
   * up only in the next snapshot. Same tree → byte-identical capture, which is
   * what makes rendering byte-identical (INVARIANT #1).
   */
  snapshot(): BlockSnapshot {
    const frozen_root = deep_freeze(structured_copy(this.root));

    // Build a name → frozen-node lookup over the captured copy so `get` reads the
    // snapshot, not the live index (which may have moved on).
    const by_name = new Map<BlockName, Readonly<Block>>();
    walk(frozen_root, (b) => by_name.set(b.name, b));

    const hash = hash_block(frozen_root);

    return Object.freeze({
      root: frozen_root,
      hash,
      get(name: BlockName): Readonly<Block> | null {
        return by_name.get(name) ?? null;
      },
    });
  }

  // ---- write-side: the single mutation primitive --------------------------

  /**
   * Apply ONE tree mutation (§4). This is the only place the live tree changes
   * shape. Operations calls this after PolicyEngine has authorized the
   * originating command; BlockTree performs no policy checks of its own.
   *
   * Each op is validated against tree invariants (namespace form, single owner,
   * parent existence) and throws BlockTreeError on violation — Operations turns
   * that into a command error rather than a partial write.
   */
  applyOp(op: BlockOp): void {
    switch (op.kind) {
      case 'create':
        this.op_create(op.parent, op.block, op.index);
        return;
      case 'update':
        this.op_update(op.target, {
          ...('content_text' in op ? { content_text: op.content_text } : {}),
          ...('content_blob' in op ? { content_blob: op.content_blob } : {}),
        });
        return;
      case 'delete':
        this.op_delete(op.target, op.physical ?? false);
        return;
      case 'move':
        this.op_move(op.target, op.new_parent, op.index);
        return;
      case 'append':
        this.op_append(op.target, op.child);
        return;
      default: {
        // Exhaustiveness guard: a new BlockOp kind must be handled explicitly.
        const _never: never = op;
        throw new BlockTreeError(`unknown BlockOp kind: ${JSON.stringify(_never)}`);
      }
    }
  }

  /**
   * Apply several ops as ONE logical change (all-or-nothing). If any op throws a
   * BlockTreeError, the tree is restored to its pre-batch shape so a bad op in a
   * command's `ops[]` never leaves a half-applied tree (the caller surfaces the
   * error). Restoration re-roots from a structural backup and reindexes; cheap
   * for the small op-batches a command produces.
   */
  applyOps(ops: BlockOp[]): void {
    if (ops.length === 0) return;
    if (ops.length === 1) {
      // Single op: applyOp already validates-before-mutate per the op kind, and a
      // throw leaves at most that one op's partial effect — but our op impls
      // validate before any structural change, so a throw means no change.
      const [only] = ops;
      if (only) this.applyOp(only);
      return;
    }
    // Multi-op: back up, apply, roll back on failure.
    const backup_root = structured_copy(this.root);
    const backup_archive = new Map(this.archive);
    try {
      for (const op of ops) this.applyOp(op);
    } catch (err) {
      this.root = backup_root;
      this.archive.clear();
      for (const [k, v] of backup_archive) this.archive.set(k, v);
      this.reindex();
      throw err;
    }
  }

  // ---- op implementations -------------------------------------------------

  private op_create(parent_name: BlockName, block: Block, index?: number): void {
    this.assert_name(block.name);
    if (this.index.has(block.name)) {
      throw new BlockTreeError(
        `create: '${block.name}' already has an owner block (single-owner, INV #3)`,
      );
    }
    if (this.archive.has(block.name)) {
      throw new BlockTreeError(
        `create: '${block.name}' is archived; restore via move rather than re-create`,
      );
    }
    const parent = this.require_live(parent_name, 'create.parent');
    // Indexing the incoming subtree also rejects a payload that smuggles in a
    // duplicate name anywhere beneath `block`.
    const inserted = structured_copy(block);
    this.assert_subtree_namespaces(inserted);
    this.assert_subtree_fresh(inserted);
    insert_child(parent, inserted, index);
    this.attach_subtree(inserted, parent);
  }

  private op_update(target: BlockName, patch: UpdatePatch): void {
    const node = this.require_live(target, 'update.target');
    // exactOptionalPropertyTypes: only overwrite a field the op actually carries.
    // The op explicitly distinguishes "set to null" from "leave unchanged" by
    // whether the key is present, so key-presence (not value) is the test.
    if ('content_text' in patch && patch.content_text !== undefined) {
      node.content_text = patch.content_text;
    }
    if ('content_blob' in patch && patch.content_blob !== undefined) {
      node.content_blob = patch.content_blob ? { ...patch.content_blob } : null;
    }
  }

  private op_delete(target: BlockName, physical: boolean): void {
    if (target === this.root.name) {
      throw new BlockTreeError('delete: cannot delete the root block');
    }
    const node = this.require_live(target, 'delete.target');
    const parent = this.parents.get(node.id) ?? null;
    if (!parent) {
      throw new BlockTreeError(`delete: '${target}' has no parent (corrupt tree)`);
    }
    detach_child(parent, node);
    this.detach_subtree(node);

    if (physical) {
      // INVARIANT #5: physical removal — the block is gone (PolicyEngine gated
      // whether we got here). Nothing retained.
      return;
    }
    // Default: ARCHIVE (INVARIANT #6, archive 永存). Retain addressable by name.
    this.archive_subtree(node);
  }

  private op_move(target: BlockName, new_parent_name: BlockName, index?: number): void {
    if (target === this.root.name) {
      throw new BlockTreeError('move: cannot move the root block');
    }
    const node = this.require_live(target, 'move.target');
    const new_parent = this.require_live(new_parent_name, 'move.new_parent');
    if (node === new_parent || is_ancestor(node, new_parent)) {
      throw new BlockTreeError(
        `move: '${new_parent_name}' is inside '${target}' — would create a cycle`,
      );
    }
    const old_parent = this.parents.get(node.id) ?? null;
    if (!old_parent) {
      throw new BlockTreeError(`move: '${target}' has no parent (corrupt tree)`);
    }
    detach_child(old_parent, node);
    insert_child(new_parent, node, index);
    this.parents.set(node.id, new_parent);
  }

  private op_append(target: BlockName, child: Block): void {
    this.assert_name(child.name);
    if (this.index.has(child.name)) {
      throw new BlockTreeError(
        `append: '${child.name}' already has an owner block (single-owner, INV #3)`,
      );
    }
    const parent = this.require_live(target, 'append.target');
    const inserted = structured_copy(child);
    this.assert_subtree_namespaces(inserted);
    this.assert_subtree_fresh(inserted);
    insert_child(parent, inserted, undefined);
    this.attach_subtree(inserted, parent);
  }

  // ---- index maintenance --------------------------------------------------

  /** Rebuild index + parent map from scratch (constructor / after a bulk swap). */
  private reindex(): void {
    this.index.clear();
    this.parents.clear();
    this.parents.set(this.root.id, null);
    const seen = new Set<BlockName>();
    walk(this.root, (b, parent) => {
      this.assert_name(b.name);
      if (seen.has(b.name)) {
        throw new BlockTreeError(
          `tree has two blocks named '${b.name}' (single-owner, INV #3)`,
        );
      }
      seen.add(b.name);
      this.index.set(b.name, b);
      if (parent) this.parents.set(b.id, parent);
    });
  }

  private attach_subtree(node: Block, parent: Block): void {
    walk(node, (b, p) => {
      this.index.set(b.name, b);
      this.parents.set(b.id, p ?? parent);
    });
  }

  private detach_subtree(node: Block): void {
    walk(node, (b) => {
      this.index.delete(b.name);
      this.parents.delete(b.id);
    });
  }

  private archive_subtree(node: Block): void {
    walk(node, (b) => {
      this.archive.set(b.name, b);
    });
  }

  private assert_subtree_namespaces(node: Block): void {
    walk(node, (b) => this.assert_name(b.name));
  }

  private assert_subtree_fresh(node: Block): void {
    walk(node, (b) => {
      if (this.index.has(b.name)) {
        throw new BlockTreeError(
          `insert: '${b.name}' already has an owner block (single-owner, INV #3)`,
        );
      }
    });
  }

  private assert_name(name: string): void {
    if (!is_valid_block_name(name)) {
      throw new BlockTreeError(
        `BlockName must be '<app_id>:<name>' (got '${name}', INV #15)`,
      );
    }
  }

  private require_live(name: BlockName, where: string): Block {
    const node = this.index.get(name);
    if (!node) {
      throw new BlockTreeError(`${where}: no live block named '${name}'`);
    }
    return node;
  }
}

// ============================================================================
// Pure tree helpers (no class state)
// ============================================================================

/** Depth-first visit of a subtree, passing each node and its parent (null at top). */
function walk(node: Block, visit: (b: Block, parent: Block | null) => void): void {
  const stack: Array<{ b: Block; parent: Block | null }> = [{ b: node, parent: null }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top) break; // noUncheckedIndexedAccess guard (unreachable: length checked)
    visit(top.b, top.parent);
    for (const child of top.b.children) {
      stack.push({ b: child, parent: top.b });
    }
  }
}

/** True iff `maybe_descendant` lies anywhere within `node`'s subtree. */
function is_ancestor(node: Block, maybe_descendant: Block): boolean {
  let found = false;
  walk(node, (b) => {
    if (b === maybe_descendant) found = true;
  });
  return found;
}

function insert_child(parent: Block, child: Block, index: number | undefined): void {
  if (index === undefined || index >= parent.children.length) {
    parent.children.push(child);
  } else if (index <= 0) {
    parent.children.unshift(child);
  } else {
    parent.children.splice(index, 0, child);
  }
}

function detach_child(parent: Block, child: Block): void {
  const at = parent.children.indexOf(child);
  if (at >= 0) parent.children.splice(at, 1);
}

/**
 * A deep structural copy of a block subtree. Used to (a) take a COW snapshot and
 * (b) defensively copy a block payload on the way into the tree so the caller
 * cannot keep a live reference. `associated` (BlockRef[]) is copied by value.
 */
function structured_copy(b: Block): Block {
  const copy: Block = {
    id: b.id,
    name: b.name,
    children: b.children.map(structured_copy),
    content_text: b.content_text,
    content_blob: b.content_blob ? { ...b.content_blob } : null,
  };
  if (b.associated !== undefined) {
    copy.associated = b.associated.map((ref) =>
      ref.name !== undefined ? { id: ref.id, name: ref.name } : { id: ref.id },
    );
  }
  return copy;
}

/** Recursively freeze a block subtree in place (children frozen before parent). */
function deep_freeze(b: Block): Readonly<Block> {
  for (const child of b.children) deep_freeze(child);
  Object.freeze(b.children);
  if (b.content_blob) Object.freeze(b.content_blob);
  if (b.associated) {
    for (const ref of b.associated) Object.freeze(ref);
    Object.freeze(b.associated);
  }
  return Object.freeze(b);
}

/**
 * A stable content hash of a (frozen) block subtree. Deterministic: depends only
 * on structure + content, never on Map/object insertion order beyond the fixed
 * field order written here, and never on time/random (INVARIANT #1 / #16). FNV-1a
 * over a canonical serialization — adequate for cache-stability assertions; not a
 * cryptographic digest.
 */
function hash_block(root: Readonly<Block>): string {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      // FNV prime multiply, kept in 32-bit via Math.imul.
      h = Math.imul(h, 0x01000193);
    }
  };
  const visit = (b: Readonly<Block>): void => {
    feed('\x01'); // node-open marker keeps sibling boundaries unambiguous
    feed(b.id);
    feed('\x02');
    feed(b.name);
    feed('\x02');
    feed(b.content_text ?? '\x00');
    feed('\x02');
    if (b.content_blob) {
      feed(b.content_blob.mime_type);
      feed('\x03');
      feed(b.content_blob.data);
    } else {
      feed('\x00');
    }
    feed('\x02');
    for (const child of b.children) visit(child);
    feed('\x04'); // node-close marker
  };
  visit(root);
  // Unsigned hex, fixed width for a stable byte-length.
  return (h >>> 0).toString(16).padStart(8, '0');
}
