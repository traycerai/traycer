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
 * The gate is EMPTINESS, not size.
 *
 * This used to require ten artifacts, on the theory that scanning a short tree
 * beats filtering it. That threshold hid the affordance from most Epics, where
 * it read as a removed feature rather than a considered default - a control
 * that silently disappears is indistinguishable from a regression, and the
 * judgement of whether nine artifacts are worth filtering belongs to the person
 * looking at them.
 *
 * Zero is different in kind. An Epic with no artifacts has nothing to match, so
 * search there is not a judgement call the user could disagree with - every
 * query returns nothing. That case is common (every Epic starts there) and is
 * already answered by the panel's own "No artifacts yet." empty state, so
 * offering to search it is a dead end the header should not advertise.
 */
export function useArtifactSearchAvailable(): boolean {
  return useEpicStore((s) => s.artifacts.allIds.length > 0);
}
