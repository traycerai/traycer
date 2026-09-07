/**
 * Cheap structural pre-check before `epic.resolveArtifactByPath`. Match the `epics/<epicId>/artifacts/<chain>/index.md` subsequence anywhere in the path, not a local prefix.
 */

import { deriveArtifactPathLayoutRootAgnostic } from "@traycer/protocol/common/artifact-path";

/** epicId from an unpinned `epics/<id>/artifacts/.../index.md` scan, else null. Does not touch the filesystem. */
export function artifactEpicIdFromLinkPath(filePath: string): string | null {
  const layout = deriveArtifactPathLayoutRootAgnostic(filePath, null);
  return layout === null ? null : layout.epicId;
}
