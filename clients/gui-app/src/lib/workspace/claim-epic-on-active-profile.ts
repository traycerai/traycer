import {
  selectActiveProjectProfile,
  useProjectProfilesStore,
} from "@/stores/workspace/project-profiles-store";

/**
 * Bind a newly minted epic to the active Project Profile so History keeps
 * it even when the chat ran local (no worktree under ~/.traycer/worktrees).
 */
export function claimEpicOnActiveProfile(
  hostId: string | null,
  epicId: string,
): void {
  if (hostId === null || epicId.length === 0) return;
  const store = useProjectProfilesStore.getState();
  const active = selectActiveProjectProfile(store, hostId);
  if (active === null) return;
  store.addProfileEpics(hostId, active.id, [epicId]);
}
