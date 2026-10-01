import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";

/**
 * Whether an open epic's live session reports it as a preserved orphan: its
 * cloud copy was deleted while local edits were kept. The pin reading for such
 * a tab can never be answered, so the tab menu labels it "task deleted".
 *
 * A plain read of the current registry state. The tab menu subscribes to it
 * (`usePreservedOrphanSession`), and the tab's menu-open handler reads it at
 * the moment it runs, so there is no per-tab subscription just to gate a retry.
 */
export function isPreservedOrphanEpic(epicId: string): boolean {
  const state = getOpenEpicRegistry().peek(epicId)?.store.getState();
  return (
    state?.durabilityPauseReason ===
      "orphaned-local-edits-after-cloud-delete" ||
    state?.retainedDurabilityPauseReason ===
      "orphaned-local-edits-after-cloud-delete"
  );
}
