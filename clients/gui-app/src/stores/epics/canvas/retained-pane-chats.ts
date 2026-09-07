/**
 * Pick the retention window with `isRetainablePaneChat` alone.
 * Caller eligibility applies after the cap; a predicate here shifts the window.
 */
import type { EpicCanvasTileRef, TilePane } from "@/stores/epics/canvas/types";
import { resolveActivePaneTab } from "@/stores/epics/canvas/tile-tree";

/** Tile-kind predicate for the retention window. Caller eligibility belongs after the cap. */
export function isRetainablePaneChat(tab: EpicCanvasTileRef): boolean {
  return tab.type === "chat";
}

/**
 * Recently-active chat tiles kept alive per pane, INCLUDING the active one when it is itself a
 * chat.
 */
export const RETAINED_PANE_CHAT_CAP = 2;

export interface RetainedPaneChatInstancesInput {
  readonly pane: TilePane;
  /** Resolves an instance id to its tile, or `undefined` when this pane's canvas does not hold one. */
  readonly tileFor: (instanceId: string) => EpicCanvasTileRef | undefined;
  readonly cap: number;
}

/** The retained chat instance ids for one pane, most-recently-active first. */
export function retainedPaneChatInstanceIds(
  input: RetainedPaneChatInstancesInput,
): ReadonlyArray<string> {
  const { pane, tileFor, cap } = input;
  const maxSize = Math.max(1, cap);
  const live = new Set(pane.tabInstanceIds);
  const retained: string[] = [];

  const consider = (instanceId: string | null): void => {
    if (instanceId === null) return;
    if (retained.length >= maxSize) return;
    if (!live.has(instanceId)) return;
    if (retained.includes(instanceId)) return;
    const tile = tileFor(instanceId);
    if (tile === undefined || !isRetainablePaneChat(tile)) return;
    retained.push(instanceId);
  };

  consider(resolveActivePaneTab(pane.activeTabId, pane.tabInstanceIds));
  for (const instanceId of pane.activationHistory) consider(instanceId);

  return retained;
}
