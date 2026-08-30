import { create } from "zustand";

/**
 * WHICH VIEW Settings ▸ Worktrees is showing — the inventory it has always
 * shown, or the automatic-cleanup run history.
 *
 * A store rather than a route search param, for the same reason the panel's
 * search/sort/tier filters are one: the sub-view is panel state, and a
 * remembered settings tab path is a SECTION path (`/settings/worktrees`) that
 * several surfaces hand-write. Threading a second axis through it would mean
 * teaching every one of those about a view they have no opinion on.
 *
 * `focusedRunId` is a HINT, exactly like the notification `focus` it usually
 * comes from: history is bounded by retention GC, so a row read months later
 * can name a run this host no longer has. A missing run lands on the list.
 *
 * NOT persisted, deliberately, mirroring `settings-host-scope-store`: opening
 * Settings should show the inventory, not wherever a notification left the
 * panel days ago.
 */
export type WorktreeCleanupView = "settings" | "cleanupHistory";

interface WorktreeCleanupViewState {
  readonly view: WorktreeCleanupView;
  /** The run to scroll to and expand once history mounts. */
  readonly focusedRunId: string | null;
  readonly openHistory: (focusedRunId: string | null) => void;
  readonly closeHistory: () => void;
  /**
   * Drops the hint once the panel has acted on it, so re-entering history
   * later does not silently re-expand a run the user already closed.
   */
  readonly clearFocusedRun: () => void;
}

export const useWorktreeCleanupViewStore = create<WorktreeCleanupViewState>(
  (set) => ({
    view: "settings",
    focusedRunId: null,
    openHistory: (focusedRunId) =>
      set({ view: "cleanupHistory", focusedRunId }),
    closeHistory: () => set({ view: "settings", focusedRunId: null }),
    clearFocusedRun: () => set({ focusedRunId: null }),
  }),
);

/**
 * The imperative entry point notification routing uses. Kept beside the store
 * (rather than reached through `getState()` at the call site) so the two
 * destinations a `worktreeSettings` row can name — the inventory and the
 * history sub-view — are decided in one place.
 */
export function selectWorktreeCleanupView(
  view: WorktreeCleanupView,
  focusedRunId: string | null,
): void {
  const store = useWorktreeCleanupViewStore.getState();
  if (view === "cleanupHistory") {
    store.openHistory(focusedRunId);
    return;
  }
  store.closeHistory();
}
