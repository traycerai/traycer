/**
 * React keys for one list of transcript items, unique even where two blocks of
 * different kinds share a block id.
 *
 * A block id is unique per block TYPE, not per message: Codex names a shell
 * approval after the command it gates (`itemId`), so the approval card and the
 * command row arrive under one id. Keying both by it collided, and React reuses
 * or drops one of two siblings that share a key.
 *
 * The first item under an id keeps the bare id - the key every item has always
 * had, so nothing already mounted remounts - and only a later item of another
 * kind is qualified by its kind.
 */
export function distinctRenderKeys(
  items: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
): string[] {
  const used = new Set<string>();
  return items.map((item) => {
    let key = used.has(item.id) ? `${item.kind}:${item.id}` : item.id;
    // Same kind AND id twice is not a shape the accumulator produces; suffixed
    // anyway, because a duplicate key is the failure this exists to prevent.
    for (let suffix = 2; used.has(key); suffix += 1) {
      key = `${item.kind}:${item.id}#${suffix}`;
    }
    used.add(key);
    return key;
  });
}
