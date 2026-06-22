/**
 * Builds the renderer-local `WorkspaceFileRef` tab identity from a tree
 * row path.
 *
 * Path strings are NOT parsed, normalized, resolved, or inspected here -
 * the host (`workspace.listFileTree`) owns path canonicalization and
 * supplies both the `path` token and its display `name`. The renderer
 * treats `treePath` as an opaque, host-canonical token. The caller is
 * responsible for passing only real file rows (it filters directory
 * rows via the host's file list, not by inspecting the string).
 */
import { v4 as uuidv4 } from "uuid";
import {
  WORKSPACE_FILE_TAB_KIND,
  type WorkspaceFileRef,
} from "@/stores/epics/canvas/types";

export function workspaceFileTabId(
  hostId: string,
  workspacePath: string,
  filePath: string,
): string {
  return `workspace-file:${encodeURIComponent(hostId)}:${encodeURIComponent(workspacePath)}:${encodeURIComponent(filePath)}`;
}

/**
 * Returns a `WorkspaceFileRef` for a file row. `treePath` (the host's
 * opaque path token) and `name` (the host-supplied display name) are
 * used verbatim. Returns `null` only for an empty token.
 */
export function workspaceFileRefFromTreePath(
  hostId: string,
  workspacePath: string,
  treePath: string,
  name: string,
): WorkspaceFileRef | null {
  if (treePath.length === 0) return null;
  return {
    id: workspaceFileTabId(hostId, workspacePath, treePath),
    instanceId: uuidv4(),
    type: WORKSPACE_FILE_TAB_KIND,
    name,
    hostId,
    workspacePath,
    filePath: treePath,
  };
}
