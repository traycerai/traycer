/**
 * A stable, comparable string for a SET of host ids.
 *
 * `useSyncExternalStore` and `useMemo` both compare with `Object.is`, so a
 * derivation that rebuilds an array or a Set on every projection update
 * re-renders everything downstream even when the set is unchanged. Stamping
 * the sorted set as one string turns that into a value comparison.
 *
 * JSON rather than a delimiter join, matching `useCommGraphAgents`: host ids
 * are opaque strings, so no separator is collision-safe by contract.
 */
export function stampHostIds(hostIds: Iterable<string | null>): string {
  const present: string[] = [];
  for (const hostId of hostIds) {
    if (typeof hostId === "string" && hostId.length > 0) present.push(hostId);
  }
  return JSON.stringify([...new Set(present)].sort());
}

/** The inverse of {@link stampHostIds}, narrowed back to strings. */
export function parseHostIdStamp(stamp: string): readonly string[] {
  const parsed: unknown = JSON.parse(stamp);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}
