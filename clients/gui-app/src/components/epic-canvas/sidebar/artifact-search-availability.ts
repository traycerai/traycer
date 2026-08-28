/**
 * Whether the artifact panel offers search at all.
 *
 * Lives apart from `epic-sidebar-artifact-search.tsx` so both that component
 * and the panel header's action row can read it without either importing the
 * other's module graph (and so the component file keeps exporting only
 * components, for Fast Refresh).
 */
import { useEpicStore } from "@/hooks/use-epic-store";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";

/**
 * The gate is EMPTINESS plus WRITE ACCESS, not size.
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
 *
 * Read-only access is a dead end of a different kind: the host only runs epic
 * file sync (which writes the on-disk artifact mirror the search RPC greps)
 * for writable roles, so on a viewer's device `epic.searchArtifacts` reports
 * `mirror-unavailable` forever - the "still syncing" empty state would be a
 * permanent lie. Until search works without the mirror, withhold the
 * affordance entirely for viewers (a null, not-yet-known role counts as
 * read-only rather than briefly advertising a search that may then vanish).
 */
export function useArtifactSearchAvailable(): boolean {
  const hasArtifacts = useEpicStore((s) => s.artifacts.allIds.length > 0);
  const writable = isEditableRole(useEpicPermissionRole());
  return hasArtifacts && writable;
}
