import type { RestorableWindowEntry } from "../windows/desktop-state-store";

/**
 * What `app.on("activate")` should do when there is no live window to focus.
 *
 * On macOS a red-light close of the last window keeps the app alive but leaves
 * no window. Previously `activate` (dock click / re-open) minted a BLANK window,
 * discarding the tabs/canvas/drafts the user had open. Now that those closes
 * preserve the per-window restore snapshot (see
 * `shouldPreserveClosedWindowSnapshot`), `activate` restores the preserved
 * window(s) instead - reusing each window's original id so its preserved
 * snapshot rebinds, exactly mirroring startup reconciliation. If nothing is
 * restorable, fall back to a blank window.
 */
export type ActivateWithoutLiveWindowPlan =
  | {
      readonly kind: "restore";
      readonly entries: readonly RestorableWindowEntry[];
    }
  | { readonly kind: "create-blank" };

export function planActivateWithoutLiveWindow(
  restorableEntries: readonly RestorableWindowEntry[],
): ActivateWithoutLiveWindowPlan {
  const restorable = restorableEntries.filter(hasRestorableContent);
  if (restorable.length === 0) {
    return { kind: "create-blank" };
  }
  return { kind: "restore", entries: restorable };
}

// A window with neither open epic tabs nor landing drafts restores to the same
// blank landing surface a fresh window shows, so there is nothing to preserve;
// treat it as "no content" and let the blank-window fallback handle it.
function hasRestorableContent(entry: RestorableWindowEntry): boolean {
  return (
    entry.snapshot.epicTabs.length > 0 ||
    entry.snapshot.landingDrafts.length > 0
  );
}
