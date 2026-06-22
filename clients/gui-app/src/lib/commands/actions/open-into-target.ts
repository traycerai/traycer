/**
 * Docs: see ./README.md
 *
 * Canonical opener action: place a tile ref into the palette's bound target
 * group as a fresh instance (no dedup), via the canvas store's
 * `openTileInPane` (see `stores/epics/canvas/actions.ts` → Decision 2 of the
 * pane-opener tech plan). Both the "open" command source's leaves and any
 * future manual UI route through here per the palette → manual-UI parity rule.
 *
 * No-ops when there is no bound target group or no active header tab - the
 * opener is only reachable in open-into-target mode, but guarding keeps the
 * delegate safe to call unconditionally from a leaf's `run`.
 */
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

export interface OpenTileIntoTargetGroupArgs {
  /** Active header (epic-view) tab that owns the canvas. */
  readonly tabId: string | null;
  /** Bound canvas tile group id (the opener target). */
  readonly groupId: string | null;
  readonly ref: EpicCanvasTileRef;
}

export function openTileIntoTargetGroup(
  args: OpenTileIntoTargetGroupArgs,
): void {
  if (args.tabId === null || args.groupId === null) return;
  useEpicCanvasStore
    .getState()
    .openTileInPane(args.tabId, args.groupId, args.ref);
}
