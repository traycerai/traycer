import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  SIDE_STRIP_DEFAULT_WIDTH_PX,
  SIDE_STRIP_MAX_WIDTH_PX,
  SIDE_STRIP_MIN_WIDTH_PX,
} from "@/components/layout/tabs/side-strip/side-strip-tokens";
import {
  basePersistOptions,
  installCrossWindowRehydrate,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist";

/**
 * The vertical tab strip's width and collapsed state. Global across windows
 * and persisted outside the layout arrangement: resizing the strip is not a
 * layout change, so it takes no part in presets or undo.
 */
export interface SideTabStripState {
  readonly widthPx: number;
  readonly collapsed: boolean;
  /** Clamped to the strip's minimum and maximum. */
  readonly setWidthPx: (widthPx: number) => void;
  readonly setCollapsed: (collapsed: boolean) => void;
  /** Back to the default width. */
  readonly resetWidth: () => void;
  /**
   * A handle drag's live layout (F9): the collapsed state the strip draws
   * while a drag holds it on the other side of the snap point from
   * `collapsed`, else `null`. Transient: never persisted, so the release is
   * still the one write that stores the drag.
   */
  readonly dragCollapsed: boolean | null;
  readonly setDragCollapsed: (dragCollapsed: boolean | null) => void;
}

const SIDE_TAB_STRIP_PERSIST_KEY = persistKey(STORE_KEYS.sideTabStrip);

/** A width inside the strip's range; anything that is not a finite number is the default. */
export function clampSideStripWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return SIDE_STRIP_DEFAULT_WIDTH_PX;
  return Math.min(
    SIDE_STRIP_MAX_WIDTH_PX,
    Math.max(SIDE_STRIP_MIN_WIDTH_PX, widthPx),
  );
}

function persistedField(persistedState: unknown, field: string): unknown {
  if (persistedState === null || typeof persistedState !== "object") {
    return undefined;
  }
  return Reflect.get(persistedState, field);
}

export const useSideTabStripStore = create<SideTabStripState>()(
  persist(
    (set) => ({
      widthPx: SIDE_STRIP_DEFAULT_WIDTH_PX,
      collapsed: false,
      setWidthPx: (widthPx) => {
        set({ widthPx: clampSideStripWidth(widthPx) });
      },
      setCollapsed: (collapsed) => {
        set({ collapsed });
      },
      resetWidth: () => {
        set({ widthPx: SIDE_STRIP_DEFAULT_WIDTH_PX });
      },
      dragCollapsed: null,
      setDragCollapsed: (dragCollapsed) => {
        set({ dragCollapsed });
      },
    }),
    {
      ...basePersistOptions(SIDE_TAB_STRIP_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        widthPx: state.widthPx,
        collapsed: state.collapsed,
      }),
      // Field by field: a record from another build, or hand-edited storage,
      // cannot put an out-of-range width or a non-boolean flag in the store.
      merge: (persistedState, currentState) => {
        const widthPx = persistedField(persistedState, "widthPx");
        const collapsed = persistedField(persistedState, "collapsed");
        return {
          ...currentState,
          widthPx:
            typeof widthPx === "number"
              ? clampSideStripWidth(widthPx)
              : SIDE_STRIP_DEFAULT_WIDTH_PX,
          collapsed: collapsed === true,
        };
      },
    },
  ),
);

/** Another window's resize or collapse reaches this one live. */
installCrossWindowRehydrate(useSideTabStripStore, SIDE_TAB_STRIP_PERSIST_KEY);

/**
 * Whether the strip is drawn collapsed: a live handle drag's layout, else the
 * stored flag. Everything that draws the strip reads this, so its parts switch
 * together at the crossing.
 */
export function useSideStripCollapsed(): boolean {
  return useSideTabStripStore(
    (state) => state.dragCollapsed ?? state.collapsed,
  );
}
