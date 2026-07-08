/**
 * Docs: see ./README.md
 *
 * Canonical opener action: place a tile ref into the palette's bound target
 * group as a fresh instance (no dedup), via the canvas store's
 * `prepareOpenTileInPaneFocusTarget` (see `stores/epics/canvas/store.ts` →
 * Decision 2 of the pane-opener tech plan). Both the "open" command source's
 * leaves and any future manual UI route through here per the palette →
 * manual-UI parity rule.
 *
 * Routes through the nested-focus navigation boundary (see the
 * "Nested Focus Opener Boundary" decision) so the open both mutates the
 * canvas AND writes the `focusPaneId`/`focusTileInstanceId` route params -
 * `navigateNestedFocus` is threaded in from the caller's `CommandContext.router`
 * (the same seam `KeybindingRouter.navigateNestedFocus` uses for non-React
 * dispatch). When the tab has no resolvable epic (e.g. the tab record doesn't
 * exist yet) or no navigation seam is available, the raw canvas mutation still
 * runs - only the route write is skipped, matching every other
 * `prepareX...FocusTarget` caller's no-op-when-no-router-context contract.
 *
 * No-ops entirely when there is no bound target group or no active header
 * tab - the opener is only reachable in open-into-target mode, but guarding
 * keeps the delegate safe to call unconditionally from a leaf's `run`.
 */
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

export interface OpenTileIntoTargetGroupArgs {
  /** Active header (epic-view) tab that owns the canvas. */
  readonly tabId: string | null;
  /** Bound canvas tile group id (the opener target). */
  readonly groupId: string | null;
  readonly ref: EpicCanvasTileRef;
  /**
   * Nested-focus navigation seam from the caller's `CommandContext.router`.
   * `undefined` when the router adapter carries no navigation seam (e.g. a
   * bare test double) - the raw canvas mutation still runs.
   */
  readonly navigateNestedFocus: NavigateNestedFocus | undefined;
}

export function openTileIntoTargetGroup(
  args: OpenTileIntoTargetGroupArgs,
): void {
  if (args.tabId === null || args.groupId === null) return;
  const tabId = args.tabId;
  const groupId = args.groupId;
  const prepare = () =>
    useEpicCanvasStore
      .getState()
      .prepareOpenTileInPaneFocusTarget(tabId, groupId, args.ref);
  const epicId = useEpicCanvasStore.getState().tabsById[tabId]?.epicId ?? null;
  if (epicId === null || args.navigateNestedFocus === undefined) {
    prepare();
    return;
  }
  args.navigateNestedFocus(epicId, tabId, prepare);
}
