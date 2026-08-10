import type { ProjectProfile, ProjectProfileFolder } from "./types";

/**
 * Folders of the profile usable on the active host: keep a folder when
 * `folder.hostId === null` (legacy/unknown — match any host) or
 * `folder.hostId === activeHostId`. Stable order (profile.folders order).
 */
export function profileFoldersForHost(
  profile: ProjectProfile,
  activeHostId: string | null,
): ReadonlyArray<ProjectProfileFolder> {
  return profile.folders.filter(
    (folder) => folder.hostId === null || folder.hostId === activeHostId,
  );
}

/** True when at least one profile folder is usable on the active host. */
export function profileHasUsableFolders(
  profile: ProjectProfile,
  activeHostId: string | null,
): boolean {
  return profileFoldersForHost(profile, activeHostId).length > 0;
}
