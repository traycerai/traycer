import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, projectProfilesRegistryKey } from "@/lib/persist";
import type {
  NewProjectProfileInput,
  ProjectProfile,
  ProjectProfilePatch,
} from "@/lib/profiles/types";

export interface ProjectProfilesState {
  readonly profiles: ReadonlyArray<ProjectProfile>;
  readonly createProfile: (input: NewProjectProfileInput) => ProjectProfile;
  readonly updateProfile: (id: string, patch: ProjectProfilePatch) => void;
  readonly deleteProfile: (id: string) => void;
  /**
   * Assign epics to a profile: deduped, and removed from every other
   * profile (an assignment is exclusive — an epic belongs to at most one
   * project by assignment).
   */
  readonly assignEpicsToProfile: (
    id: string,
    epicIds: ReadonlyArray<string>,
  ) => void;
  /** Remove an epic from every profile's assignment list. */
  readonly unassignEpic: (epicId: string) => void;
  readonly resetForTests: () => void;
}

function assertValidProfileShape(
  name: string,
  folders: ReadonlyArray<unknown>,
): void {
  if (name.trim().length === 0 || folders.length < 1) {
    throw new Error("Project profile requires a name and at least one folder");
  }
}

function normalizePersistedProfiles(
  persisted: unknown,
): ReadonlyArray<ProjectProfile> {
  if (
    typeof persisted !== "object" ||
    persisted === null ||
    !("profiles" in persisted)
  ) {
    return [];
  }
  const profiles = (persisted as { profiles: unknown }).profiles;
  if (!Array.isArray(profiles)) return [];
  // Profiles persisted before assignedEpicIds existed rehydrate with [].
  return profiles.map((raw): ProjectProfile => {
    const profile = raw as ProjectProfile;
    return {
      ...profile,
      assignedEpicIds: Array.isArray(profile.assignedEpicIds)
        ? profile.assignedEpicIds
        : [],
    };
  });
}

export const useProjectProfilesStore = create<ProjectProfilesState>()(
  persist(
    (set, get) => ({
      profiles: [],
      createProfile: (input) => {
        const name = input.name.trim();
        assertValidProfileShape(name, input.folders);
        const now = Date.now();
        const profile: ProjectProfile = {
          id: crypto.randomUUID(),
          name,
          icon: input.icon,
          color: input.color,
          folders: input.folders,
          assignedEpicIds: [],
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          profiles: [...state.profiles, profile],
        }));
        return profile;
      },
      updateProfile: (id, patch) => {
        const current = get().profiles.find((p) => p.id === id);
        if (current === undefined) return;

        const nextName =
          patch.name !== undefined ? patch.name.trim() : current.name;
        const nextFolders =
          patch.folders !== undefined ? patch.folders : current.folders;
        assertValidProfileShape(nextName, nextFolders);

        const now = Date.now();
        set((state) => ({
          profiles: state.profiles.map((profile) => {
            if (profile.id !== id) return profile;
            return {
              ...profile,
              name: nextName,
              icon: patch.icon !== undefined ? patch.icon : profile.icon,
              color: patch.color !== undefined ? patch.color : profile.color,
              folders: nextFolders,
              updatedAt: now,
            };
          }),
        }));
      },
      deleteProfile: (id) => {
        set((state) => ({
          profiles: state.profiles.filter((profile) => profile.id !== id),
        }));
      },
      assignEpicsToProfile: (id, epicIds) => {
        const incoming = new Set(epicIds);
        if (incoming.size === 0) return;
        const now = Date.now();
        set((state) => ({
          profiles: state.profiles.map((profile) => {
            const kept = profile.assignedEpicIds.filter(
              (epicId) => !incoming.has(epicId),
            );
            if (profile.id !== id) {
              return kept.length === profile.assignedEpicIds.length
                ? profile
                : { ...profile, assignedEpicIds: kept };
            }
            const merged = [...kept];
            for (const epicId of incoming) {
              if (!merged.includes(epicId)) merged.push(epicId);
            }
            return { ...profile, assignedEpicIds: merged, updatedAt: now };
          }),
        }));
      },
      unassignEpic: (epicId) => {
        set((state) => ({
          profiles: state.profiles.map((profile) => {
            if (!profile.assignedEpicIds.includes(epicId)) return profile;
            return {
              ...profile,
              assignedEpicIds: profile.assignedEpicIds.filter(
                (assigned) => assigned !== epicId,
              ),
            };
          }),
        }));
      },
      resetForTests: () => {
        set({ profiles: [] });
      },
    }),
    {
      ...basePersistOptions(projectProfilesRegistryKey(null)),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        profiles: state.profiles,
      }),
      merge: (persisted, current) => ({
        ...current,
        profiles: normalizePersistedProfiles(persisted),
      }),
    },
  ),
);
