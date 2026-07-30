/**
 * Docs: see ./README.md
 *
 * Opener action for a SINGLETON tile - one whose content `id` is derived from
 * what it shows rather than minted per instance (today: the per-epic
 * communication graph).
 *
 * The default {@link openTileIntoTargetGroup} deliberately opens a fresh,
 * non-deduped instance, which is right when two views of the same content are
 * useful (a diff open twice). It is wrong for a singleton: both tabs would
 * carry the same content id, so per-tile state keyed on that id - the comm
 * graph's persisted viewport - would be written by both. This delegate focuses
 * the existing tab instead, and only opens when there is none.
 *
 * Same nested-focus boundary and same no-op-without-target guards as
 * {@link openTileIntoTargetGroup}.
 */
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

export interface OpenSingletonTileIntoTargetGroupArgs {
  /** Active header (epic-view) tab that owns the canvas. */
  readonly tabId: string | null;
  /** Bound canvas tile group id (the opener target). */
  readonly groupId: string | null;
  readonly ref: EpicCanvasTileRef;
  readonly navigateNestedFocus: NavigateNestedFocus | undefined;
}

export function openSingletonTileIntoTargetGroup(
  args: OpenSingletonTileIntoTargetGroupArgs,
): void {
  if (args.tabId === null || args.groupId === null) return;
  const tabId = args.tabId;
  const groupId = args.groupId;
  const prepare = () =>
    useEpicCanvasStore
      .getState()
      .prepareOpenSingletonTileInPaneFocusTarget(tabId, groupId, args.ref);
  const epicId = useEpicCanvasStore.getState().tabsById[tabId]?.epicId ?? null;
  if (epicId === null || args.navigateNestedFocus === undefined) {
    prepare();
    return;
  }
  args.navigateNestedFocus(epicId, tabId, prepare);
}
