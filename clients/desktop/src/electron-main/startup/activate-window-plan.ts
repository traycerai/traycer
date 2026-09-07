import type { RestorableWindowEntry } from "../windows/desktop-state-store";

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
