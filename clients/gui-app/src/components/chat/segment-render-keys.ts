/**
 * React keys for one list of transcript items, unique even where two blocks of
 * different kinds share a block id.
 *
 * A block id is unique per block TYPE, not per message: Codex names a shell
 * approval after the command it gates (`itemId`), so the approval card and the
 * command row arrive under one id. Keying both by it collided, and React reuses
 * or drops one of two siblings that share a key.
 *
 * Every key is the item's own (kind, id), whatever its siblings are: a key that
 * depended on position - the bare id for the first item under it, a qualified
 * one for a later - changed when a sibling left the list, and React remounted
 * the item and dropped its open state. A block keeps its type for life
 * (`replaceBlock` replaces only the same type), so (kind, id) names one block.
 */
export function distinctRenderKeys(
  items: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
): string[] {
  const used = new Set<string>();
  return items.map((item) => {
    // JSON, not `kind:id`, so no id can spell another item's key.
    const base = JSON.stringify([item.kind, item.id]);
    let key = base;
    // Same kind AND id twice is not a shape the accumulator produces; suffixed
    // anyway, because a duplicate key is the failure this exists to prevent.
    for (let suffix = 2; used.has(key); suffix += 1) {
      key = `${base}#${suffix}`;
    }
    used.add(key);
    return key;
  });
}
