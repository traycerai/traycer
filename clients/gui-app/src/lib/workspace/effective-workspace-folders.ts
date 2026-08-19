import type { WorkspaceFoldersHostBucket } from "@/stores/workspace/workspace-folders-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import {
  selectActiveProjectProfile,
  useProjectProfilesStore,
  type ProjectProfilesHostBucket,
} from "@/stores/workspace/project-profiles-store";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";

interface FoldersState {
  readonly byHost: Readonly<Record<string, WorkspaceFoldersHostBucket>>;
}

interface ProfilesState {
  readonly byHost: Readonly<Record<string, ProjectProfilesHostBucket>>;
}

/**
 * The folders a new chat / landing draft should launch with.
 *
 * Zero profiles, or All projects (`activeProfileId === null`), keep today's
 * host bucket. An active profile narrows that bucket to the profile's own
 * folder list so a Titanos chat cannot inherit BKZA/CRM worktrees.
 */
export function selectEffectiveWorkspaceFoldersBucket(
  foldersState: FoldersState,
  profilesState: ProfilesState,
  hostId: string | null,
): WorkspaceFoldersHostBucket {
  const catalog = selectWorkspaceFoldersBucket(foldersState, hostId);
  const profile = selectActiveProjectProfile(profilesState, hostId);
  if (profile === null) return catalog;

  const catalogSet = new Set(catalog.folders);
  const folders = profile.folderPaths.filter((path) => catalogSet.has(path));
  if (folders.length === 0) {
    return {
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    };
  }
  const folderSet = new Set(folders);
  const folderInfoByPath = Object.fromEntries(
    Object.entries(catalog.folderInfoByPath).filter(([path]) =>
      folderSet.has(path),
    ),
  );
  return {
    folders,
    folderInfoByPath,
    primaryPath: resolvePrimaryPath(folders, profile.primaryPath),
  };
}

/** Imperative launch-time read. Callers that need React updates subscribe
 *  to both stores and pass them into {@link selectEffectiveWorkspaceFoldersBucket}. */
export function readEffectiveWorkspaceSnapshot(
  hostId: string | null,
): WorkspaceFoldersHostBucket {
  return selectEffectiveWorkspaceFoldersBucket(
    useWorkspaceFoldersStore.getState(),
    useProjectProfilesStore.getState(),
    hostId,
  );
}
