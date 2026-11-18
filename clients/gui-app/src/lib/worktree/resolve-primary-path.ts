/**
 * Single membership-validating resolver for "which folder is primary" - the
 * one source every consumer (rows, the collapsed chip, optimistic bindings,
 * and both launch paths) reads instead of re-deriving primary from array
 * order or a captured intent's own `isPrimary` bit. A stored `primaryPath`
 * wins only while it still names a folder in the current set; otherwise the
 * first folder is the deterministic fallback (covers absent, stale, and
 * post-removal state alike).
 */
export function resolvePrimaryPath(
  folders: ReadonlyArray<string>,
  primaryPath: string | null,
): string | null {
  if (primaryPath !== null && folders.includes(primaryPath)) {
    return primaryPath;
  }
  return folders[0] ?? null;
}

/**
 * Reorders `folders` so the resolved primary is first, preserving the
 * relative order of every other folder. Feeds the legacy order-sensitive
 * launch boundary (workspace associations / optimistic binding rows), which
 * infers primary from array position; picker DISPLAY order stays untouched -
 * this is a launch-time projection, never written back to a store.
 */
export function orderFoldersPrimaryFirst(
  folders: ReadonlyArray<string>,
  primaryPath: string | null,
): ReadonlyArray<string> {
  const resolved = resolvePrimaryPath(folders, primaryPath);
  if (resolved === null) return folders;
  const rest = folders.filter((path) => path !== resolved);
  return [resolved, ...rest];
}

/**
 * Caps `folders` at `max` while never evicting the resolved primary: the
 * oldest SECONDARY folders are trimmed first (front of the array, skipping
 * the primary's own slot), so a folder-51 add can never silently promote a
 * new primary the way trimming from the front unconditionally would.
 */
export function trimFoldersPreservingPrimary(
  folders: ReadonlyArray<string>,
  primaryPath: string | null,
  max: number,
): ReadonlyArray<string> {
  if (folders.length <= max) return folders;
  const effectivePrimary = resolvePrimaryPath(folders, primaryPath);
  const secondaries = folders.filter((path) => path !== effectivePrimary);
  const keepSecondaryCount = Math.max(
    0,
    max - (effectivePrimary === null ? 0 : 1),
  );
  const keptSecondaries = new Set(
    secondaries.slice(secondaries.length - keepSecondaryCount),
  );
  return folders.filter(
    (path) => path === effectivePrimary || keptSecondaries.has(path),
  );
}
