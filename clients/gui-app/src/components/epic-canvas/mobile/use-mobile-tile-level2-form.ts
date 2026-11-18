import { useMemo } from "react";
import {
  selectMobileSecondaryTile,
  selectMobileTile,
  type MobileTileSelection,
} from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { useInstalledAppTileForm } from "@/hooks/ui/use-installed-app-level2-form";
import type { MobileTileCount } from "@/lib/layout/mobile-layout-form";
import { useEpicCanvas, useEpicCanvasStore } from "@/stores/epics/canvas/store";

/**
 * Where a task's list is reached from. The list is the bottom sheet in both:
 * `bar` is the phone's form, opened from the app header's trigger over a bar
 * that is a label; `pane` is every wider form, where each tile's own header
 * carries the controls that open it. The resolver's column and menu are
 * Tracy's forms (`bot-channel-level2.tsx`); a task's tiles draw neither.
 */
export type MobileTileListForm = "bar" | "pane";

interface MobileTileReading {
  readonly form: MobileTileListForm;
  /** How many of the open tiles show. */
  readonly tiles: MobileTileCount;
  /** Whether a second tile would fit right now, so a Split can be offered. */
  readonly splitFits: boolean;
  readonly primary: MobileTileSelection | null;
  /** The second tile the person has open, whether or not it fits right now. */
  readonly secondary: MobileTileSelection | null;
}

/**
 * The task's tiles and the form they draw in: the second tile counts as open
 * while its slot resolves, and the width rule answers how many of the two
 * show.
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
  const one = useInstalledAppTileForm(1);
  const two = useInstalledAppTileForm(2);
  // Off the installed app the list is the sheet behind the header's trigger.
  const form = secondary === null ? one : two;
  return {
    form: form === null || form.level2 === "bar" ? "bar" : "pane",
    tiles: form?.tiles ?? 1,
    splitFits: two?.tiles === 2,
    primary,
    secondary,
  };
}

/** The form a task's tile list draws in. */
export function useMobileTileListForm(tabId: string): MobileTileListForm {
  return useMobileTileReading(tabId).form;
}
