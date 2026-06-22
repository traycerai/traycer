import type { PerWindowSnapshot } from "../../ipc-contracts/window-types";

export function initialRouteForWindowSnapshot(
  snapshot: PerWindowSnapshot,
): string {
  const activeTab =
    snapshot.activeTabId === null
      ? null
      : (snapshot.epicTabs.find((tab) => tab.id === snapshot.activeTabId) ??
        null);
  const activeDraft =
    snapshot.activeLandingDraftId === null
      ? null
      : (snapshot.landingDrafts.find(
          (draft) => draft.id === snapshot.activeLandingDraftId,
        ) ?? null);

  // Non-draft surface activation clears the active draft. A valid active draft
  // therefore denotes the visible restore surface, while activeTabId tracks the
  // last active epic tab inside the canvas.
  if (activeDraft !== null) {
    return `/draft/${encodeURIComponent(activeDraft.id)}`;
  }

  if (activeTab !== null) {
    return `/epics/${encodeURIComponent(activeTab.epicId)}/${encodeURIComponent(
      activeTab.id,
    )}`;
  }

  return "/";
}
