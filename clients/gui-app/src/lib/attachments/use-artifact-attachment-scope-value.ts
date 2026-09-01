import { useMemo } from "react";

import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import type {
  ArtifactAttachmentReadClient,
  ArtifactAttachmentScopeValue,
} from "@/lib/attachments/artifact-attachment-scope-context";

/**
 * Build the scope a tile provides, resolving the host's build alongside it.
 *
 * A hook rather than four lines in the tile because the tile is already at its
 * complexity ceiling, and because the version lookup is the half most easily
 * dropped by someone wiring a second artifact surface later - it is what makes
 * an in-place host upgrade re-probe instead of staying degraded for the
 * session.
 *
 * ## Why this is its own module and not part of the context file
 *
 * `useHostDirectoryEntry` pulls in `@/lib/host`, which transitively reaches the
 * settings store. The context module is imported by the READ path
 * (`use-attachment-blob-src` and, through it, every image node view), so
 * co-locating this builder there put that whole subtree into the import graph
 * of tests that only ever render a thumbnail - and one of them failed to
 * collect because its `@/lib/artifacts/node-display` mock was suddenly
 * incomplete for a module it never meant to load. The reader must stay
 * dependency-light; only the tile that PROVIDES a scope needs the directory.
 */
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
