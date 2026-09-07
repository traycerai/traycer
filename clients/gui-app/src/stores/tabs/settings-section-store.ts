import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { SettingsSectionId } from "@/lib/settings-sections";

/** Active section of the Settings *modal* overlay. */
interface SettingsSectionStoreState {
  readonly section: SettingsSectionId | null;
  readonly setSection: (section: SettingsSectionId | null) => void;
}

const SETTINGS_SECTION_PERSIST_KEY = persistKey(STORE_KEYS.settingsSection);

export const useSettingsSectionStore = create<SettingsSectionStoreState>()(
  persist(
    (set, get) => ({
      section: null,
      setSection: (section) => {
        if (get().section === section) return;
        set({ section });
      },
    }),
    {
      ...basePersistOptions(SETTINGS_SECTION_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ section: state.section }),
    },
  ),
);
