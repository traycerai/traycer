import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  activeProjectProfileKey,
  basePersistOptions,
} from "@/lib/persist";

export interface ActiveProjectProfileState {
  readonly activeProfileId: string | null;
  readonly setActiveProfile: (id: string | null) => void;
  readonly resetForTests: () => void;
}

export const useActiveProjectProfileStore = create<ActiveProjectProfileState>()(
  persist(
    (set) => ({
      activeProfileId: null,
      setActiveProfile: (id) => {
        set({ activeProfileId: id });
      },
      resetForTests: () => {
        set({ activeProfileId: null });
      },
    }),
    {
      ...basePersistOptions(activeProjectProfileKey(null)),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        activeProfileId: state.activeProfileId,
      }),
    },
  ),
);
