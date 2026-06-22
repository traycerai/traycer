import type {
  PerWindowLandingDraft,
  PerWindowSnapshot,
} from "../../ipc-contracts/window-types";

export function uniquePerWindowTabs(
  tabs: PerWindowSnapshot["epicTabs"],
): PerWindowSnapshot["epicTabs"] {
  const seen = new Set<string>();
  return tabs.flatMap((tab) => {
    if (seen.has(tab.id)) return [];
    seen.add(tab.id);
    return [tab];
  });
}

export function uniqueLandingDrafts(
  drafts: readonly PerWindowLandingDraft[],
): readonly PerWindowLandingDraft[] {
  const seen = new Set<string>();
  return drafts.flatMap((draft) => {
    if (seen.has(draft.id)) return [];
    seen.add(draft.id);
    return [draft];
  });
}
