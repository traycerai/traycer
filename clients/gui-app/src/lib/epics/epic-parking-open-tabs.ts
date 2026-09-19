/**
 * The open-tab side of renderer parking AND of session membership: it mirrors
 * this window's open epic tabs into `lib/epics/epic-parking.ts`, which owns the
 * clock and the release, and into `lib/registries/epic-session-controller.ts`,
 * which owns which epics have a session at all.
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
import { getEpicSessionController } from "@/lib/registries/epic-session-controller";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/**
 * The open tab ids of every epic with at least one OPEN tab in this window -
 * the same projection `releaseOpenEpicSessionIfUnused` reads to decide whether
 * a session still has a tab. `tabsById` retains CLOSED tabs so their canvases
 * can be restored, so the order list is the authority and the record map is
 * only the lookup.
 *
 * ONE projection, two consumers: parking mirrors the epic SET (it owns a clock
 * per epic), and the session controller takes the per-epic TAB IDS (it owns
 * membership, and desktop ownership is claimed per tab). Deriving both from
 * one walk is what makes every way a tab appears or leaves - background open,
 * restore, duplicate, draft swap, close, window transfer - reach both.
 */
function openEpicTabIds(): ReadonlyMap<string, ReadonlyArray<string>> {
  const state = useEpicCanvasStore.getState();
  const open = new Map<string, string[]>();
  for (const tabId of state.openTabOrder) {
    const epicId = state.tabsById[tabId]?.epicId;
    if (epicId === undefined) continue;
    const tabIds = open.get(epicId);
    if (tabIds === undefined) open.set(epicId, [tabId]);
    else tabIds.push(tabId);
  }
  return open;
}

function syncOpenEpicTabs(): void {
  const open = openEpicTabIds();
  // Parking FIRST: the controller reads `isEpicParked` while it reconciles a
  // new membership, and an epic the parking module has not heard of yet has
  // no entry to answer from.
  syncEpicParkingOpenTabs(new Set(open.keys()));
  getEpicSessionController().syncOpenTabs(open);
}

/**
 * Re-derive the parking entry set and the controller's membership from the
 * canvas store. A test seam.
 */
export function __syncEpicParkingOpenTabsForTests(): void {
  syncOpenEpicTabs();
}

// The canvas store notifies on far more than tab opens and closes (every tile
// move, every pending title), so the sync is written to be cheap and
// idempotent rather than gated on this edge being meaningful - it is a set
// walk over the open order plus a walk over the parking entries.
useEpicCanvasStore.subscribe(syncOpenEpicTabs);
syncOpenEpicTabs();
