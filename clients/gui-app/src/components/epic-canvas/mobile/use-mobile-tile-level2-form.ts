import { useMemo } from "react";
import {
  selectMobileSecondaryTile,
  selectMobileTile,
  type MobileTileSelection,
} from "@/components/epic-canvas/mobile/mobile-tile-selection";
import {
  useInstalledAppTileForm,
  type InstalledAppTileForm,
} from "@/hooks/ui/use-installed-app-level2-form";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import { useEpicCanvas, useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileTileColumnCollapsed } from "@/stores/epics/mobile-tile-column-store";

/** Off the installed app the list is the sheet behind the header's trigger. */
const ONE_TILE_OVER_THE_BAR: InstalledAppTileForm = {
  level2: "bar",
  tiles: 1,
};

interface MobileTileReading extends InstalledAppTileForm {
  readonly primary: MobileTileSelection | null;
  /** The second tile the person has open, whether or not it fits right now. */
  readonly secondary: MobileTileSelection | null;
  /**
   * Whether the width offers the column: `level2` is then the column, or the
   * menu because the person folded it (`mobile-tile-column-store.ts`).
   */
  readonly columnOffered: boolean;
}

/**
 * The task's tiles and the form they draw in: the second tile counts as open
 * while its slot resolves, the width rule answers how many of the two show and
 * where a column fits, and the person's fold turns that column into the menu.
 */
export function useMobileTileReading(tabId: string): MobileTileReading {
  const canvas = useEpicCanvas(tabId);
  const slot = useEpicCanvasStore((s) => s.mobileSecondaryTileByTabId[tabId]);
  const { primary, secondary } = useMemo(() => {
    const first = selectMobileTile(canvas);
    return {
      primary: first,
      secondary: selectMobileSecondaryTile(canvas, slot, first),
    };
  }, [canvas, slot]);
  const form =
    useInstalledAppTileForm(secondary === null ? 1 : 2) ??
    ONE_TILE_OVER_THE_BAR;
  const collapsed = useMobileTileColumnCollapsed();
  const columnOffered = typeof form.level2 === "object";
  return {
    ...form,
    level2: columnOffered && collapsed ? "menu" : form.level2,
    columnOffered,
    primary,
    secondary,
  };
}

/** The form a task's tile list draws in. */
export function useMobileTileLevel2Form(tabId: string): MobileLevel2Form {
  return useMobileTileReading(tabId).level2;
}
