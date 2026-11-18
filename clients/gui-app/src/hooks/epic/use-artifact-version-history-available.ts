import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";

/**
 * Whether the tab's host negotiated the read RPCs the artifact version
 * history control needs, and an Epic session is actually open.
 *
 * Shared by `ArtifactVersionHistoryEntryPointContent` (which gates the
 * trigger itself) and by tiles whose header contains only that trigger
 * (`review-tile.tsx`, `spec-tile.tsx`), so those tiles can skip the bordered
 * header row entirely instead of rendering it empty around a trigger that
 * renders null.
 */
export function useArtifactVersionHistoryAvailable(): boolean {
  const openEpicHandle = useMaybeOpenEpicHandle();
  const hostId = useTabHostId();
  const supportsList = useHostSupportsMethod(
    hostId,
    "epic.artifactVersions.list",
  );
  const supportsBlob = useHostSupportsMethod(
    hostId,
    "epic.artifactVersions.getBlob",
  );
  return openEpicHandle !== null && supportsList && supportsBlob;
}
