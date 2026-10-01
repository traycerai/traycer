import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Imported tasks the user has not opened yet, keyed by epic id with the source
 * provider as the value (it feeds the dot's tooltip), or `null` when the task
 * holds imported work from MORE THAN ONE provider.
 *
 * The neutral value stopped being an edge case when import moved to one task
 * per repository: a person who ran both Claude and Codex in the same checkout
 * now gets one task holding both, and last-write-wins on the harness would put
 * "Imported from Codex" on a task that is half Claude's. `null` is the honest
 * answer there, and the dot says so without naming a provider.
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
  /**
   * Sparse by nature: most epics have no entry, so indexed reads are
   * `undefined`. The three states are distinct and all three are read:
   * `undefined` = no unseen import, `null` = several providers, a harness id =
   * that one.
   *
   * `null` was added WITHOUT a persist-version bump, and that has one known
   * cost. A build older than this one reads the value as a harness id, and
   * its dot passes it to `harnessDisplayName`, which falls through to its
   * argument: after a DOWNGRADE, a multi-provider task's dot reads "Imported
   * from null - not opened yet" until the task is opened. The current build
   * cannot produce that, because `ImportedUnseenDot` handles `null` before
   * any name lookup. A bump was the worse trade: `basePersistOptions` has no
   * `migrate`, so an older build would discard the whole store and erase
   * every legitimate dot. Weigh this before the next version change here.
   */
  readonly unseen: Readonly<Record<string, GuiHarnessId | null | undefined>>;
  readonly markImported: (epicId: string, harness: GuiHarnessId) => void;
  readonly markSeen: (epicId: string) => void;
}

const IMPORTED_UNSEEN_PERSIST_KEY = persistKey(STORE_KEYS.sessionImportUnseen);

export const useImportedUnseenStore = create<ImportedUnseenState>()(
  persist(
    (set, get) => ({
      unseen: {},
      markImported: (epicId, harness) => {
        const unseen = get().unseen;
        const existing = unseen[epicId];
        // Already neutral stays neutral, and a second provider landing on a
        // task the first one marked goes neutral: the dot names a provider only
        // while that is the whole truth about the task.
        const next =
          existing === undefined || existing === harness ? harness : null;
        set({ unseen: { ...unseen, [epicId]: next } });
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
