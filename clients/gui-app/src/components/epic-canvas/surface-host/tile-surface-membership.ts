/**
 * Pick the retained-chat window by tile kind, then apply eligibility to the result - injecting eligibility into selection would shift the capped window and strand a body.
 * Freeze membership for the whole in-flight tab-command transaction; header tear-off is not one-store atomic.
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
 * Layer 1 (pure, standalone-testable): every chat `instanceId` a pane keeps alive - shown or recently-active - across the complete `canvasByTabId` snapshot, mapped to the top-level tab id that owns it.
 */
export function collectCanvasWideRetainedChatMembership(
  canvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>,
): ReadonlyMap<string, string> {
  const instanceIdToTabId = new Map<string, string>();
  for (const [tabId, canvas] of Object.entries(canvasByTabId)) {
    if (canvas === undefined) continue;
    for (const pane of collectPanes(canvas.root)) {
      // The WINDOW is picked on tile kind alone, identically to `use-mounted-pane-tabs.ts`.
      // Eligibility is applied to the result, AFTER the cap - injecting it into the selection would shift this window relative to the render side's and strand a member with no slot (cold review F1; see `retained-pane-chats.ts`).
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
 * Recomputed with the exact same shared algorithm `TopLevelTabHost` uses - one global MRU/cap decision across every kind, never a per-kind one.
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
 * While the coordinator has an in-flight transaction, membership is left exactly as it was at the last settled snapshot - not recomputed at all.
 * Header tear-off's canvas write (which moves a tile to a brand-new, not-yet-in-the-header-strip top-level tab id) synchronously notifies both `useEpicCanvasStore` and, later in the same transaction, `useTabsStore`; recomputing mid-transaction would read a real but momentarily inconsistent snapshot (the tile's new owner exists in one store and not yet the other) and could evict it.
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
