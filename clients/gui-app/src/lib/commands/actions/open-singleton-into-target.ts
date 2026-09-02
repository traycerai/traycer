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
import {
  commitWithoutNavigation,
  openTileWithNavigation,
} from "@/lib/canvas/tile-open/open-tile";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

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
  openTileWithNavigation(
    {
      node: args.ref,
      target: { tabId: args.tabId },
      // Same explicit target pane as `openTileIntoTargetGroup`, but dedupe
      // stays ON: a singleton focuses its one instance instead of minting a
      // second view whose per-content state both tabs would write.
      gesture: "explicit",
      modifiers: null,
      placement: { kind: "tab", paneId: args.groupId, index: null },
      dedupe: true,
      source: "command_palette",
    },
    args.navigateNestedFocus ?? commitWithoutNavigation,
  );
}
