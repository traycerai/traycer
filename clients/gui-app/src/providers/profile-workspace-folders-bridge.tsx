import { useEffect, useRef, type ReactNode } from "react";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  profileFoldersForHost,
  profileHasUsableFolders,
} from "@/lib/profiles/profile-workspace-folders";
import type { ProjectProfileFolder } from "@/lib/profiles/types";
import { useActiveProjectProfile } from "@/lib/profiles/use-active-project-profile";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import {
  useWorkspaceFoldersStore,
  type WorkspaceFolderInfo,
} from "@/stores/workspace/workspace-folders-store";

/**
 * On profile switch, replace the composer workspace folders with the
 * active profile's folders usable on the current host.
 *
 * No-ops when the active profile is null ("All projects") or has no
 * usable folders — keep last-used so the aggregate surface stays neutral.
 *
 * Does NOT re-apply while profile id + host stay the same: the user may
 * hand-edit folders within a profile session; the store is their surface
 * between switches.
 *
 * Profile folders only store `{ path, hostId }`. We project them into
 * WorkspaceFolderInfo with name from the path and `repoIdentifier: null`
 * (local-only until the user re-prepares). Full prepareFolders round-trip
 * is deferred — enough for the composer to inherit the right paths.
 */
export function ProfileWorkspaceFoldersBridge(): ReactNode {
  const activeProfile = useActiveProjectProfile();
  const activeHostId = useReactiveActiveHostId();
  const replaceResolvedFolders = useWorkspaceFoldersStore(
    (s) => s.replaceResolvedFolders,
  );

  // Key of the last successful apply. Prevents re-applying on re-renders
  // while the user edits folders within the same profile session.
  const lastAppliedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeProfile === null) {
      // Leaving a profile does not clear the composer — All projects is neutral.
      return;
    }
    if (!profileHasUsableFolders(activeProfile, activeHostId)) {
      return;
    }

    const applyKey = `${activeProfile.id}::${activeHostId ?? ""}`;
    if (lastAppliedKeyRef.current === applyKey) {
      return;
    }

    const usable = profileFoldersForHost(activeProfile, activeHostId);
    const infos = profileFoldersToWorkspaceFolderInfos(usable);
    replaceResolvedFolders(infos);
    lastAppliedKeyRef.current = applyKey;
  }, [activeProfile, activeHostId, replaceResolvedFolders]);

  return null;
}

/**
 * Pure projection of profile folder rows into composer WorkspaceFolderInfo.
 * Exported for tests.
 */
export function profileFoldersToWorkspaceFolderInfos(
  folders: ReadonlyArray<ProjectProfileFolder>,
): ReadonlyArray<WorkspaceFolderInfo> {
  return folders.map((folder) => ({
    path: folder.path,
    name: workspaceFolderName(folder.path),
    repoIdentifier: null,
    hostId: folder.hostId,
  }));
}
