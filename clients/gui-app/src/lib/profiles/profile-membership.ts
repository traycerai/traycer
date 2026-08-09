import type { ProjectProfile, ProjectProfileFolder } from "./types";

/** Workspace-ref shape this module needs (structural — matches TaskWorkspaceIdentifier). */
export interface MembershipWorkspaceRef {
  readonly hostId: string;
  readonly workspacePath: string;
}

export function isPathUnderFolder(path: string, folderPath: string): boolean {
  if (path === folderPath) return true;
  const prefix = folderPath.endsWith("/") ? folderPath : folderPath + "/";
  return path.startsWith(prefix);
}

export function folderMatchesWorkspace(
  folder: ProjectProfileFolder,
  workspace: MembershipWorkspaceRef,
): boolean {
  if (folder.hostId !== null && folder.hostId !== workspace.hostId) return false;
  return isPathUnderFolder(workspace.workspacePath, folder.path);
}

/** D1: any linked workspace under any profile folder. */
export function profileOwnsWorkspaceRefs(
  profile: ProjectProfile,
  workspaces: ReadonlyArray<MembershipWorkspaceRef>,
): boolean {
  return workspaces.some((ws) =>
    profile.folders.some((folder) => folderMatchesWorkspace(folder, ws)),
  );
}

/**
 * Visibility rule for lists: unscoped items (no linked workspaces) are visible
 * in every profile (fail-open); scoped items must be owned by the profile.
 */
export function itemVisibleInProfile(
  profile: ProjectProfile,
  workspaces: ReadonlyArray<MembershipWorkspaceRef>,
): boolean {
  if (workspaces.length === 0) return true;
  return profileOwnsWorkspaceRefs(profile, workspaces);
}
