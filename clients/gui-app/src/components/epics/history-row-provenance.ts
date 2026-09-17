import type { HistoryItem } from "@/components/home/data/home-page.data";

/**
 * Where a task row's copy stands relative to the account, as the status glyph
 * shows it. Kept OUT of `epics-list-shared.tsx` for the same reason
 * `history-pin-availability.ts` is: a module exporting both components and
 * plain values loses Fast Refresh for every component in it.
 *
 * This is the ONE place the task list is allowed to say anything about a
 * row's provenance. The list copy never narrates cloud-versus-device (see
 * `history-pin-availability.ts`); what the person needs is a glyph they can
 * hover, and a sentence that names what to do. Two states carry that:
 *
 *  - `preserved-orphan`: the task was deleted, and the host refused to discard
 *    edits the deleted copy never received (`s5-orphaned-epic-recovery`). The
 *    remedy is to open it and take the edits somewhere - the canvas offers
 *    "Export artifacts" for exactly this row.
 *  - `local-only`: the task has not been synced yet. Promotion runs on open
 *    when the account is entitled (`promotion-scheduler.ts`), so opening the
 *    task IS the remedy for a signed-in account. Under an unverified session
 *    nothing syncs until the sign-in is confirmed, and the sentence says
 *    exactly that and no more: `unverified` covers authn being unreachable
 *    (which recovers on its own) as well as a refused credential and an
 *    unavailable account (`stores/auth/auth-store.ts`), and only one of those
 *    is fixed by signing in again - so the copy states the condition, like
 *    the pin and delete tooltips do, rather than prescribing a remedy the
 *    boolean it receives cannot pick. A plan without sync keeps the row here
 *    for good, which the sentence admits rather than promising a sync that
 *    never comes.
 *
 * Phases have no home of their own and never carry either marker.
 */
export type HistoryRowProvenance = "preserved-orphan" | "local-only";

export function historyRowProvenance(
  item: HistoryItem,
): HistoryRowProvenance | null {
  if (item.taskType === "phase") return null;
  // Orphan first: a preserved orphan was cloud-homed, so the two markers do
  // not co-occur today, but a row carrying both would still be the deleted
  // one - that is the fact with a consequence.
  if (item.isPreservedOrphan === true) return "preserved-orphan";
  if (item.isLocalHome === true) return "local-only";
  return null;
}

/**
 * The short visible label the touch surfaces print beside the dot.
 *
 * A hover tooltip is the desktop's affordance; on a phone the history row is
 * inert to pointers (the activation overlay is the only thing a touch lands
 * on) and the nav drawer's row opens the task on tap, so the dot's sentence
 * would be unreachable there. The label says the condition in two or three
 * words; the full sentence stays the dot's accessible name.
 */
export function historyRowProvenanceLabel(
  provenance: HistoryRowProvenance,
): string {
  return provenance === "preserved-orphan"
    ? "Deleted, edits kept"
    : "Not synced";
}

/**
 * The glyph's tooltip and accessible name. States the condition and the
 * remedy, nothing about which side of the sync each fact came from.
 */
export function historyRowProvenanceTitle(
  provenance: HistoryRowProvenance,
  cloudAuthorized: boolean,
): string {
  if (provenance === "preserved-orphan") {
    return "This task was deleted. Its unsynced edits are kept — open it and export what you need.";
  }
  if (!cloudAuthorized) {
    // States the condition and stops: whether the task WILL sync once the
    // sign-in is confirmed depends on the plan, which this function does not
    // hold - the signed-in sentence below admits the no-sync plan, and this
    // one must not promise what that one hedges.
    return "Not synced yet. Your sign-in couldn't be confirmed, so it can't sync for now.";
  }
  return "Not synced yet. Open this task to sync it; if your plan doesn't include sync, it stays here.";
}
