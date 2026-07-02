/**
 * Serializes the passive `git.listChangedFiles@1.1` poll against the manual
 * `refreshRelations:true` refresh, which share one cache slot.
 *
 * A bounded-poll or parent-fingerprint `refreshRelations:false` fetch can be
 * in flight when the user forces a refresh; without ordering, that older poll
 * can resolve last and overwrite the newer forced snapshot (e.g. re-serving a
 * cached `unknown` relation the manual refresh just recomputed). The manual
 * refresh cancels the in-flight poll, and this module is the belt-and-suspenders
 * for a poll that starts *during* the refresh: each poll stamps the epoch it
 * began at and drops its own result if a manual refresh landed meanwhile, so the
 * forced snapshot always wins.
 */

const epochs = new Map<string, number>();

/** Stable per-slot identity, matching the v1.1 cache-key inputs. */
export function submoduleSnapshotSlotKey(
  hostId: string | null,
  runningDir: string,
  ignoreWhitespace: boolean,
): string {
  return `${hostId ?? ""}|${runningDir}|${ignoreWhitespace ? "1" : "0"}`;
}

export function readSubmoduleSnapshotEpoch(slotKey: string): number {
  return epochs.get(slotKey) ?? 0;
}

/** Bumped after a manual refresh writes the slot, so any older poll stands down. */
export function bumpSubmoduleSnapshotEpoch(slotKey: string): void {
  epochs.set(slotKey, readSubmoduleSnapshotEpoch(slotKey) + 1);
}

export function __resetSubmoduleSnapshotEpochsForTesting(): void {
  epochs.clear();
}
