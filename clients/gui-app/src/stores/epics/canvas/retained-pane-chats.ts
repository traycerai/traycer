/**
 * Which chat tiles a pane keeps ALIVE, as opposed to merely which one it
 * currently shows.
 *
 * Decision #17 originally excluded chat tabs from every keep-alive path: a
 * chat mounted only while it was its pane's active tab, and a same-pane tab
 * switch was a real unmount/remount that rebuilt the reading position from
 * the `chat-tab-state-cache` on the way back. That was defensible while the
 * chat body lived inline in the pane, but it is what makes an inner tab
 * switch - and closing a second tab, which is the same transition arriving
 * from the other side - visibly churn: the remount restores through
 * LegendList's estimate-driven `initialScrollIndex` and then converges with
 * bounded measured reissues, so the reader watches the transcript settle.
 * Switching TOP-LEVEL task tabs never did this, because `TopLevelTabHost`
 * keeps its surfaces mounted and `ChatMessages`' hide/show effect replays the
 * saved anchor once against an already-measured list.
 *
 * Retaining the recently-active chats closes that gap without any new
 * restoration machinery: `chat-tile.tsx` already derives
 * `surfaceVisible = paneVisible && tabSelected`, so a retained-but-deselected
 * chat takes exactly the same hide/show path a hidden top-level tab does.
 *
 * ## Why the pane's own `activationHistory`
 *
 * Two independent layers have to agree on this set or they drift into the
 * two-owners failure design-review slice-4 finding 2 already cost us once:
 *
 * - `tile-surface-membership.ts` decides which hosted records EXIST. It runs
 *   outside React, from a raw `canvasByTabId` snapshot.
 * - `use-mounted-pane-tabs.ts` decides which pane tab layers - and therefore
 *   which `TileSurfaceSlot`s - render. It runs inside `TabGroupView`.
 *
 * A member whose slot stopped rendering keeps publishing nothing, so its
 * environment goes stale, its record keeps the sticky `canMountBody` latch,
 * and the hosted body stays mounted forever on a disconnected anchor -
 * invisible, unreachable, still holding a chat session lease. So the two
 * layers cannot each keep their own recency state; they must derive from one
 * shared input. `TilePane.activationHistory` already is that input -
 * MRU-ordered (`recordPaneActivation` unshifts the newly activated tab),
 * pruned to live tabs by `reconcileCanvasInvariants`, and persisted with the
 * canvas.
 *
 * ## Sharing this function is NOT by itself enough (cold review F1)
 *
 * The window is CAPPED, and the selection skips-and-keeps-filling when it
 * rejects an id. So two callers passing DIFFERENT predicates do not produce a
 * superset and a subset - they produce two SHIFTED windows. Concretely, with
 * pane `[a,b,c]`, history `[a,b,c]`, `a` active and `a` ineligible for the
 * stricter caller: the strict side rejects `a` and fills `[b,c]`, while the
 * lenient side takes `a` and fills `[a,b]`. `c` is then a member with no
 * slot - exactly the failure this whole design exists to prevent.
 *
 * Hence the contract: the window is picked with `isRetainablePaneChat` ALONE,
 * a pure question about the tile kind that both callers answer identically.
 * Caller-specific eligibility is applied to the RESULT, after the cap, which
 * makes membership a genuine subset of what the pane renders. Do not
 * reintroduce a caller-supplied predicate here.
 *
 * The cap is deliberately PER PANE rather than canvas-global: per-pane
 * recency is the only recency the store actually has, and inventing a
 * cross-pane order would mean new persisted state whose sole purpose is a
 * memory bound. The retained total is therefore
 * `Σ over retained top-level surfaces of (panes × cap)`, where the top-level
 * `MAX_RETAINED_TOP_LEVEL_SURFACES` cap still dominates.
 */
import type { EpicCanvasTileRef, TilePane } from "@/stores/epics/canvas/types";
import { resolveActivePaneTab } from "@/stores/epics/canvas/tile-tree";

/**
 * The ONE structural predicate that picks the retention window, shared
 * verbatim by both callers.
 *
 * It must stay a pure question about the tile's KIND. Any caller-specific
 * eligibility (remote deletion, a published-copy takeover, a revoked chat)
 * belongs AFTER the cap, never inside the window selection - see
 * `retainedPaneChatInstanceIds`.
 */
export function isRetainablePaneChat(tab: EpicCanvasTileRef): boolean {
  return tab.type === "chat";
}

/**
 * Recently-active chat tiles kept alive per pane, INCLUDING the active one
 * when it is itself a chat. Two is "the chat you are on plus the one you came
 * from", which covers both churn shapes reported: switching between two chats
 * in a pane, and closing a second tab to fall back to the chat underneath.
 *
 * A pane whose active tab is NOT a chat (an artifact, a diff) spends both
 * slots on history instead - that is the reported close-a-second-tab case,
 * where the chat has to survive while something else holds the foreground.
 */
export const RETAINED_PANE_CHAT_CAP = 2;

export interface RetainedPaneChatInstancesInput {
  readonly pane: TilePane;
  /**
   * Resolves an instance id to its tile, or `undefined` when this pane's
   * canvas does not hold one. The two call sites look tiles up differently
   * (membership has the canvas-wide `tilesByInstanceId` record; the pane hook
   * has its own resolved ref list), but both must answer the SAME kind
   * question - so the predicate itself lives here, not in the caller.
   */
  readonly tileFor: (instanceId: string) => EpicCanvasTileRef | undefined;
  readonly cap: number;
}

/**
 * The retained chat instance ids for one pane, most-recently-active first.
 *
 * The resolved active tab seeds the order rather than `activationHistory[0]`:
 * `resolveActivePaneTab` falls back to `tabInstanceIds[0]` for a pane whose
 * `activeTabId` never resolved, and that fallback tab can legitimately have
 * no activation record yet. Whatever the pane actually SHOWS must never be
 * evicted by its own retention policy.
 */
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
