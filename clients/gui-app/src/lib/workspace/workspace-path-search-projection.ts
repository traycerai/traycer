/**
 * Projects `workspace.searchPaths` results into the file tree's inputs.
 *
 * Host results are ranked NAME matches anywhere under the workspace root, so
 * unlike a listing they carry no structure: the tree adapter derives directory
 * rows from the path strings, and every ancestor of a match has to be open for
 * that match to be visible at all. Folder results arrive WITHOUT a trailing
 * slash (`workspaceSearchPathResultSchema`), so they are re-canonicalized to
 * the trailing-slash directory token the rest of the file-tree code - and the
 * tree adapter - treats as "this row is a directory".
 */
import type { WorkspaceSearchPathResult } from "@traycer/protocol/host/workspace/unary-schemas";
import { ancestorDirectoryPathsOf } from "@/lib/workspace/workspace-file-list-tree";

export interface WorkspaceSearchPathsProjection {
  /** Flat path list for the tree adapter: one row per ranked result. */
  readonly paths: ReadonlyArray<string>;
  /** File results only - a path absent here is a directory row, not openable. */
  readonly fileNameByPath: ReadonlyMap<string, string>;
  /** Directory rows that must be expanded for every match to be visible. */
  readonly expandedDirectoryPaths: ReadonlyArray<string>;
}

export function projectWorkspaceSearchPaths(
  results: ReadonlyArray<WorkspaceSearchPathResult>,
): WorkspaceSearchPathsProjection {
  const paths: string[] = [];
  const fileNameByPath = new Map<string, string>();
  const expandedDirectoryPaths = new Set<string>();

  for (const result of results) {
    const path =
      result.kind === "folder" ? `${result.relPath}/` : result.relPath;
    paths.push(path);
    // A matched FOLDER is a destination, not a container to open: its children
    // are not in the result set, so expanding it would only show an empty row.
    if (result.kind === "file") fileNameByPath.set(path, result.name);
    for (const ancestor of ancestorDirectoryPathsOf(path)) {
      expandedDirectoryPaths.add(ancestor);
    }
  }

  return {
    paths,
    fileNameByPath,
    expandedDirectoryPaths: [...expandedDirectoryPaths],
  };
}
