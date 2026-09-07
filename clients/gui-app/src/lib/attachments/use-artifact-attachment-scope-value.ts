import { useMemo } from "react";

import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import type {
  ArtifactAttachmentReadClient,
  ArtifactAttachmentScopeValue,
} from "@/lib/attachments/artifact-attachment-scope-context";

/** Build the scope a tile provides, resolving the host's build alongside it. */
export function useArtifactAttachmentScopeValue(
  epicId: string,
  artifactId: string,
  hostId: string,
  client: ArtifactAttachmentReadClient | null,
): ArtifactAttachmentScopeValue {
  const entry = useHostDirectoryEntry(hostId);
  const hostVersion = entry?.version ?? null;
  return useMemo(
    () => ({ epicId, artifactId, hostId, hostVersion, client }),
    [epicId, artifactId, hostId, hostVersion, client],
  );
}
