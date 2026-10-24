import type { EnvironmentReviewEntry } from "@traycer/protocol/host/environment-schemas";
import type { HeldRow } from "@/components/settings/move/retrospective-sheet";

const HELD_REASONS = new Set(["credential_like_value", "executable_entry"]);

const VALUE_DETAIL = "looked like a key and was held.";
const HOOK_DETAIL = "runs a command and was held.";

/** Held values and hooks; grant-needed writes stay on the page notices. */
export function heldReviewEntries(
  entries: readonly EnvironmentReviewEntry[],
): readonly EnvironmentReviewEntry[] {
  return entries.filter((entry) => HELD_REASONS.has(entry.reason));
}

export function heldRowsFromReview(
  entries: readonly EnvironmentReviewEntry[],
): readonly HeldRow[] {
  return heldReviewEntries(entries).map((entry) => ({
    heldId: entry.entryId,
    name: entry.key,
    kind: entry.reason === "executable_entry" ? "hook" : "value",
    detail: entry.reason === "executable_entry" ? HOOK_DETAIL : VALUE_DETAIL,
  }));
}

export interface HeldItemsGroup {
  readonly hostId: string | null;
  readonly entries: readonly EnvironmentReviewEntry[];
}

export function heldItemsGroupedByHost(
  entries: readonly EnvironmentReviewEntry[],
): readonly HeldItemsGroup[] {
  const order: string[] = [];
  const groups = new Map<string, EnvironmentReviewEntry[]>();
  for (const entry of heldReviewEntries(entries)) {
    const key = entry.hostId ?? "";
    const existing = groups.get(key);
    if (existing === undefined) {
      order.push(key);
      groups.set(key, [entry]);
    } else {
      existing.push(entry);
    }
  }
  return order.map((key) => ({
    hostId: key.length === 0 ? null : key,
    entries: groups.get(key) ?? [],
  }));
}
