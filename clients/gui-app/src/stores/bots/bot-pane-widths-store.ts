import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  basePersistOptions,
  installCrossWindowRehydrate,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist";

/** A pane of a bot tab whose width the person sets by dragging its inner edge. */
export type BotPane = "sidebar" | "thread";

export interface BotPaneBounds {
  readonly defaultPx: number;
  readonly minPx: number;
  readonly maxPx: number;
}

/**
 * Each pane's range. The defaults are the widths the panes had before they
 * could be resized: the channel sidebar's 16rem cap, the thread panel's
 * 36rem.
 */
export const BOT_PANE_BOUNDS: Readonly<Record<BotPane, BotPaneBounds>> = {
  sidebar: { defaultPx: 256, minPx: 180, maxPx: 420 },
  thread: { defaultPx: 576, minPx: 320, maxPx: 900 },
};

/** A width inside the pane's range; anything that is not a finite number is the default. */
export function clampBotPaneWidth(pane: BotPane, widthPx: number): number {
  const bounds = BOT_PANE_BOUNDS[pane];
  if (!Number.isFinite(widthPx)) return bounds.defaultPx;
  return Math.min(bounds.maxPx, Math.max(bounds.minPx, Math.round(widthPx)));
}

/**
 * The bot tab's channel sidebar and thread panel widths (decision 80). One
 * pair per device, shared by every bot tab and window: resizing a pane is
 * not a layout change, so it takes no part in presets, as the side strip's
 * width does not.
 */
export interface BotPaneWidthsState {
  readonly widthPx: Readonly<Record<BotPane, number>>;
  /** Clamped to the pane's range. */
  readonly setWidthPx: (pane: BotPane, widthPx: number) => void;
  /** Back to the pane's default width. */
  readonly resetWidth: (pane: BotPane) => void;
}

const BOT_PANE_WIDTHS_PERSIST_KEY = persistKey(STORE_KEYS.botPaneWidths);

const DEFAULT_WIDTHS: Readonly<Record<BotPane, number>> = {
  sidebar: BOT_PANE_BOUNDS.sidebar.defaultPx,
  thread: BOT_PANE_BOUNDS.thread.defaultPx,
};

function persistedWidth(persistedState: unknown, pane: BotPane): number {
  if (persistedState === null || typeof persistedState !== "object") {
    return BOT_PANE_BOUNDS[pane].defaultPx;
  }
  const widths: unknown = Reflect.get(persistedState, "widthPx");
  if (widths === null || typeof widths !== "object") {
    return BOT_PANE_BOUNDS[pane].defaultPx;
  }
  const width: unknown = Reflect.get(widths, pane);
  return typeof width === "number"
    ? clampBotPaneWidth(pane, width)
    : BOT_PANE_BOUNDS[pane].defaultPx;
}

export const useBotPaneWidthsStore = create<BotPaneWidthsState>()(
  persist(
    (set) => ({
      widthPx: DEFAULT_WIDTHS,
      setWidthPx: (pane, widthPx) => {
        set((state) => {
          const next = clampBotPaneWidth(pane, widthPx);
          if (state.widthPx[pane] === next) return state;
          return { widthPx: { ...state.widthPx, [pane]: next } };
        });
      },
      resetWidth: (pane) => {
        set((state) => ({
          widthPx: {
            ...state.widthPx,
            [pane]: BOT_PANE_BOUNDS[pane].defaultPx,
          },
        }));
      },
    }),
    {
      ...basePersistOptions(BOT_PANE_WIDTHS_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ widthPx: state.widthPx }),
      // Pane by pane: a record from another build, or hand-edited storage,
      // cannot put an out-of-range width in the store.
      merge: (persistedState, currentState) => ({
        ...currentState,
        widthPx: {
          sidebar: persistedWidth(persistedState, "sidebar"),
          thread: persistedWidth(persistedState, "thread"),
        },
      }),
    },
  ),
);

/** Another window's resize reaches this one live. */
installCrossWindowRehydrate(useBotPaneWidthsStore, BOT_PANE_WIDTHS_PERSIST_KEY);
