/**
 * Lives apart from `epic-sidebar-artifact-search.tsx` so both that component and the panel header's action row can read it without either importing the other's module graph (and so the component file keeps exporting only components, for Fast Refresh).
 */
import { useEpicStore } from "@/hooks/use-epic-store";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";

/**
 * That threshold hid the affordance from most Epics, where it read as a removed feature rather than a considered default - a control that silently disappears is indistinguishable from a regression, and the judgement of whether nine artifacts are worth filtering belongs to the person looking at them.
 * Read-only access is a dead end of a different kind: the host only runs epic file sync (which writes the on-disk artifact mirror the search RPC greps) for writable roles, so on a viewer's device `epic.searchArtifacts` reports `mirror-unavailable` forever - the "still syncing" empty state would be a permanent lie.
 */
export function useArtifactSearchAvailable(): boolean {
  const hasArtifacts = useEpicStore((s) => s.artifacts.allIds.length > 0);
  const writable = isEditableRole(useEpicPermissionRole());
  return hasArtifacts && writable;
}
