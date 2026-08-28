/**
 * Ticket 21 slice 2: the canvas-wide, transaction-aware set of chat
 * `instanceId`s a stable tile surface host must keep painted.
 *
 * Three layers, matching the design (`ticket-21-stable-tile-surface-identity`,
 * "Host membership and lifecycle"):
 *
 * 1. Canvas-wide RETAINED identity - the chat tiles each pane, across every
 *    open top-level tab's canvas, keeps alive: the one it currently shows,
 *    plus the recently-active ones its `activationHistory` still names, up to
 *    `RETAINED_PANE_CHAT_CAP`. Uses the same `resolveActivePaneTab` fallback
 *    the renderer uses, so a chat `TabGroupView` paints is never omitted from
 *    membership.
 *
 *    This layer used to admit the SELECTED chat only, which made an inner
 *    pane tab switch a real unmount (decision #17) and left the reader
 *    watching the transcript re-converge on the way back. Retention is
 *    derived through the shared `retainedPaneChatInstanceIds` policy, and -
 *    critically - the WINDOW is picked on tile kind alone, with eligibility
 *    applied to its RESULT below. Injecting eligibility into the selection
 *    would not narrow this set relative to `use-mounted-pane-tabs.ts`'s; it
 *    would SHIFT it, because the window is capped and rejection keeps filling
 *    (cold review F1). A member the pane therefore never slots does not
 *    mispaint - a selected chat is seeded first on both sides, so the
 *    shifted-in id can never carry a stale `tabSelected: true` - it strands:
 *    its record keeps a non-null environment and the sticky `canMountBody`
 *    latch, so the hosted body stays mounted forever on a disconnected
 *    anchor, invisible and holding an unreclaimable chat session lease.
 * 2. Top-level retained-surface/MRU eligibility - a chat's owning top-level
 *    tab must also be one of the retained top-level surfaces. This reuses
 *    `TopLevelTabHost`'s actual recency/cap algorithm, extracted into
 *    `stores/tabs/top-level-surface-retention.ts` as a shared pure module, so
 *    both the render-time host and this store-driven mirror apply exactly
 *    one global cap across every top-level kind (epic, draft, history,
 *    settings) - never a per-kind cap.
 * 3. Transaction-aware retention - header tear-off is not one-store atomic
 *    (`tearOffTabIntoNewHeaderTab` commits `EpicCanvasStore` synchronously;
 *    `tabCommandCoordinator` places the new header ref in `useTabsStore`
 *    moments later, in the same transaction). Mid-transaction, the tile's new
 *    owning top-level tab id can exist in `EpicCanvasStore` before it exists
 *    in `useTabsStore`'s header strip - recomputing at that instant would
 *    read a real but momentarily inconsistent cross-store snapshot and could
 *    evict it. So membership is entirely FROZEN (not recomputed at all)
 *    while the coordinator's ledger shows an in-flight transaction, and
 *    reconciles - additions and MRU eviction alike - exactly once, from the
 *    coordinator's own settle notification.
 *
 * Membership is recomputed and diffed on every notification from
 * `useEpicCanvasStore`, `useTabsStore`, `tabCommandCoordinator`, and
 * `remote-deleted-chat-registry.ts` - deriving from observed state at each
 * checkpoint rather than trusting any one store's change to imply the others
 * are consistent (the same observation-over-claim lesson slice 1's identity
 * machinery learned the hard way).
 *
 * A selected chat also has to pass `isHostedSurfaceEligible` (shared with
 * `surface-owner.ts`'s render-routing decision - design-review slice-4
 * finding 2) - a remote-deleted chat leaves membership the same instant
 * `ActiveTabBody` reports it, so the registry entry it's holding gets cleared
 * by slice 2's existing membership-loss subscription instead of lingering
 * alongside the inline `DeletedArtifactBody`.
 */
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import {
  RETAINED_PANE_CHAT_CAP,
  retainedPaneChatInstanceIds,
} from "@/stores/epics/canvas/retained-pane-chats";
import { useTabsStore } from "@/stores/tabs/store";
import { flattenStripItemRefs, tabRefKey } from "@/stores/tabs/layout";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  advanceTopLevelSurfaceRecency,
  retainedTopLevelSurfaceKeys,
} from "@/stores/tabs/top-level-surface-retention";
import { isHostedSurfaceEligible } from "@/components/epic-canvas/surface-host/surface-owner";
import {
  isChatRemoteDeleted,
  subscribeChatRemoteDeletion,
} from "@/components/epic-canvas/surface-host/remote-deleted-chat-registry";

export type SurfaceMembershipListener = () => void;

/**
 * Layer 1 (pure, standalone-testable): every chat `instanceId` a pane keeps
 * alive - shown or recently-active - across the complete `canvasByTabId`
 * snapshot, mapped to the top-level tab id that owns it.
 */
export function collectCanvasWideRetainedChatMembership(
  canvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>,
): ReadonlyMap<string, string> {
  const instanceIdToTabId = new Map<string, string>();
  for (const [tabId, canvas] of Object.entries(canvasByTabId)) {
    if (canvas === undefined) continue;
    for (const pane of collectPanes(canvas.root)) {
      // The WINDOW is picked on tile kind alone, identically to
      // `use-mounted-pane-tabs.ts`. Eligibility is applied to the result,
      // AFTER the cap - injecting it into the selection would shift this
      // window relative to the render side's and strand a member with no slot
      // (cold review F1; see `retained-pane-chats.ts`).
      const retained = retainedPaneChatInstanceIds({
        pane,
        cap: RETAINED_PANE_CHAT_CAP,
        tileFor: (instanceId) => canvas.tilesByInstanceId[instanceId],
      });
      for (const instanceId of retained) {
        const tile = canvas.tilesByInstanceId[instanceId];
        if (tile === undefined) continue;
        if (
          !isHostedSurfaceEligible({
            node: tile,
            isRemoteDeleted: isChatRemoteDeleted(instanceId),
          })
        ) {
          continue;
        }
        instanceIdToTabId.set(instanceId, tabId);
      }
    }
  }
  return instanceIdToTabId;
}

/**
 * Layer 2: the kind-qualified `TabRef` keys (the same `"<kind>:<id>"` format
 * `tabRefKey` produces) currently eligible to retain a hosted surface, given
 * every open top-level tab strip and which refs are presently active.
 * Recomputed with the exact same shared algorithm `TopLevelTabHost` uses -
 * one global MRU/cap decision across every kind, never a per-kind one.
 */
function computeRetainedTopLevelRefKeys(): ReadonlyArray<string> {
  const { items, activeItemId } = useTabsStore.getState();
  const headerTabs = getHeaderTabs();
  const knownRefKeys = new Set(headerTabs.map(tabRefKey));
  const availableRefKeys = items
    .flatMap(flattenStripItemRefs)
    .map(tabRefKey)
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .filter((key) => knownRefKeys.has(key));
  const activeItem = items.find((item) => item.id === activeItemId) ?? null;
  const activeRefKeys =
    activeItem === null
      ? []
      : flattenStripItemRefs(activeItem)
          .map(tabRefKey)
          .filter((key) => knownRefKeys.has(key));

  topLevelRecency = advanceTopLevelSurfaceRecency(
    activeRefKeys,
    topLevelRecency,
  );
  return retainedTopLevelSurfaceKeys(
    availableRefKeys,
    activeRefKeys,
    topLevelRecency,
  );
}

let topLevelRecency: ReadonlyArray<string> = [];
let currentMembership: ReadonlySet<string> = new Set();
const listeners = new Set<SurfaceMembershipListener>();

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

/**
 * While the coordinator has an in-flight transaction, membership is left
 * exactly as it was at the last settled snapshot - not recomputed at all.
 * Header tear-off's canvas write (which moves a tile to a brand-new,
 * not-yet-in-the-header-strip top-level tab id) synchronously notifies both
 * `useEpicCanvasStore` and, later in the same transaction, `useTabsStore`;
 * recomputing mid-transaction would read a real but momentarily
 * inconsistent snapshot (the tile's new owner exists in one store and not
 * yet the other) and could evict it. Freezing avoids that by construction -
 * the correct post-transaction membership is derived fresh, exactly once,
 * from the coordinator's own settle notification.
 */
function recomputeMembership(): void {
  if (tabCommandCoordinator.getLedger().suppressionDepth > 0) return;

  const retainedRefKeys = new Set(computeRetainedTopLevelRefKeys());
  const instanceIdToTabId = collectCanvasWideRetainedChatMembership(
    useEpicCanvasStore.getState().canvasByTabId,
  );
  const nextMembership = new Set<string>();
  for (const [instanceId, tabId] of instanceIdToTabId) {
    if (retainedRefKeys.has(tabRefKey({ kind: "epic", id: tabId }))) {
      nextMembership.add(instanceId);
    }
  }

  if (setsEqual(nextMembership, currentMembership)) return;
  currentMembership = nextMembership;
  listeners.forEach((listener) => listener());
}

/** The chat `instanceId`s a stable tile surface host should keep mounted. */
export function getTileSurfaceMembership(): ReadonlySet<string> {
  return currentMembership;
}

export function subscribeTileSurfaceMembership(
  listener: SurfaceMembershipListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetTileSurfaceMembershipForTesting(): void {
  topLevelRecency = [];
  currentMembership = new Set();
  recomputeMembership();
}

useEpicCanvasStore.subscribe(recomputeMembership);
useTabsStore.subscribe(recomputeMembership);
useLandingDraftStore.subscribe(recomputeMembership);
tabCommandCoordinator.subscribe(recomputeMembership);
subscribeChatRemoteDeletion(recomputeMembership);
recomputeMembership();
