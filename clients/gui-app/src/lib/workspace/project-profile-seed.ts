import type { WorkspaceFoldersHostBucket } from "@/stores/workspace/workspace-folders-store";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";

export const PROJECT_PROFILE_SEEDS = ["folder", "all", "empty"] as const;

export type ProjectProfileSeed = (typeof PROJECT_PROFILE_SEEDS)[number];

export interface ProjectProfileFolderSeed {
  readonly folderPaths: ReadonlyArray<string>;
  readonly primaryPath: string | null;
}

/**
 * What a new profile should own. `folder` is one explicit project folder
 * (that project's main). `all` copies the current multi-repo set. `empty`
 * starts with no folders.
 */
export function folderSeedForNewProfile(
  catalog: WorkspaceFoldersHostBucket,
  seed: ProjectProfileSeed,
  projectFolderPath: string | null,
): ProjectProfileFolderSeed {
  if (seed === "empty") {
    return { folderPaths: [], primaryPath: null };
  }
  if (seed === "all") {
    if (catalog.folders.length === 0) {
      return { folderPaths: [], primaryPath: null };
    }
    return {
      folderPaths: [...catalog.folders],
      primaryPath: resolvePrimaryPath(catalog.folders, catalog.primaryPath),
    };
  }
  const chosen =
    projectFolderPath !== null && catalog.folders.includes(projectFolderPath)
      ? projectFolderPath
      : resolvePrimaryPath(catalog.folders, catalog.primaryPath);
  if (chosen === null) {
    return { folderPaths: [], primaryPath: null };
  }
  return { folderPaths: [chosen], primaryPath: chosen };
}
