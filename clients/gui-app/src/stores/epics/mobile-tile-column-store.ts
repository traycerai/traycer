import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  basePersistOptions,
  installCrossWindowRehydrate,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist";

/**
 * Whether the person folded the phone shell's level-2 task column into the
 * menu under the tile's name. The width rule still decides where a column
 * FITS (`mobile-layout-form.ts`); this is the choice on top of it, as the
 * strip's `collapsed` is on top of where the expanded strip fits. Global
 * across windows and tasks, and persisted outside the layout arrangement.
 */
export interface MobileTileColumnState {
  readonly collapsed: boolean;
  readonly setCollapsed: (collapsed: boolean) => void;
}

const MOBILE_TILE_COLUMN_PERSIST_KEY = persistKey(STORE_KEYS.mobileTileColumn);

function persistedCollapsed(persistedState: unknown): boolean {
  if (persistedState === null || typeof persistedState !== "object") {
    return false;
  }
  return Reflect.get(persistedState, "collapsed") === true;
}

export const useMobileTileColumnStore = create<MobileTileColumnState>()(
  persist(
    (set) => ({
      collapsed: false,
      setCollapsed: (collapsed) => {
        set({ collapsed });
      },
    }),
    {
      ...basePersistOptions(MOBILE_TILE_COLUMN_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ collapsed: state.collapsed }),
      // A record from another build, or hand-edited storage, cannot put a
      // non-boolean flag in the store.
      merge: (persistedState, currentState) => ({
        ...currentState,
        collapsed: persistedCollapsed(persistedState),
      }),
    },
  ),
);

/** Another window's fold or unfold reaches this one live. */
installCrossWindowRehydrate(
  useMobileTileColumnStore,
  MOBILE_TILE_COLUMN_PERSIST_KEY,
);

export function useMobileTileColumnCollapsed(): boolean {
  return useMobileTileColumnStore((state) => state.collapsed);
}
