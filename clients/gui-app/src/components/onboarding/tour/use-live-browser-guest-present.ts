import { useSyncExternalStore } from "react";
import {
  listTileRects,
  subscribeTileRects,
} from "@/lib/browser-view/tiles/tile-rect-registry";

/**
 * Whether any local browser tile with a LIVE guest is on screen - the same
 * registrations the toaster anchor consults (`tile-rect-registry`: a tile
 * registers while its guest is presented, and a start page is not one).
 *
 * The guest is a native WebContentsView painted above the DOM, so the
 * spotlight's dim cannot cover it: every DOM part of the tile dims and the
 * page stays at full brightness with a hard seam under the address bar.
 * While one is up the tour keeps the lesson but drops the spotlight (hole
 * and dim) for the unanchored card; the spotlight returns when the last
 * live guest leaves the screen. A boolean snapshot, so the store only
 * re-renders the tour on the set becoming empty or non-empty.
 */
export function useLiveBrowserGuestPresent(): boolean {
  return useSyncExternalStore(
    subscribeTileRects,
    readLiveBrowserGuestPresent,
    readLiveBrowserGuestPresent,
  );
}

function readLiveBrowserGuestPresent(): boolean {
  return listTileRects().length > 0;
}
