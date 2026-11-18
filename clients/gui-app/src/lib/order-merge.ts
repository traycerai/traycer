/**
 * One rule for reconciling a persisted ORDER with the canonical one, shared by
 * every order field the layout stores hold (composer toolbar clusters, the
 * dock, status-bar segments, the pinned context-breakdown rows).
 *
 * The problem every one of them has: a stored list was written by some build,
 * and this build's canonical list may name an id that build did not have (a new
 * dock row, a provider that just connected) or may no longer name one it did (a
 * retired element). Appending the newcomers would put a new element at the far
 * end of a row it belongs in the middle of, and a reader would meet it as a
 * stray; dropping the stored order and taking the canonical one would throw away
 * an arrangement the user made.
 *
 * So: the stored order wins for everything both lists know about, and a missing
 * id lands where its NEIGHBOURS put it - right after the nearest canonical id
 * ahead of it that is actually present, or at the front when none is. An id the
 * canonical list does not name is dropped; a duplicate keeps its first
 * appearance only, because an element drawn twice is not a shape any of these
 * rows has.
 */
export function mergeOrder<T extends string>(
  stored: ReadonlyArray<unknown>,
  canonical: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const merged: T[] = [];
  for (const entry of stored) {
    // `find` rather than a cast: it is the membership test AND the narrowing,
    // and these lists are a handful of ids long.
    const id = canonical.find((candidate) => candidate === entry);
    if (id === undefined || merged.includes(id)) continue;
    merged.push(id);
  }
  // Forward over the canonical list so an inserted id can itself anchor the
  // next one - three new rows in a row stay in their canonical order rather
  // than piling up reversed after the same neighbour.
  for (const [index, id] of canonical.entries()) {
    if (merged.includes(id)) continue;
    const insertAt = canonical
      .slice(0, index)
      .reduce(
        (nearest, preceding) =>
          merged.includes(preceding) ? merged.indexOf(preceding) + 1 : nearest,
        0,
      );
    merged.splice(insertAt, 0, id);
  }
  return merged;
}
