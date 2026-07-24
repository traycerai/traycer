/**
 * Whether the artifact panel offers search at all.
 *
 * Lives apart from `epic-sidebar-artifact-search.tsx` so both that component
 * and the panel header's action row can read it without either importing the
 * other's module graph (and so the component file keeps exporting only
 * components, for Fast Refresh).
 */
import { useEpicStore } from "@/hooks/use-epic-store";

/**
 * Below this many artifacts, scanning the tree beats filtering it - so the
 * header shows no search affordance and typing into the tree does nothing.
 * Keeping the control out of small Epics is the point: an always-present box
 * is exactly the weight this rework removes.
 */
export const ARTIFACT_SEARCH_MIN_COUNT = 10;

/** Whether this Epic has enough artifacts to be worth searching. */
export function useArtifactSearchAvailable(): boolean {
  return useEpicStore(
    (s) => s.artifacts.allIds.length >= ARTIFACT_SEARCH_MIN_COUNT,
  );
}
