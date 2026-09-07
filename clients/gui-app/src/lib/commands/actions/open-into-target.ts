/** Docs: see ./README.md */
import {
  commitWithoutNavigation,
  MANUAL_TILE_OPEN,
  openTileWithNavigation,
} from "@/lib/canvas/tile-open/open-tile";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

export interface OpenTileIntoTargetGroupArgs {
  /** Active header (epic-view) tab that owns the canvas. */
  readonly tabId: string | null;
  /** Bound canvas tile group id (the opener target). */
  readonly groupId: string | null;
  readonly ref: EpicCanvasTileRef;
  /**
   * `false` mints a fresh, non-deduped instance - right when two views of the same content are useful (a diff open twice).
   * `true` for a SINGLETON tile whose content `id` is derived from what it shows (the per-epic communication graph): two tabs would share that id, so per-tile state keyed on it - the comm graph's persisted viewport - would be written by both.
   */
  readonly dedupe: boolean;
  /**
   * Nested-focus navigation seam from the caller's `CommandContext.router`.
   * `undefined` when the router adapter carries no navigation seam (e.g. a bare test double) - the raw canvas mutation still runs.
   */
  readonly navigateNestedFocus: NavigateNestedFocus | undefined;
}

export function openTileIntoTargetGroup(
  args: OpenTileIntoTargetGroupArgs,
): void {
  if (args.tabId === null || args.groupId === null) return;
  openTileWithNavigation(
    {
      node: args.ref,
      target: { tabId: args.tabId },
      // The opener's own pane IS the placement (C6, C7).
      gesture: "explicit",
      modifiers: null,
      placement: { kind: "tab", paneId: args.groupId, index: null },
      dedupe: args.dedupe,
      source: "command_palette",
    },
    args.navigateNestedFocus ?? commitWithoutNavigation,
    MANUAL_TILE_OPEN,
  );
}
