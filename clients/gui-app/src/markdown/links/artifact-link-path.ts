/**
 * Client-side structural pre-check for an artifact-shaped markdown link path.
 *
 * Lets the chat link policy cheaply decide "is this an artifact link?" before
 * paying for the `epic.resolveArtifactByPath` RPC. The actual chain walk
 * (folderName -> id) lives server-side; here we only confirm the structural
 * marker and lift the `epicId`.
 *
 * Both the structural shape and the ROOT-PREFIX-AGNOSTIC matching (C1) now live
 * in the shared browser-safe scanner `@traycer/protocol/common/artifact-path`,
 * which the host's RPC resolver consumes too - so the client pre-check and the
 * server resolver can no longer drift on what counts as an artifact path. An
 * agent-authored link carries an absolute path produced wherever the agent ran,
 * which frequently differs from the viewer's local host root (collaborators on
 * a shared epic, the same user on a second device, a foreign
 * `/Users/them/.traycer/...` home); the shared scanner therefore locates the
 * `epics/<epicId>/artifacts/<chain>/index.md` SUBSEQUENCE anywhere inside the
 * path rather than gating on a local prefix.
 */

import { deriveArtifactPathLayoutRootAgnostic } from "@traycer/protocol/common/artifact-path";

/**
 * Returns the `epicId` when `filePath` is structurally an artifact `index.md`
 * (`…/epics/<epicId>/artifacts/<chain>/index.md` with at least one chain
 * folder), else `null` so the caller falls through to normal file handling.
 *
 * The client has no epicId to pin yet, so the shared scanner runs unpinned and
 * lifts the id from the first `epics/<id>/artifacts` marker. Does NOT touch the
 * filesystem or any local root.
 */
export function artifactEpicIdFromLinkPath(filePath: string): string | null {
  const layout = deriveArtifactPathLayoutRootAgnostic(filePath, null);
  return layout === null ? null : layout.epicId;
}
