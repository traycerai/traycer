import {
  selectActiveProjectProfile,
  useProjectProfilesStore,
} from "@/stores/workspace/project-profiles-store";

/**
 * When a Project Profile is active, picker edits belong to THAT project.
 * The host catalog stays a library: add writes metadata there, remove/primary
 * stay on the profile so All projects and sibling profiles are not rewritten.
 */
export function syncActiveProfileFolders(args: {
  readonly hostId: string | null;
  readonly addPaths: ReadonlyArray<string>;
  readonly removePath: string | null;
  readonly primaryPath: string | null;
}): void {
  if (args.hostId === null) return;
  const store = useProjectProfilesStore.getState();
  const profile = selectActiveProjectProfile(store, args.hostId);
  if (profile === null) return;
  for (const path of args.addPaths) {
    store.addProfileFolder(args.hostId, profile.id, path);
  }
  if (args.removePath !== null) {
    store.removeProfileFolder(args.hostId, profile.id, args.removePath);
  }
  if (args.primaryPath !== null) {
    store.setProfilePrimary(args.hostId, profile.id, args.primaryPath);
  }
}

export function activeProfileOwnsPickerEdits(hostId: string | null): boolean {
  if (hostId === null) return false;
  return (
    selectActiveProjectProfile(useProjectProfilesStore.getState(), hostId) !==
    null
  );
}
