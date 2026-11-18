import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { SettingsSectionId } from "@/lib/settings-sections";

/**
 * Active section of the Settings *modal* overlay.
 *
 * This used to live in the `__root` route's search params (`overlaySection`),
 * but the modal is a root-level sibling of the page content, so every section
 * change re-rendered `RootComponent` and cascaded the whole shell - including
 * the occluded home surface behind the dialog. Owning it here keeps section
 * navigation scoped to the modal, while `persist` preserves "restore where I
 * left off" across a refresh. The `settingsOverlay` open flag stays in the URL
 * (deep-linkable "settings is open"); the strip-tab Settings view is unaffected
 * - it keys off its `/settings/:section` route path, not this store.
 *
 * Accepted trade-off: modal settings sections are no longer URL-addressable.
 * A deep link or refresh cannot target a specific section anymore - it
 * restores the persisted "last visited" section instead (falling back to
 * General). We accept losing section deep links in exchange for keeping
 * section navigation out of the root route's render path.
 *
 * `null` means "no explicit section" -> the modal content falls back to General.
 */
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
