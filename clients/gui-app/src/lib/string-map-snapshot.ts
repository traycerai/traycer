/**
 * A string-to-string map as a `useSyncExternalStore` snapshot: a primitive
 * React compares by value, so an unchanged map re-renders nothing, and one that
 * decodes back to exactly the map it encoded whatever its keys and values hold
 * (a title is any string, so no separator character is safe).
 */
export function encodeStringMapSnapshot(
  entries: Iterable<readonly [string, string]>,
): string {
  return JSON.stringify(
    [...entries].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function decodeStringMapSnapshot(
  snapshot: string,
): ReadonlyMap<string, string> {
  const decoded: unknown = JSON.parse(snapshot);
  const pairs: unknown[] = Array.isArray(decoded) ? decoded : [];
  const map = new Map<string, string>();
  for (const pair of pairs) {
    if (!Array.isArray(pair)) continue;
    const key: unknown = pair[0];
    const value: unknown = pair[1];
    if (typeof key === "string" && typeof value === "string") {
      map.set(key, value);
    }
  }
  return map;
}
