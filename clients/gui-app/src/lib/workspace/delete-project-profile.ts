import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useProjectNotesStore } from "@/stores/workspace/project-notes-store";
import { useProjectProfilesStore } from "@/stores/workspace/project-profiles-store";

export function deleteActiveProjectProfile(
  hostId: string | null,
  profileId: string,
): void {
  if (hostId === null) return;
  useProjectProfilesStore.getState().deleteProfile(hostId, profileId);
  useProjectNotesStore
    .getState()
    .reassignProjectNotesToGeneral(hostId, profileId);
  useLandingDraftStore.getState().replaceActiveDraftWorkspaceFromStores();
}
