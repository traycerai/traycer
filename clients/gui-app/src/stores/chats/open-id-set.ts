/**
 * Immutable toggle for an "open id" set. Returns the same set reference when
 * the membership already matches `open`, so zustand `set` callbacks can bail
 * out of a no-op update by identity. Shared by the chat open-state stores
 * (A2A send/received, subagent, and find-force) that store opens as a plain
 * `ReadonlySet<string>`.
 */
export function updateOpenIds(
  openIds: ReadonlySet<string>,
  id: string,
  open: boolean,
): ReadonlySet<string> {
  const wasOpen = openIds.has(id);
  if (wasOpen === open) return openIds;
  const next = new Set(openIds);
  if (open) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}
