/**
 * The open-tab side of renderer parking: it mirrors this window's open epic
 * tabs into `lib/epics/epic-parking.ts`, which owns the clock and the release.
 *
 * ## Why this is its own module
 *
 * Parking is keyed on the OPEN TAB rather than on a mounted `EpicSurface`
 * (plan C, C1 fixup 1) - a tab past `retainedTopLevelSurfaces` is unmounted,
 * therefore hidden by definition, and its session sits warm with
 * `epic.subscribe` open. Reading that set means reading the canvas store.
 *
 * The decider itself must NOT read it. `lib/registries/chat-session-registry.ts`
 * imports the decider at module scope to perform the chat half of the release,
 * and that import is reached from anything touching a chat - so a canvas-store
 * import inside the decider would pull a large store into that graph at import
 * time, for every consumer, and every partial `vi.mock` of the canvas store in
 * that graph would start failing at module load rather than at a call. Keeping
 * the projection here leaves the decider a leaf and puts the store dependency
 * in one place, alongside the surface host that owns the retention pool.
 *
 * Subscribing at import, as `tile-surface-membership.ts` does for the same
 * store: the mirror has to be live before any tab opens, and there is exactly
 * one of it per renderer.
 */
import { syncEpicParkingOpenTabs } from "@/lib/epics/epic-parking";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/**
 * The epics with at least one OPEN tab in this window - the same projection
 * `releaseOpenEpicSessionIfUnused` reads to decide whether a session still has
 * a tab. `tabsById` retains CLOSED tabs so their canvases can be restored, so
 * the order list is the authority and the record map is only the lookup.
 */
function openEpicIds(): ReadonlySet<string> {
  const state = useEpicCanvasStore.getState();
  const open = new Set<string>();
  for (const tabId of state.openTabOrder) {
    const epicId = state.tabsById[tabId]?.epicId;
    if (epicId !== undefined) open.add(epicId);
  }
  return open;
}

function syncOpenEpicTabs(): void {
  syncEpicParkingOpenTabs(openEpicIds());
}

/** Re-derive the parking entry set from the canvas store. A test seam. */
export function __syncEpicParkingOpenTabsForTests(): void {
  syncOpenEpicTabs();
}

// The canvas store notifies on far more than tab opens and closes (every tile
// move, every pending title), so the sync is written to be cheap and
// idempotent rather than gated on this edge being meaningful - it is a set
// walk over the open order plus a walk over the parking entries.
useEpicCanvasStore.subscribe(syncOpenEpicTabs);
syncOpenEpicTabs();
