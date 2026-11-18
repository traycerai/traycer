/**
 * Zustand store for the command palette. `open` + `query` are
 * session-only; `recentIds` + `pinnedIds` persist. Scope is derived
 * live from the leading prefix character of `query` - see
 * `src/lib/commands/scopes.ts` - and therefore does not live in
 * the store.
 *
 * Schema breaks bump the persist `version` (no `migrate`), which makes
 * zustand discard the old blob and reboot from initial state.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

const RECENTS_LIMIT = 8;
const PINNED_LIMIT = 5;
const COMMAND_PALETTE_PERSIST_KEY = persistKey(STORE_KEYS.commandPalette);

export interface CommandPaletteState {
  readonly open: boolean;
  readonly query: string;
  readonly recentIds: ReadonlyArray<string>;
  readonly pinnedIds: ReadonlyArray<string>;
  readonly setOpen: (open: boolean) => void;
  readonly setQuery: (query: string) => void;
  readonly recordUse: (id: string) => void;
  readonly togglePin: (id: string) => boolean;
  readonly clearRecents: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>()(
  persist(
    (set, get) => ({
      open: false,
      query: "",
      recentIds: [],
      pinnedIds: [],

      setOpen: (open) => {
        set((state) => {
          if (state.open === open) return state;
          if (open) return { open: true, query: "" };
          return { open: false };
        });
      },

      setQuery: (query) => {
        set((state) => (state.query === query ? state : { query }));
      },

      recordUse: (id) => {
        set((state) => {
          const without = state.recentIds.filter((existing) => existing !== id);
          const next = [id, ...without].slice(0, RECENTS_LIMIT);
          return { recentIds: next };
        });
      },

      togglePin: (id) => {
        const { pinnedIds } = get();
        const isPinned = pinnedIds.includes(id);
        if (isPinned) {
          set({ pinnedIds: pinnedIds.filter((existing) => existing !== id) });
          return true;
        }
        if (pinnedIds.length >= PINNED_LIMIT) {
          return false;
        }
        set({ pinnedIds: [...pinnedIds, id] });
        return true;
      },

      clearRecents: () => {
        set((state) =>
          state.recentIds.length === 0 ? state : { recentIds: [] },
        );
      },
    }),
    {
      ...basePersistOptions(COMMAND_PALETTE_PERSIST_KEY),
      partialize: (state) => ({
        recentIds: state.recentIds,
        pinnedIds: state.pinnedIds,
      }),
    },
  ),
);

export const COMMAND_PALETTE_LIMITS = {
  recents: RECENTS_LIMIT,
  pinned: PINNED_LIMIT,
} as const;
