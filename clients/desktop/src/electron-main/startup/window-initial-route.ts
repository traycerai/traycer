import type { PerWindowSnapshot } from "../../ipc-contracts/window-types";

export function initialRouteForWindowSnapshot(
  snapshot: PerWindowSnapshot,
): string {
  const activeTab =
    snapshot.activeTabId === null
      ? null
      : (snapshot.epicTabs.find((tab) => tab.id === snapshot.activeTabId) ??
        null);
  const topology = snapshot.draftTopology;
  const activeDraftId = topology?.activeDraftId ?? null;
  if (
    activeDraftId !== null &&
    topology?.references.some((ref) => ref.slotId === activeDraftId) === true
  ) {
    return `/draft/${encodeURIComponent(activeDraftId)}`;
  }
  const activeDraft =
    topology !== undefined || snapshot.activeLandingDraftId === null
      ? null
      : (snapshot.landingDrafts.find(
          (draft) => draft.id === snapshot.activeLandingDraftId,
        ) ?? null);

  // Non-draft surface activation clears the active draft. A valid active draft
  // therefore denotes the visible restore surface, while activeTabId tracks the
  // last active epic tab inside the canvas.
  if (activeDraft !== null && activeDraft.closed !== true) {
    return `/draft/${encodeURIComponent(activeDraft.id)}`;
  }

  if (activeTab !== null) {
    return `/epics/${encodeURIComponent(activeTab.epicId)}/${encodeURIComponent(
      activeTab.id,
    )}`;
  }

  return "/";
}
