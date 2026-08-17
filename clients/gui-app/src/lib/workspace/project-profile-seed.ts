import type { WorkspaceFoldersHostBucket } from "@/stores/workspace/workspace-folders-store";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";

export const PROJECT_PROFILE_SEEDS = ["primary", "all", "empty"] as const;

export type ProjectProfileSeed = (typeof PROJECT_PROFILE_SEEDS)[number];

export interface ProjectProfileFolderSeed {
  readonly folderPaths: ReadonlyArray<string>;
  readonly primaryPath: string | null;
}

/**
 * What a new profile should own. `primary` is the isolation default: one
 * folder, the one the picker already treats as primary. `all` copies the
 * current multi-repo set. `empty` starts with no folders.
 */
export function folderSeedForNewProfile(
  catalog: WorkspaceFoldersHostBucket,
  seed: ProjectProfileSeed,
): ProjectProfileFolderSeed {
  if (seed === "empty" || catalog.folders.length === 0) {
    return { folderPaths: [], primaryPath: null };
  }
  if (seed === "all") {
    return {
      folderPaths: [...catalog.folders],
      primaryPath: resolvePrimaryPath(catalog.folders, catalog.primaryPath),
    };
  }
  const primary = resolvePrimaryPath(catalog.folders, catalog.primaryPath);
  if (primary === null) {
    return { folderPaths: [], primaryPath: null };
  }
  return { folderPaths: [primary], primaryPath: primary };
}
