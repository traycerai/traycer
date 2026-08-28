/**
 * Per-pane keep-alive policy for canvas tab bodies (paseo
 * `use-mounted-tab-set` port + traycer terminal pinning):
 *
 *   mounted = {pinned terminal surfaces} ∪ LRU(cap 3, head = active tab) ∪ retained chats
 *
 * - The LRU tracks the most recently ACTIVE non-terminal, non-chat tabs, so
 *   switching back to a recently used editor/spec is a visibility toggle
 *   instead of a remount. The active tab IS the LRU head - it occupies one
 *   of the slots, so at most 3 such bodies are mounted in total, INCLUDING
 *   the active one. The cap bounds how many heavy hidden bodies a pane can
 *   hold.
 * - Terminal surfaces (`terminal` / `terminal-agent`) are PINNED: they are
 *   always mounted while their tab is open and never count against - nor can
 *   they be evicted by - the LRU. A PTY's scrollback cannot be rebuilt from
 *   props, so eviction would destroy state (the pre-LRU policy mounted all
 *   terminals for exactly this reason).
 * - Chat tabs have their OWN retention, kept separate from the LRU and
 *   derived from the pane's store-resident `activationHistory` rather than
 *   from any recency this hook tracks itself. See
 *   `stores/epics/canvas/retained-pane-chats.ts` for why that shared input
 *   is mandatory: `tile-surface-membership.ts` decides which hosted chat
 *   RECORDS exist from the same policy, and a record whose slot stopped
 *   rendering freezes at its last published environment and paints over the
 *   pane's real selection. This supersedes decision log #17 ("a chat mounts
 *   only while it is the active tab"), whose remount is what made an inner
 *   tab switch visibly re-converge the transcript; a retained chat now takes
 *   the same hide/show path a backgrounded top-level tab already took, and
 *   `ChatMessages` replays its saved anchor once against a list it never
 *   stopped measuring. The per-tab `chat-tab-state-cache` still backs a real
 *   remount (eviction past the cap, close, reopen).
 * - Retained chats conceal via `visibility` rather than `display:none`, for
 *   the same reason terminals do: a collapsed box reflows the concealed body
 *   at zero width and republishes bogus item sizes, which is precisely the
 *   churn this retention exists to remove.
 * - While the surrounding keep-alive pane is HIDDEN (background header tab,
 *   `usePaneVisible() === false`), the LRU collapses to the active tab only:
 *   background panes pay for at most one non-terminal body (+ terminals).
 *   The committed LRU is truncated with it, so on re-focus the set rebuilds
 *   from the tabs the user actually revisits. Chat retention deliberately
 *   does NOT collapse with it - and that is a TRADEOFF, not a constraint.
 *   `tile-surface-membership.ts` could observe pane visibility: its
 *   `computeRetainedTopLevelRefKeys` already derives `activeRefKeys` from the
 *   same `flattenStripItemRefs(activeItem)` that `TopLevelTabHost` turns into
 *   the `usePaneVisible()` value. Collapsing is refused because it would undo
 *   the fix for the first inner switch after returning to a background tab -
 *   the retained chat would have been dropped while hidden, so the reader
 *   would watch it re-converge exactly once per background trip. The price is
 *   real and unmeasured in the live app: ~4 hidden top-level surfaces each
 *   hold 2 mounted chats per pane instead of 1, and a mounted chat leases a
 *   session that sits OUTSIDE `DEFAULT_MAX_WARM_CHAT_SESSIONS` and never
 *   idle-expires - so a 5-tab x 3-pane workspace moves from ~15 to ~30
 *   unreclaimable `chat.subscribe` sockets, none of them visible. Revisit
 *   this if that socket count bites before the churn does.
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
import type { EpicCanvasTileRef, TilePane } from "@/stores/epics/canvas/types";
import {
  isRetainablePaneChat,
  RETAINED_PANE_CHAT_CAP,
  retainedPaneChatInstanceIds,
} from "@/stores/epics/canvas/retained-pane-chats";

/** Max recently-active non-terminal, non-chat tab bodies kept mounted per pane. */
export const MOUNTED_PANE_TAB_LRU_CAP = 3;

/**
 * Terminal-backed surfaces keep their xterm buffers mounted for the pane's
 * lifetime (pinned in the mounted set; hidden via `visibility` so the
 * terminal keeps its box dimensions while concealed).
 */
export function isPersistentTerminalSurface(tab: EpicCanvasTileRef): boolean {
  return tab.type === "terminal" || tab.type === "terminal-agent";
}

/**
 * Whether a concealed layer for `tab` must keep its layout box rather than
 * collapse out of flow. True for terminals (xterm needs its dimensions) and
 * for retained chats (a zero-width reflow republishes bogus item sizes).
 */
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

  // The SAME window `tile-surface-membership.ts` picks, from the same
  // kind-only predicate. Membership then drops the ineligible ones (a
  // remote-deleted chat, a published-copy takeover) from THIS set, so it is a
  // genuine subset and every member is guaranteed a slot here. Two costs, and
  // they are not the same: on THIS side an ineligible chat costs one concealed
  // placeholder, while on the membership side it consumes a retention slot, so
  // a pane holding a dead chat among its two most recent retains only one live
  // chat and the second still churns. Both are strictly better than the
  // reverse - a member with no slot strands a hosted body on a disconnected
  // anchor (cold review F1).
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
    for (const id of retainedChatIds) mounted.add(id);
    return mounted;
  }, [committedLru, pinnedIds, retainedChatIds]);
}
