import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Whether the composer has said what the Terminal account is, on this
 * desktop. The sentence goes with the first time the composer names it, and
 * once is enough.
 */
interface TerminalAccountMentionStore {
  readonly explained: boolean;
  readonly markExplained: () => void;
}

export const useTerminalAccountMentionStore =
  create<TerminalAccountMentionStore>()(
    persist(
      (set) => ({
        explained: false,
        markExplained: () => {
          set({ explained: true });
        },
      }),
      {
        ...basePersistOptions(persistKey(STORE_KEYS.terminalAccountMention)),
        partialize: (state) => ({ explained: state.explained }),
      },
    ),
  );
