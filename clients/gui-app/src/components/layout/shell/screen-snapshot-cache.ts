import type { ScreenSnapshot } from "@/components/layout/shell/screen-snapshot";

/** A screen filed under an index can silently start naming a different entry after either; a screen filed under
 * the entry's own key cannot - the key survives re-stamping and is never reused. */

/** The count bounds what a distance rule bounded before - a frozen screen is a whole DOM tree held out of the
 * collector's reach. */
const MAX_RETAINED_SCREENS = 4;

const snapshotsByEntryKey = new Map<string, ScreenSnapshot>();

/** Read defensively rather than through a declared shape. */
export function readHistoryEntryKey(location: {
  readonly state: unknown;
}): string | null {
  const state: unknown = location.state;
  if (typeof state !== "object" || state === null) return null;
  if (!("__TSR_key" in state)) return null;
  const key: unknown = state.__TSR_key;
  return typeof key === "string" ? key : null;
}

/** Re-filing an entry replaces its screen and refreshes its recency - the entry was just departed, which is the
 * strongest claim on being swiped back to. */
export function rememberScreenSnapshot(
  leavingKey: string,
  snapshot: ScreenSnapshot,
): void {
  snapshotsByEntryKey.delete(leavingKey);
  snapshotsByEntryKey.set(leavingKey, snapshot);
  for (const key of snapshotsByEntryKey.keys()) {
    if (snapshotsByEntryKey.size <= MAX_RETAINED_SCREENS) break;
    snapshotsByEntryKey.delete(key);
  }
}

/** A swipe with no destination to show does not invent one: it falls back to the instant navigation this
 * gesture performed before the transition existed. */
export function readScreenSnapshot(entryKey: string): ScreenSnapshot | null {
  return snapshotsByEntryKey.get(entryKey) ?? null;
}

export function clearScreenSnapshots(): void {
  snapshotsByEntryKey.clear();
}
