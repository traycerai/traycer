import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  basePersistOptions,
  projectProfilesRegistryKey,
} from "@/lib/persist";
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
  readonly resetForTests: () => void;
}

function assertValidProfileShape(
  name: string,
  folders: ReadonlyArray<unknown>,
): void {
  if (name.trim().length === 0 || folders.length < 1) {
    throw new Error(
      "Project profile requires a name and at least one folder",
    );
  }
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

        const nextName = patch.name !== undefined ? patch.name.trim() : current.name;
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
    },
  ),
);
