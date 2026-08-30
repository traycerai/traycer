import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Imported tasks the user has not opened yet, keyed by epic id with the source
 * provider as the value (it feeds the dot's tooltip).
 *
 * This is the task list's unread dot for imports: deliberately app-local
 * client state rather than notifications - fifty feed entries per import run
 * would be spam in the bell, and the notifications domain's dual-plane
 * machinery is far too heavy for a one-time "you haven't looked at this yet"
 * hint. The trade is that the dot shows only on the machine that ran the
 * import, which is the machine the user imported on.
 *
 * Persisted so a restart between importing and looking does not erase the
 * hint; entries clear the first time the task is opened (the epic surface
 * mounting is the one funnel every open path goes through).
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
