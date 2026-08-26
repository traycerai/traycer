import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import type { EpicWorkspaceHint } from "@/lib/workspace/header-tab-matches-project";
import { claimedProfileIdForEpic } from "@/lib/workspace/history-item-matches-project";
import { resolveOwningProjectProfile } from "@/lib/workspace/header-tab-matches-project";
import {
  PROJECT_PROFILE_COLORS,
  selectProjectProfilesBucket,
  useProjectProfilesStore,
  type ProjectProfile,
  type ProjectProfileColor,
} from "@/stores/workspace/project-profiles-store";

function hintPrimaryFolder(hint: EpicWorkspaceHint | null): string | null {
  if (hint === null) return null;
  if (typeof hint.primaryPath === "string" && hint.primaryPath.length > 0) {
    return hint.primaryPath;
  }
  const linked = hint.linkedWorkspaces[0]?.workspacePath;
  if (linked !== undefined && linked.length > 0) return linked;
  const worktree = hint.worktreePaths[0];
  if (worktree !== undefined && worktree.length > 0) return worktree;
  return null;
}

function nextUnusedColor(
  profiles: ReadonlyArray<ProjectProfile>,
): ProjectProfileColor {
  const used = new Set(profiles.map((profile) => profile.color));
  return (
    PROJECT_PROFILE_COLORS.find((color) => !used.has(color)) ?? "orange"
  );
}

export function folderAlreadyOwnsAProject(
  profiles: ReadonlyArray<ProjectProfile>,
  folderPath: string,
): boolean {
  return profiles.some(
    (profile) =>
      profile.primaryPath === folderPath ||
      profile.folderPaths.includes(folderPath),
  );
}

/**
 * Bind an unclaimed epic to the one project whose folders contain every
 * workspace path. No-op in All projects when the chat touched more than one
 * project (fan-out) — the user must Move it. Never steals an explicit claim.
 */
export function claimEpicOnMatchingProfile(
  hostId: string | null,
  epicId: string,
  hint: EpicWorkspaceHint | null,
): void {
  if (hostId === null || epicId.length === 0) return;
  const store = useProjectProfilesStore.getState();
  const bucket = selectProjectProfilesBucket(store, hostId);
  if (claimedProfileIdForEpic(bucket.profiles, epicId) !== null) return;
  const owner = resolveOwningProjectProfile(bucket.profiles, epicId, hint);
  if (owner === null) return;
  store.addProfileEpics(hostId, owner.id, [epicId]);
}

/** Exclusive move. `profileId` null removes the epic from every project. */
export function assignEpicToProjectProfile(
  hostId: string | null,
  epicId: string,
  profileId: string | null,
): void {
  if (hostId === null || epicId.length === 0) return;
  const store = useProjectProfilesStore.getState();
  const bucket = selectProjectProfilesBucket(store, hostId);
  for (const profile of bucket.profiles) {
    if (profileId !== null && profile.id === profileId) {
      store.addProfileEpics(hostId, profile.id, [epicId]);
    } else {
      store.removeProfileEpic(hostId, profile.id, epicId);
    }
  }
}

/**
 * Create a project from this chat's folder and claim the epic. Does not switch
 * the header — All projects stays so the color dot can appear.
 */
export function createProjectFromWorkspaceHint(
  hostId: string | null,
  epicId: string,
  hint: EpicWorkspaceHint | null,
): string | null {
  if (hostId === null || epicId.length === 0) return null;
  const folderPath = hintPrimaryFolder(hint);
  if (folderPath === null) return null;
  const store = useProjectProfilesStore.getState();
  const bucket = selectProjectProfilesBucket(store, hostId);
  if (folderAlreadyOwnsAProject(bucket.profiles, folderPath)) return null;
  const name = workspaceFolderName(folderPath);
  if (name.length === 0) return null;
  const id = store.createProfile(hostId, {
    name,
    color: nextUnusedColor(bucket.profiles),
    folderPaths: [folderPath],
    primaryPath: folderPath,
  });
  if (id === null) return null;
  assignEpicToProjectProfile(hostId, epicId, id);
  return id;
}
