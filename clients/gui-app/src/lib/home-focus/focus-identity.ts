/**
 * Identity preservation for the focus builders, the same contract
 * `reconcileAgentActivityByEpic` keeps for the activity store: a rebuild whose
 * CONTENT matches the previous rebuild returns the previous objects, so a store
 * frame that changes nothing produces no new references and nothing re-renders.
 *
 * Kept generic and structural rather than per-row, because every focus row is a
 * flat readonly record over primitives plus at most one nested array - which is
 * exactly what a shallow comparison decides correctly, and exactly what a
 * hand-written per-row comparator would get wrong the first time a field is
 * added.
 */

/**
 * `next`, with every element that shallow-equals its positional counterpart in
 * `previous` replaced by that counterpart - and the `previous` array itself
 * when every element matched.
 *
 * Positional rather than keyed on purpose: these arrays are ordered by a
 * deterministic comparator, so an unchanged list is unchanged in place, and a
 * list whose ORDER moved is a genuinely different rendering.
 */
export function stabilizeRows<T extends object>(
  next: ReadonlyArray<T>,
  previous: ReadonlyArray<T>,
  equal: (a: T, b: T) => boolean,
): ReadonlyArray<T> {
  let changed = next.length !== previous.length;
  const rows = next.map((row, index) => {
    // Bounds-checked by index rather than by an `undefined` test: index access
    // is typed as present here, so only the length can say whether it is.
    if (index < previous.length && equal(row, previous[index])) {
      return previous[index];
    }
    changed = true;
    return row;
  });
  return changed ? rows : previous;
}

/**
 * Shallow record equality, with arrays and nested objects compared by
 * reference. Row builders run their nested arrays through
 * {@link stabilizeRows} first, so a reference match there is a content match
 * here - which is what lets a parent row keep its identity when only a sibling
 * task's agents moved.
 */
export function shallowEqualRow<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const left = Object.entries(a);
  const right = new Map(Object.entries(b));
  if (left.length !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key)) return false;
    if (right.get(key) !== value) return false;
  }
  return true;
}

/**
 * Byte-order ascending, never locale-sensitive, so ordering cannot drift by ICU
 * version or system locale - the same rule the notification feed's
 * `compareFeedIdAscending` keeps.
 */
export function compareAscending(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
