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
  if (folder.hostId !== null && folder.hostId !== workspace.hostId)
    return false;
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
 * Full ownership: folder match OR manual assignment. Landing, auto-switch,
 * and tab-swap release all treat an assigned epic as owned by its profile.
 */
export function profileOwnsEpic(
  profile: ProjectProfile,
  epicId: string,
  workspaces: ReadonlyArray<MembershipWorkspaceRef>,
): boolean {
  if (profile.assignedEpicIds.includes(epicId)) return true;
  return profileOwnsWorkspaceRefs(profile, workspaces);
}

/**
 * Visibility rule for lists. Assignment is exclusive and wins: assigned to
 * this profile → visible; assigned to another → hidden. Unassigned +
 * unscoped (no linked workspaces) → visible in every profile (fail-open —
 * never hide user data). Unassigned + scoped → folder match.
 */
export function itemVisibleInProfile(
  profile: ProjectProfile,
  workspaces: ReadonlyArray<MembershipWorkspaceRef>,
  epicId: string,
  allProfiles: ReadonlyArray<ProjectProfile>,
): boolean {
  if (profile.assignedEpicIds.includes(epicId)) return true;
  const assignedElsewhere = allProfiles.some(
    (other) =>
      other.id !== profile.id && other.assignedEpicIds.includes(epicId),
  );
  if (assignedElsewhere) return false;
  if (workspaces.length === 0) return true;
  return profileOwnsWorkspaceRefs(profile, workspaces);
}
