import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import {
  isRegisteredTabKind,
  tabSurfaceDescriptor,
} from "@/stores/tabs/registry";
import {
  createEmptySplit,
  DEFAULT_LEFT_RATIO,
  createLayoutItem,
  emptySystemTabs,
  emptyTabStripLayout,
  findStripItemForRef,
  flattenLayoutRefs,
  focusLayoutRef,
  focusSplitSide,
  pairLayoutRefs,
  removeLayoutRef,
  repairLayout,
  reorderStripItem,
  replaceFillableSide,
  replaceLayoutRef,
  resizeSplit,
  separateSplit,
  swapSplitSides,
  tabRefKey,
  type CreateEmptySplitArgs,
  type PairLayoutArgs,
  type PersistedTabStripLayout,
  type ReorderItemArgs,
  type ReplaceFillableSideArgs,
  type ReplaceRefArgs,
  type ResizeSplitArgs,
  type SplitSide,
  type SplitSideArgs,
  type StripItem,
  type SystemTabs,
} from "@/stores/tabs/layout";
import type { SystemTab, TabRef } from "@/stores/tabs/types";

export type PersistedTabsStoreState = PersistedTabStripLayout;

interface CommittedTabsLayout extends PersistedTabsStoreState {
  readonly stripOrder: ReadonlyArray<TabRef>;
}

export interface TabsStoreState extends PersistedTabsStoreState {
  /**
   * Flat compatibility projection for existing header consumers. It is derived
   * from `items`; no reducer treats it as grouping or selection authority.
   */
  readonly stripOrder: ReadonlyArray<TabRef>;
  /**
   * Coordinator-only layout application. The transaction finalizer performs
   * the one repair + flat compatibility projection after all source changes
   * have settled, so this intentionally leaves `stripOrder` untouched.
   */
  replaceLayoutForTransaction: (layout: PersistedTabStripLayout) => void;
  /** Complete a coordinator transaction with one repair and flat projection. */
  finalizeTransactionLayout: () => void;
  ensurePresent: (ref: TabRef) => void;
  dropRef: (ref: TabRef) => void;
  setStripOrder: (refs: ReadonlyArray<TabRef>) => void;
  moveRef: (ref: TabRef, targetIndex: number) => void;
  openSystemTab: (input: {
    readonly kind: "history" | "settings";
    readonly name: string;
    readonly lastPath: string | null;
  }) => void;
  rememberSystemTabPath: (
    kind: "history" | "settings",
    path: string | null,
  ) => void;
  closeSystemTab: (kind: "history" | "settings") => void;
  pair: (args: PairLayoutArgs) => void;
  createEmptySplit: (args: CreateEmptySplitArgs) => void;
  replaceFillableSide: (args: ReplaceFillableSideArgs) => void;
  focusRef: (ref: TabRef) => void;
  focusSplitSide: (args: SplitSideArgs) => void;
  resizeSplit: (args: ResizeSplitArgs) => void;
  swapSplitSides: (splitId: string) => void;
  separateSplit: (splitId: string) => void;
  replaceRef: (args: ReplaceRefArgs) => void;
  reorderItem: (args: ReorderItemArgs) => void;
  repair: () => void;
}

const TABS_PERSIST_KEY = persistKey(STORE_KEYS.tabs);

function canSplitRef(ref: TabRef): boolean {
  return tabSurfaceDescriptor(ref.kind).splitEligibility === "eligible";
}

function committedLayout(layout: PersistedTabStripLayout): CommittedTabsLayout {
  const repaired = repairLayout(layout, isRegisteredTabKind);
  return {
    ...repaired,
    stripOrder: flattenLayoutRefs(repaired),
  };
}

function layoutFromState(state: TabsStoreState): PersistedTabStripLayout {
  const layout: PersistedTabStripLayout = {
    version: 2,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
  };
  // Older consumers and existing tests may still seed Zustand directly with
  // `stripOrder`. Treat such a mismatch as an external v1 compatibility write
  // and immediately rebuild a flat v2 layout at the next reducer boundary.
  return refsMatch(flattenLayoutRefs(layout), state.stripOrder)
    ? layout
    : state.stripOrder.reduce(createLayoutItem, {
        ...emptyTabStripLayout(),
        systemTabs: state.systemTabs,
      });
}

function refsMatch(
  left: ReadonlyArray<TabRef>,
  right: ReadonlyArray<TabRef>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (ref, index) =>
        ref.kind === right[index]?.kind && ref.id === right[index]?.id,
    )
  );
}

function reconcileLayoutRefs(
  layout: PersistedTabStripLayout,
  refs: ReadonlyArray<TabRef>,
): PersistedTabStripLayout {
  const seen = new Set<string>();
  const nextRefs = refs.reduce<ReadonlyArray<TabRef>>((deduplicated, ref) => {
    const key = tabRefKey(ref);
    if (ref.id.length === 0 || seen.has(key)) return deduplicated;
    seen.add(key);
    return [...deduplicated, ref];
  }, []);
  const wanted = new Set(nextRefs.map(tabRefKey));
  const withoutMissing = flattenLayoutRefs(layout)
    .filter((ref) => !wanted.has(tabRefKey(ref)))
    .reduce(removeLayoutRef, layout);
  const withAdditions = nextRefs.reduce(
    (current, ref) =>
      findStripItemForRef(current, ref) === null
        ? createLayoutItem(current, ref)
        : current,
    withoutMissing,
  );
  const positions = new Map(
    nextRefs.map((ref, index) => [tabRefKey(ref), index]),
  );
  const items = [...withAdditions.items].sort((left, right) => {
    const leftIndex = firstRefPosition(left, positions, nextRefs.length);
    const rightIndex = firstRefPosition(right, positions, nextRefs.length);
    return leftIndex - rightIndex;
  });
  return { ...withAdditions, items };
}

function firstRefPosition(
  item: StripItem,
  positions: ReadonlyMap<string, number>,
  fallback: number,
): number {
  return Math.min(
    ...flattenLayoutRefs({
      version: 2,
      items: [item],
      activeItemId: item.id,
      systemTabs: emptySystemTabs(),
    }).map((ref) => positions.get(tabRefKey(ref)) ?? fallback),
  );
}

export function migrateTabsPersistedState(
  value: unknown,
): PersistedTabsStoreState {
  if (!isRecord(value)) return committedLayout(emptyTabStripLayout());
  const systemTabs = parseSystemTabs(value.systemTabs);
  const v2Items = Array.isArray(value.items)
    ? value.items.flatMap(parseStripItem)
    : null;
  if (v2Items !== null) {
    return committedLayout({
      version: 2,
      items: v2Items,
      activeItemId:
        typeof value.activeItemId === "string" ? value.activeItemId : null,
      systemTabs,
    });
  }
  const legacyRefs = Array.isArray(value.stripOrder)
    ? value.stripOrder.flatMap(parseTabRef)
    : [];
  const legacyLayout = legacyRefs.reduce(createLayoutItem, {
    ...emptyTabStripLayout(),
    systemTabs,
  });
  return committedLayout(legacyLayout);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTabRef(value: unknown): ReadonlyArray<TabRef> {
  if (!isRecord(value)) return [];
  if (typeof value.kind !== "string" || typeof value.id !== "string") return [];
  if (!isRegisteredTabKind(value.kind) || value.id.length === 0) return [];
  if (value.kind === "history" && value.id !== "history") return [];
  if (value.kind === "settings" && value.id !== "settings") return [];
  return [{ kind: value.kind, id: value.id }];
}

function parseSplitSide(value: unknown): SplitSide {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return { kind: "empty" };
  }
  if (value.kind === "empty") return { kind: "empty" };
  if (value.kind === "tab") {
    const ref = parseTabRef(value.ref);
    const firstRef = firstOrNull(ref);
    return firstRef === null
      ? { kind: "empty" }
      : { kind: "tab", ref: firstRef };
  }
  if (value.kind === "unavailable") {
    const previousRef = parseTabRef(value.previousRef);
    const firstPreviousRef = firstOrNull(previousRef);
    if (firstPreviousRef === null) return { kind: "empty" };
    return {
      kind: "unavailable",
      previousRef: firstPreviousRef,
      label: typeof value.label === "string" ? value.label : "Unavailable tab",
    };
  }
  return { kind: "empty" };
}

function parseStripItem(value: unknown): ReadonlyArray<StripItem> {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return [];
  }
  if (value.kind === "tab" && typeof value.id === "string") {
    const ref = parseTabRef(value.ref);
    const firstRef = firstOrNull(ref);
    return firstRef === null
      ? []
      : [{ kind: "tab", id: value.id, ref: firstRef }];
  }
  if (value.kind !== "split") return [];
  const left = parseSplitSide(value.left);
  const right = parseSplitSide(value.right);
  return [
    {
      kind: "split",
      id: typeof value.id === "string" ? value.id : "split",
      left,
      right,
      focusedSide: value.focusedSide === "right" ? "right" : "left",
      routeBackingSide: value.routeBackingSide === "right" ? "right" : "left",
      leftRatio:
        typeof value.leftRatio === "number"
          ? value.leftRatio
          : DEFAULT_LEFT_RATIO,
    },
  ];
}

function parseSystemTabs(value: unknown): SystemTabs {
  if (!isRecord(value)) return emptySystemTabs();
  return {
    history: parseSystemTab(value.history, "history"),
    settings: parseSystemTab(value.settings, "settings"),
  };
}

function firstOrNull<T>(values: ReadonlyArray<T>): T | null {
  const value = values.at(0);
  return value === undefined ? null : value;
}

function parseSystemTab(
  value: unknown,
  kind: "history" | "settings",
): SystemTab | null {
  if (!isRecord(value)) return null;
  if (
    value.kind !== kind ||
    typeof value.name !== "string" ||
    (typeof value.lastPath !== "string" && value.lastPath !== null)
  ) {
    return null;
  }
  return { id: kind, kind, name: value.name, lastPath: value.lastPath };
}

export const useTabsStore = create<TabsStoreState>()(
  persist(
    (set) => ({
      ...committedLayout(emptyTabStripLayout()),

      replaceLayoutForTransaction: (layout) => {
        set({
          version: layout.version,
          items: layout.items,
          activeItemId: layout.activeItemId,
          systemTabs: layout.systemTabs,
        });
      },

      finalizeTransactionLayout: () => {
        set((state) =>
          committedLayout({
            version: 2,
            items: state.items,
            activeItemId: state.activeItemId,
            systemTabs: state.systemTabs,
          }),
        );
      },

      ensurePresent: (ref) => {
        set((state) =>
          committedLayout(createLayoutItem(layoutFromState(state), ref)),
        );
      },

      dropRef: (ref) => {
        set((state) =>
          committedLayout(removeLayoutRef(layoutFromState(state), ref)),
        );
      },

      setStripOrder: (refs) => {
        set((state) =>
          committedLayout(reconcileLayoutRefs(layoutFromState(state), refs)),
        );
      },

      moveRef: (ref, targetIndex) => {
        set((state) => {
          const item = findStripItemForRef(layoutFromState(state), ref);
          if (item === null) return state;
          return committedLayout(
            reorderStripItem(layoutFromState(state), {
              itemId: item.id,
              targetIndex,
            }),
          );
        });
      },

      openSystemTab: ({ kind, name, lastPath }) => {
        set((state) => {
          const existing = state.systemTabs[kind];
          const resolvedLastPath = lastPath ?? existing?.lastPath ?? null;
          const systemTabs: SystemTabs = {
            ...state.systemTabs,
            [kind]: { id: kind, kind, name, lastPath: resolvedLastPath },
          };
          const layout = createLayoutItem(
            { ...layoutFromState(state), systemTabs },
            { kind, id: kind },
          );
          return committedLayout(layout);
        });
      },

      rememberSystemTabPath: (kind, path) => {
        set((state) => {
          const existing = state.systemTabs[kind];
          if (existing === null || existing.lastPath === path) return state;
          return committedLayout({
            ...layoutFromState(state),
            systemTabs: {
              ...state.systemTabs,
              [kind]: { ...existing, lastPath: path },
            },
          });
        });
      },

      closeSystemTab: (kind) => {
        set((state) =>
          committedLayout({
            ...removeLayoutRef(layoutFromState(state), { kind, id: kind }),
            systemTabs: { ...state.systemTabs, [kind]: null },
          }),
        );
      },

      pair: (args) => {
        set((state) =>
          committedLayout(
            pairLayoutRefs(layoutFromState(state), args, canSplitRef),
          ),
        );
      },

      createEmptySplit: (args) => {
        set((state) =>
          committedLayout(
            createEmptySplit(layoutFromState(state), args, canSplitRef),
          ),
        );
      },

      replaceFillableSide: (args) => {
        set((state) =>
          committedLayout(
            replaceFillableSide(layoutFromState(state), args, canSplitRef),
          ),
        );
      },

      focusRef: (ref) => {
        set((state) =>
          committedLayout(focusLayoutRef(layoutFromState(state), ref)),
        );
      },

      focusSplitSide: (args) => {
        set((state) =>
          committedLayout(focusSplitSide(layoutFromState(state), args)),
        );
      },

      resizeSplit: (args) => {
        set((state) =>
          committedLayout(resizeSplit(layoutFromState(state), args)),
        );
      },

      swapSplitSides: (splitId) => {
        set((state) =>
          committedLayout(swapSplitSides(layoutFromState(state), splitId)),
        );
      },

      separateSplit: (splitId) => {
        set((state) =>
          committedLayout(separateSplit(layoutFromState(state), splitId)),
        );
      },

      replaceRef: (args) => {
        set((state) =>
          committedLayout(replaceLayoutRef(layoutFromState(state), args)),
        );
      },

      reorderItem: (args) => {
        set((state) =>
          committedLayout(reorderStripItem(layoutFromState(state), args)),
        );
      },

      repair: () => {
        set((state) => committedLayout(layoutFromState(state)));
      },
    }),
    {
      ...basePersistOptions(TABS_PERSIST_KEY),
      version: 2,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state): PersistedTabsStoreState =>
        committedLayout(layoutFromState(state)),
      migrate: (persisted) => migrateTabsPersistedState(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...migrateTabsPersistedState(persisted),
      }),
    },
  ),
);

// Reconciliation install lives in `WindowsBridgeProvider` so the hydration
// gate's ready-promise can be set up before subscriptions fire.
