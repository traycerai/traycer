/** A stable, comparable string for a SET of host ids. */
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
