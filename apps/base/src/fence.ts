/**
 * apps/base/src/fence.ts — the root_dir realpath fence for base's file tools (P0.3).
 *
 * THE GAP THIS CLOSES: `base.read_file` / `base.grep` (and `base.bash` once it is a real
 * shell) take a caller-supplied path. Without a fence the agent can read ANY file the
 * process can reach — `/etc/passwd`, another agent's root, the host's secrets — by passing
 * an absolute path, a `../` traversal, or a symlink that points out of its own root. The
 * fence resolves the target to its real on-disk location (collapsing `..` AND symlinks)
 * and refuses anything that does not land inside one of the agent's allowed roots
 * (root_dir → storage_dir). FAIL-CLOSED: if we cannot prove the target is inside an
 * allowed root, we reject — nothing is read, written, or executed.
 *
 * WHY realpath (not a string prefix on the raw path): a raw-string prefix check is fooled
 * by `<root>/link → /etc` (a symlink whose textual path is inside the root but whose real
 * target is outside) and by `<root>/../sibling`. `fs.realpathSync` canonicalizes both the
 * symlink chain and the `..` segments, so the comparison is on the TRUE location.
 *
 * WHY containment is computed with `path.relative` (not `startsWith`): a naive
 * `resolved.startsWith(root)` admits a PREFIX-CONFUSION escape — `E:/root-evil/secret`
 * starts with `E:/root` as a string but is NOT inside `E:/root`. `path.relative` works at
 * path-SEGMENT boundaries: `relative('E:/root', 'E:/root-evil/x') === '..\\root-evil\\x'`,
 * which is correctly rejected. Containment ⇔ the relative path is '' (same dir) or a
 * forward, non-`..`, non-absolute descent.
 *
 * NON-EXISTENT targets (the write side, and a read of a not-yet-created file): realpath
 * throws on a path that does not exist, so we cannot canonicalize it directly. We instead
 * realpath the nearest EXISTING ancestor and re-append the non-existent tail. This still
 * defeats a symlinked ancestor (the existing ancestor's real location is what we fence on)
 * while letting an in-root create/write through once the write side is real.
 *
 * Pure-ish, command-path only: this runs inside command handlers (real fs is fine —
 * INV #16 build-determinism constrains BUILDERS, not commands). It does NO clock/random.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, dirname, basename, join } from 'node:path';

/**
 * Canonicalize a path that may not fully exist yet. Walks up to the nearest existing
 * ancestor, realpaths THAT (collapsing any symlinks in the existing prefix), then
 * re-appends the not-yet-existing tail segments. A path that fully exists is realpath'd
 * directly. The returned path is absolute and symlink-free for its existing prefix.
 */
function realpathAllowingMissing(absPath: string): string {
  // Fast path: the whole path exists → realpath it directly (collapses every symlink).
  try {
    return realpathSync(absPath);
  } catch {
    // Fall through: some suffix does not exist. Walk up to the nearest existing ancestor.
  }
  const tail: string[] = [];
  let cur = absPath;
  // Climb until `dirname` stops moving (filesystem root) or an ancestor resolves.
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) {
      // Reached the FS root and still nothing existed — return the resolved-but-uncanon
      // path. Containment will still be computed against canonical roots, so a truly
      // unreachable path is rejected by the caller; we never invent existence here.
      return absPath;
    }
    tail.unshift(basename(cur));
    cur = parent;
    try {
      const realParent = realpathSync(cur);
      return join(realParent, ...tail);
    } catch {
      // keep climbing
    }
  }
}

/**
 * RootFence — an allowed-roots fence. Construct once with the agent's allowed roots
 * (each is canonicalized at construction, so a symlinked root is compared by its real
 * location). `check(targetPath)` returns the canonical resolved path when it is inside a
 * root, or `null` (FAIL-CLOSED) when it is out of bounds or unresolvable.
 */
export class RootFence {
  /** Canonical (realpath'd where possible), absolute allowed roots. */
  private readonly roots: string[];

  constructor(allowedRoots: readonly string[]) {
    // Canonicalize each root up front. A root that does not yet exist is kept as its
    // absolute form (so the fence still works before the dir is created); an existing
    // root is realpath'd so a symlinked root is matched by its true location.
    this.roots = allowedRoots.map((r) => {
      const abs = resolve(r);
      try {
        return realpathSync(abs);
      } catch {
        return abs;
      }
    });
  }

  /**
   * Resolve `targetPath` (interpreted relative to `process.cwd()`, exactly as `fs`
   * would) to its real on-disk location and verify it falls inside an allowed root.
   * Returns the canonical absolute path on success, or `null` when out of bounds —
   * the caller MUST treat `null` as a hard refusal (no read / write / exec).
   */
  check(targetPath: string): string | null {
    if (typeof targetPath !== 'string' || targetPath.length === 0) return null;
    // Resolve relative paths against cwd — mirrors how node:fs interprets them — so a
    // relative `../escape` is canonicalized the same way the real read would see it.
    const abs = resolve(targetPath);
    const real = realpathAllowingMissing(abs);
    for (const root of this.roots) {
      if (isWithin(root, real)) return real;
    }
    return null;
  }
}

/**
 * True iff `candidate` is `root` itself or a descendant of it, compared at path-segment
 * boundaries (so `E:/root-evil` is NOT inside `E:/root`). `path.relative` yields '' for
 * the same dir and a `..`-prefixed or absolute path for anything outside.
 */
export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true; // candidate IS the root
  if (isAbsolute(rel)) return false; // different drive / root on Windows
  // A leading `..` segment means candidate climbed out of root.
  return rel !== '..' && !rel.startsWith('..' + sep);
}
