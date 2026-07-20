import {
  flattenStripItemRefs,
  type SplitSide,
  type SplitSideName,
  type SplitStripItem,
  type StripItem,
} from "@/stores/tabs/layout";
import type { TabsStoreState } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

/** IDs-only header subscription; resolve each item independently when needed. */
export function selectHeaderStripItemIds(
  state: TabsStoreState,
): ReadonlyArray<string> {
  return state.items.map((item) => item.id);
}

/** Flat visual compatibility projection for legacy header consumers. */
export function selectHeaderMemberRefs(
  state: TabsStoreState,
): ReadonlyArray<TabRef> {
  return state.stripOrder;
}

export function makeSelectHeaderItem(
  itemId: string,
): (state: TabsStoreState) => StripItem | null {
  return (state) => state.items.find((item) => item.id === itemId) ?? null;
}

export function selectHostActiveItem(state: TabsStoreState): StripItem | null {
  if (state.activeItemId === null) return null;
  return state.items.find((item) => item.id === state.activeItemId) ?? null;
}

export function selectHostActiveSurfaceRefs(
  state: TabsStoreState,
): ReadonlyArray<TabRef> {
  const item = selectHostActiveItem(state);
  return item === null ? [] : flattenStripItemRefs(item);
}

export function selectHostFocusedRef(state: TabsStoreState): TabRef | null {
  const item = selectHostActiveItem(state);
  if (item === null || item.kind === "tab") return item?.ref ?? null;
  const side = item.focusedSide === "left" ? item.left : item.right;
  return side.kind === "tab" ? side.ref : null;
}

export function selectHostRouteBackingRef(
  state: TabsStoreState,
): TabRef | null {
  const item = selectHostActiveItem(state);
  if (item === null || item.kind === "tab") return item?.ref ?? null;
  const side = item.routeBackingSide === "left" ? item.left : item.right;
  return side.kind === "tab" ? side.ref : null;
}

export function makeSelectChooserSide(
  splitId: string,
  side: SplitSideName,
): (state: TabsStoreState) => SplitSide | null {
  return (state) => {
    const item = state.items.find(
      (candidate): candidate is SplitStripItem =>
        candidate.kind === "split" && candidate.id === splitId,
    );
    if (item === undefined) return null;
    return side === "left" ? item.left : item.right;
  };
}

export function makeSelectChooserIsFillable(
  splitId: string,
  side: SplitSideName,
): (state: TabsStoreState) => boolean {
  const selectSide = makeSelectChooserSide(splitId, side);
  return (state) => {
    const target = selectSide(state);
    return target !== null && target.kind !== "tab";
  };
}
