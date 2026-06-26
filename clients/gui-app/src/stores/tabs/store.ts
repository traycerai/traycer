import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { SystemTab, TabRef } from "@/stores/tabs/types";

interface TabsStoreState {
  /**
   * Canonical tab strip order. One entry per visible tab regardless of
   * kind. Epic/draft data lives in the epic-canvas + landing-draft
   * stores; only the order + presence is owned here.
   */
  readonly stripOrder: ReadonlyArray<TabRef>;
  /** Singleton system tabs keyed by kind. `null` when not currently open. */
  readonly systemTabs: {
    readonly history: SystemTab | null;
    readonly settings: SystemTab | null;
  };

  /** Append a ref to strip order if not already present. */
  ensurePresent: (ref: TabRef) => void;
  /** Remove a ref from strip order. Idempotent. */
  dropRef: (ref: TabRef) => void;
  /** Replace strip order (used by reconciliation when a kind's source store changes). */
  setStripOrder: (refs: ReadonlyArray<TabRef>) => void;
  /** Move a ref to a target insertion index, browser-style. */
  moveRef: (ref: TabRef, targetIndex: number) => void;

  /**
   * Open a system tab. Singleton: if already open, just updates lastPath.
   * Always appends to strip order if newly opened.
   */
  openSystemTab: (input: {
    readonly kind: "history" | "settings";
    readonly name: string;
    readonly lastPath: string | null;
  }) => void;
  /** Update the remembered sub-route on an open system tab. No-op if not open. */
  rememberSystemTabPath: (
    kind: "history" | "settings",
    path: string | null,
  ) => void;
  /** Close a system tab - clears the singleton + drops from strip order. */
  closeSystemTab: (kind: "history" | "settings") => void;
}
const TABS_PERSIST_KEY = persistKey(STORE_KEYS.tabs);

function refsEqual(a: TabRef, b: TabRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function indexOfRef(list: ReadonlyArray<TabRef>, ref: TabRef): number {
  return list.findIndex((entry) => refsEqual(entry, ref));
}

function moveRefInList(
  list: ReadonlyArray<TabRef>,
  ref: TabRef,
  targetIndex: number,
): ReadonlyArray<TabRef> {
  const fromIndex = indexOfRef(list, ref);
  if (fromIndex === -1) return list;
  const clamped = Math.max(0, Math.min(targetIndex, list.length));
  const insertIndex = fromIndex < clamped ? clamped - 1 : clamped;
  if (fromIndex === insertIndex) return list;
  const without = [...list.slice(0, fromIndex), ...list.slice(fromIndex + 1)];
  return [
    ...without.slice(0, insertIndex),
    list[fromIndex],
    ...without.slice(insertIndex),
  ];
}

export const useTabsStore = create<TabsStoreState>()(
  persist(
    (set) => ({
      stripOrder: [],
      systemTabs: { history: null, settings: null },

      ensurePresent: (ref) => {
        set((state) => {
          if (indexOfRef(state.stripOrder, ref) !== -1) return state;
          return { stripOrder: [...state.stripOrder, ref] };
        });
      },

      dropRef: (ref) => {
        set((state) => {
          const idx = indexOfRef(state.stripOrder, ref);
          if (idx === -1) return state;
          return {
            stripOrder: state.stripOrder.filter(
              (entry) => !refsEqual(entry, ref),
            ),
          };
        });
      },

      setStripOrder: (refs) => {
        set((state) =>
          state.stripOrder === refs ? state : { stripOrder: refs },
        );
      },

      moveRef: (ref, targetIndex) => {
        set((state) => {
          const next = moveRefInList(state.stripOrder, ref, targetIndex);
          return next === state.stripOrder ? state : { stripOrder: next };
        });
      },

      openSystemTab: ({ kind, name, lastPath }) => {
        set((state) => {
          const existing = state.systemTabs[kind];
          const resolvedLastPath = lastPath ?? existing?.lastPath ?? null;
          const ref: TabRef = { kind, id: kind };
          const alreadyInStrip = indexOfRef(state.stripOrder, ref) !== -1;
          // Skip the set + persist write when the singleton tab is
          // already open with identical name and remembered path.
          // Without this, every navigation inside the tab’s sub-routes
          // (e.g. `/settings/general` → `/settings/providers`) would fire
          // a no-op rewrite because callers route through here on each
          // pathname change.
          if (
            existing !== null &&
            existing.name === name &&
            existing.lastPath === resolvedLastPath &&
            alreadyInStrip
          ) {
            return state;
          }
          const next: SystemTab = {
            id: kind,
            kind,
            name,
            lastPath: resolvedLastPath,
          };
          const stripOrder = alreadyInStrip
            ? state.stripOrder
            : [...state.stripOrder, ref];
          return {
            systemTabs: { ...state.systemTabs, [kind]: next },
            stripOrder,
          };
        });
      },

      rememberSystemTabPath: (kind, path) => {
        set((state) => {
          const existing = state.systemTabs[kind];
          if (existing === null) return state;
          if (existing.lastPath === path) return state;
          return {
            systemTabs: {
              ...state.systemTabs,
              [kind]: { ...existing, lastPath: path },
            },
          };
        });
      },

      closeSystemTab: (kind) => {
        set((state) => {
          const ref: TabRef = { kind, id: kind };
          const idx = indexOfRef(state.stripOrder, ref);
          const stripOrder =
            idx === -1
              ? state.stripOrder
              : state.stripOrder.filter((entry) => !refsEqual(entry, ref));
          if (
            state.systemTabs[kind] === null &&
            stripOrder === state.stripOrder
          )
            return state;
          return {
            systemTabs: { ...state.systemTabs, [kind]: null },
            stripOrder,
          };
        });
      },
    }),
    {
      ...basePersistOptions(TABS_PERSIST_KEY),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        stripOrder: state.stripOrder,
        systemTabs: state.systemTabs,
      }),
    },
  ),
);

// Reconciliation install lives in `WindowsBridgeProvider` so the
// hydration gate's ready-promise can be set up before subscriptions
// fire (see `stores/tabs/reconcile.ts`). Tests that exercise
// reconciliation must call `installTabsStoreReconciliation()`
// themselves in their setup.
