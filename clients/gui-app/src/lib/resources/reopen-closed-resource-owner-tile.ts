import { queryClient } from "@/lib/query-client";
import { rejectClosedPlainTerminalRestore } from "@/lib/terminals/plain-terminal-presentation-invalidation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/**
 * Resource-monitor closed-tile store reopen. The tombstone gate runs here so
 * an evicted epic surface cannot resurrect a retained deletion.
 */
export function reopenClosedResourceOwnerTile(args: {
  readonly epicId: string;
  readonly tabId: string;
  readonly node: EpicCanvasTileRef;
}): boolean {
  if (
    rejectClosedPlainTerminalRestore({
      queryClient,
      epicId: args.epicId,
      node: args.node,
    })
  ) {
    return false;
  }
  useEpicCanvasStore
    .getState()
    .prepareOpenTileInTabFocusTarget(args.tabId, args.node);
  return true;
}
