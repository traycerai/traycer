/**
 * Mounted = pinned terminals union LRU(cap 3, head = active) union retained chats. Terminals never enter the LRU; chats use pane activationHistory, not this hook's recency.
 * Hide retained chats with visibility, not display:none. Chat retention does not collapse while the pane is hidden.
 */
import { useMemo, useState } from "react";
import type { EpicCanvasTileRef, TilePane } from "@/stores/epics/canvas/types";
import {
  isRetainablePaneChat,
  RETAINED_PANE_CHAT_CAP,
  retainedPaneChatInstanceIds,
} from "@/stores/epics/canvas/retained-pane-chats";

/** Max recently-active non-terminal, non-chat tab bodies kept mounted per pane. */
export const MOUNTED_PANE_TAB_LRU_CAP = 3;

/**
 * Terminal-backed surfaces stay mounted for the pane's life; hide via visibility so the terminal keeps its box while concealed.
 */
export function isPersistentTerminalSurface(tab: EpicCanvasTileRef): boolean {
  return tab.type === "terminal" || tab.type === "terminal-agent";
}

export function concealsWithoutCollapsing(tab: EpicCanvasTileRef): boolean {
  return isPersistentTerminalSurface(tab) || isRetainablePaneChat(tab);
}

export interface UseMountedPaneTabsInput {
  /** Resolved active tab instance id (after fallback), null for empty pane. */
  readonly activeTabId: string | null;
  /** The pane itself, for its store-resident `activationHistory`. */
  readonly pane: TilePane;
  /** The pane's resolved tab refs, in strip order. */
  readonly tabs: ReadonlyArray<EpicCanvasTileRef>;
  /** From `usePaneVisible()`: false while the keep-alive pane is hidden. */
  readonly paneVisible: boolean;
}

interface DeriveMountedTabLruInput {
  readonly activeTabId: string | null;
  readonly availableTabIds: ReadonlySet<string>;
  readonly cap: number;
  readonly previousLru: ReadonlyArray<string>;
}

function deriveMountedTabLru(
  input: DeriveMountedTabLruInput,
): ReadonlyArray<string> {
  const { activeTabId, availableTabIds, cap, previousLru } = input;
  const maxSize = Math.max(1, cap);

  const next: string[] = [];
  if (activeTabId !== null && availableTabIds.has(activeTabId)) {
    next.push(activeTabId);
  }
  for (const tabId of previousLru) {
    if (next.length >= maxSize) break;
    if (tabId !== activeTabId && availableTabIds.has(tabId)) {
      next.push(tabId);
    }
  }
  return next;
}

const EMPTY_LRU: ReadonlyArray<string> = [];

function lruEquals(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => right[index] === id)
  );
}

export function useMountedPaneTabs(
  input: UseMountedPaneTabsInput,
): ReadonlySet<string> {
  const { activeTabId, pane, tabs, paneVisible } = input;

  // Terminals are pinned; chats are retained by their own policy below;
  // everything else competes for LRU slots.
  const { pinnedIds, availableLruIds, tileByInstanceId } = useMemo(() => {
    const pinned = new Set<string>();
    const available = new Set<string>();
    const byInstanceId = new Map<string, EpicCanvasTileRef>();
    for (const tab of tabs) {
      byInstanceId.set(tab.instanceId, tab);
      if (isPersistentTerminalSurface(tab)) {
        pinned.add(tab.instanceId);
      } else if (!isRetainablePaneChat(tab)) {
        available.add(tab.instanceId);
      }
    }
    return {
      pinnedIds: pinned,
      availableLruIds: available,
      tileByInstanceId: byInstanceId,
    };
  }, [tabs]);

  // The SAME window `tile-surface-membership.ts` picks, from the same kind-only predicate.
  // Two costs, and they are not the same: on THIS side an ineligible chat costs one concealed placeholder, while on the membership side it consumes a retention slot, so a pane holding a dead chat among its two most recent retains only one live chat and the second still churns.
  const retainedChatIds = useMemo(
    () =>
      new Set(
        retainedPaneChatInstanceIds({
          pane,
          cap: RETAINED_PANE_CHAT_CAP,
          tileFor: (instanceId) => tileByInstanceId.get(instanceId),
        }),
      ),
    [pane, tileByInstanceId],
  );

  const [committedLru, setCommittedLru] =
    useState<ReadonlyArray<string>>(EMPTY_LRU);
  const mountedTabLru = deriveMountedTabLru({
    activeTabId,
    availableTabIds: availableLruIds,
    cap: paneVisible ? MOUNTED_PANE_TAB_LRU_CAP : 1,
    // A hidden pane collapses to the active tab only; dropping the committed history here is what makes the LRU rebuild from actual revisits after the pane becomes visible again.
    previousLru: paneVisible ? committedLru : EMPTY_LRU,
  });
  // Guarded adjust-state-during-render: deriving from its own output is a fixed point, so this converges after a single extra render pass.
  // React discards the output of the pass that calls setState, so the returned set is built from the committed state - in the pass that actually commits, `committedLru` always equals the derivation.
  if (!lruEquals(mountedTabLru, committedLru)) {
    setCommittedLru(mountedTabLru);
  }

  return useMemo(() => {
    const mounted = new Set<string>(committedLru);
    for (const id of pinnedIds) mounted.add(id);
    for (const id of retainedChatIds) mounted.add(id);
    return mounted;
  }, [committedLru, pinnedIds, retainedChatIds]);
}
