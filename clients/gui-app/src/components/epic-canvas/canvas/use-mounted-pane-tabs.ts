/**
 * Per-pane keep-alive policy for canvas tab bodies (paseo
 * `use-mounted-tab-set` port + traycer terminal pinning):
 *
 *   mounted = {pinned terminal surfaces} ∪ LRU(cap 3, head = active tab)
 *
 * - The LRU tracks the most recently ACTIVE non-terminal tabs, so switching
 *   back to a recently used chat/editor is a visibility toggle instead of a
 *   remount. The active tab IS the LRU head - it occupies one of the slots,
 *   so at most 3 non-terminal bodies are mounted in total, INCLUDING the
 *   active one. The cap bounds how many heavy hidden bodies a pane can hold.
 * - Terminal surfaces (`terminal` / `terminal-agent`) are PINNED: they are
 *   always mounted while their tab is open and never count against - nor can
 *   they be evicted by - the LRU. A PTY's scrollback cannot be rebuilt from
 *   props, so eviction would destroy state (the pre-LRU policy mounted all
 *   terminals for exactly this reason).
 * - While the surrounding keep-alive pane is HIDDEN (background header tab,
 *   `usePaneVisible() === false`), the LRU collapses to the active tab only:
 *   background panes pay for at most one non-terminal body (+ terminals).
 *   The committed LRU is truncated with it, so on re-focus the set rebuilds
 *   from the tabs the user actually revisits.
 *
 * Recency is recorded with React's "adjust state during render" pattern (a
 * guarded `setState` while rendering, same idiom as `EpicTabHost`'s pane
 * recency): the derivation reads the previous committed list + the new
 * active id, so a newly activated tab is mounted in the SAME render that
 * activates it, and the guarded set converges in one extra render pass.
 * (A `useLayoutEffect`-committed ref would be the paseo shape, but reading
 * a ref during render violates the React Compiler's `react-hooks/refs`.)
 */
import { useMemo, useState } from "react";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/** Max recently-active non-terminal tab bodies kept mounted per pane. */
export const MOUNTED_PANE_TAB_LRU_CAP = 3;

/**
 * Terminal-backed surfaces keep their xterm buffers mounted for the pane's
 * lifetime (pinned in the mounted set; hidden via `visibility` so the
 * terminal keeps its box dimensions while concealed).
 */
export function isPersistentTerminalSurface(tab: EpicCanvasTileRef): boolean {
  return tab.type === "terminal" || tab.type === "terminal-agent";
}

export interface UseMountedPaneTabsInput {
  /** Resolved active tab instance id (after fallback), null for empty pane. */
  readonly activeTabId: string | null;
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
  const { activeTabId, tabs, paneVisible } = input;

  // Terminals are pinned; everything else competes for LRU slots.
  const { pinnedIds, availableLruIds } = useMemo(() => {
    const pinned = new Set<string>();
    const available = new Set<string>();
    for (const tab of tabs) {
      if (isPersistentTerminalSurface(tab)) {
        pinned.add(tab.instanceId);
      } else {
        available.add(tab.instanceId);
      }
    }
    return { pinnedIds: pinned, availableLruIds: available };
  }, [tabs]);

  const [committedLru, setCommittedLru] =
    useState<ReadonlyArray<string>>(EMPTY_LRU);
  const mountedTabLru = deriveMountedTabLru({
    activeTabId,
    availableTabIds: availableLruIds,
    cap: paneVisible ? MOUNTED_PANE_TAB_LRU_CAP : 1,
    // A hidden pane collapses to the active tab only; dropping the
    // committed history here is what makes the LRU rebuild from actual
    // revisits after the pane becomes visible again.
    previousLru: paneVisible ? committedLru : EMPTY_LRU,
  });
  // Guarded adjust-state-during-render: deriving from its own output is a
  // fixed point, so this converges after a single extra render pass. React
  // discards the output of the pass that calls setState, so the returned
  // set is built from the committed state - in the pass that actually
  // commits, `committedLru` always equals the derivation.
  if (!lruEquals(mountedTabLru, committedLru)) {
    setCommittedLru(mountedTabLru);
  }

  return useMemo(() => {
    const mounted = new Set<string>(committedLru);
    for (const id of pinnedIds) mounted.add(id);
    return mounted;
  }, [committedLru, pinnedIds]);
}
