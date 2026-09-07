import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Imported tasks the user has not opened yet, keyed by epic id with the source provider as the
 * value (it feeds the dot's tooltip).
 */
interface ImportedUnseenState {
  // Sparse by nature: most epics have no entry, so indexed reads are undefined.
  readonly unseen: Readonly<Record<string, GuiHarnessId | undefined>>;
  readonly markImported: (epicId: string, harness: GuiHarnessId) => void;
  readonly markSeen: (epicId: string) => void;
}

const IMPORTED_UNSEEN_PERSIST_KEY = persistKey(STORE_KEYS.sessionImportUnseen);

export const useImportedUnseenStore = create<ImportedUnseenState>()(
  persist(
    (set, get) => ({
      unseen: {},
      markImported: (epicId, harness) => {
        set({ unseen: { ...get().unseen, [epicId]: harness } });
      },
      markSeen: (epicId) => {
        const unseen = get().unseen;
        if (!(epicId in unseen)) return;
        const next = { ...unseen };
        delete next[epicId];
        set({ unseen: next });
      },
    }),
    {
      ...basePersistOptions(IMPORTED_UNSEEN_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ unseen: state.unseen }),
    },
  ),
);
