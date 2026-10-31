import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { StripItem } from "@/stores/tabs/layout";
import {
  notifyTabStructuralLocksChanged,
  registerTabCloseLockPredicate,
  registerTabStructuralLockPredicate,
} from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

/**
 * The fixed Tracy entry (T58, decision 150): the Tracy surface's tab, held
 * first in the strip and drawn beside Home rather than among the tabs, while
 * "Show Tracy" is on and the surface is open. `TracyEntryController` opens
 * the surface when the setting is on.
 *
 * The entry's ref is locked for structure and close while it is pinned, so
 * no gesture moves, pairs, groups or closes it. Turning the setting off
 * releases the lock and leaves the surface open as an ordinary, closable tab.
 * A build without bots (`unreleased-features.ts`) pins nothing, so a surface
 * a previous build restored is an ordinary tab there too.
 */
function isTracyEntryPinned(): boolean {
  return (
    UNRELEASED_FEATURES_ENABLED &&
    useSettingsStore.getState().showTracy &&
    useTracySurfaceStore.getState().open
  );
}

export function isTracyEntryRef(ref: TabRef): boolean {
  return ref.kind === "tracy" && isTracyEntryPinned();
}

/** Whether a strip item is the pinned entry's own (ungrouped) tab. */
function isTracyEntryItem(item: StripItem, pinned: boolean): boolean {
  return pinned && item.kind === "tab" && item.ref.kind === "tracy";
}

/**
 * The layout index of an insertion position counted among the strip's drawn
 * tabs, which leave the pinned entry out: before the tab drawn at `position`,
 * or after the last one. A drop that carries a position rather than a
 * neighbour's id (a canvas tear-off) lands where it was drawn.
 */
export function layoutIndexOfStripPosition(
  items: ReadonlyArray<StripItem>,
  position: number,
): number {
  const pinned = isTracyEntryPinned();
  let drawn = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (isTracyEntryItem(items[index], pinned)) continue;
    if (drawn === position) return index;
    drawn += 1;
  }
  return items.length;
}

/** The strip item id of the pinned entry's tab, or `null` with no entry drawn. */
export function useTracyEntryItemId(): string | null {
  const open = useTracySurfaceStore((state) => state.open);
  const showTracy = useSettingsStore((state) => state.showTracy);
  const pinned = UNRELEASED_FEATURES_ENABLED && showTracy && open;
  return useTabsStore(
    (state) =>
      state.items.find((item) => isTracyEntryItem(item, pinned))?.id ?? null,
  );
}

registerTabStructuralLockPredicate(isTracyEntryRef);
registerTabCloseLockPredicate(isTracyEntryRef);
useTracySurfaceStore.subscribe((next, previous) => {
  if (next.open !== previous.open) notifyTabStructuralLocksChanged();
});
useSettingsStore.subscribe((next, previous) => {
  if (next.showTracy !== previous.showTracy) notifyTabStructuralLocksChanged();
});
