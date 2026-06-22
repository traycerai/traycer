import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type {
  ScrollRestorationAdapter,
  TileScrollAnchor,
} from "@/hooks/scroll/scroll-restoration-adapter";
import { useTileScrollAnchorStore } from "@/stores/epics/canvas/tile-scroll-anchor-store";
import { isEpicCanvasTileInstanceLive } from "@/stores/epics/canvas/tile-instance-liveness";

/** Frames to keep retrying a restore while content is still laying out. */
const MAX_RESTORE_FRAMES = 8;

interface RetryState {
  rafId: number;
  frame: number;
}

/**
 * Preserve and restore a tile's scroll position across keep-alive hiding and a
 * full unmount/remount within the session.
 *
 * Capture is CONTINUOUS, not on-hide. The browser zeroes `scrollTop` the moment
 * a container goes `display:none`, and that happens in the same commit as the
 * `visible -> false` prop change - before any layout effect runs. So the
 * adapter reads from a ref it keeps fresh on every scroll; this hook only
 * decides WHEN to copy that ref into the session store (on hide and on unmount)
 * and WHEN to apply it back (on show, and once async content is ready).
 *
 * `visible` is `paneVisible && tabSelected`. `contentReady` gates the
 * remount/async path so restore waits until the surface actually has content to
 * scroll (messages loaded, diff fetched, file read).
 */
export function useScrollRestoration(
  instanceId: string,
  adapter: ScrollRestorationAdapter,
  visible: boolean,
  contentReady: boolean,
): () => void {
  // Kept fresh in a layout effect (writing a ref during render trips the React
  // Compiler's `react-hooks/refs` rule); adapters are stable so it never churns.
  const adapterRef = useRef(adapter);
  useLayoutEffect(() => {
    adapterRef.current = adapter;
  }, [adapter]);

  const wasVisibleRef = useRef(visible);
  const mountedRef = useRef(false);
  const restoredRef = useRef(false);
  const retryRef = useRef<RetryState>({ rafId: 0, frame: 0 });

  const cancelRetry = useCallback((): void => {
    if (retryRef.current.rafId !== 0) {
      cancelAnimationFrame(retryRef.current.rafId);
      retryRef.current.rafId = 0;
    }
    retryRef.current.frame = 0;
  }, []);

  const commit = useCallback((): void => {
    const anchor = adapterRef.current.captureAnchor();
    if (anchor !== null) {
      useTileScrollAnchorStore.getState().setAnchor(instanceId, anchor);
    }
  }, [instanceId]);

  // On unmount we save ONLY if the tile is still live (LRU eviction / hide for
  // reopen). A permanent close removes the tile from the canvas first, which
  // synchronously fires the store's anchor sweep (see `store.ts`); guarding the
  // save here is what stops this later cleanup from resurrecting that anchor.
  // Clearing is the sweep's job alone - the hook never clears.
  const commitIfTileLive = useCallback((): void => {
    if (isEpicCanvasTileInstanceLive(instanceId)) commit();
  }, [commit, instanceId]);

  const runRestore = useCallback((): void => {
    if (restoredRef.current) return;
    if (retryRef.current.rafId !== 0) return; // a retry loop is already in flight
    const anchor = useTileScrollAnchorStore.getState().getAnchor(instanceId);
    if (anchor === undefined) {
      restoredRef.current = true;
      return;
    }
    const result = adapterRef.current.applyAnchor(anchor);
    if (result === "retry" || result === "defend") {
      scheduleRestoreRetry(adapterRef, retryRef, restoredRef, anchor);
      return;
    }
    restoredRef.current = true;
  }, [instanceId]);

  useLayoutEffect(() => {
    const firstRun = !mountedRef.current;
    mountedRef.current = true;
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;

    if (!visible) {
      // Became hidden: snapshot the last-known position so a later show or
      // remount can restore it, and re-arm the restore latch.
      if (!firstRun && wasVisible) commit();
      restoredRef.current = false;
      cancelRetry();
      return;
    }
    // Visible. Restore on first mount while visible, on hidden -> visible, or
    // once `contentReady` flips true (this effect re-runs on that dep).
    if (contentReady) runRestore();
  }, [visible, contentReady, commit, runRestore, cancelRetry]);

  // Final snapshot on unmount (LRU eviction): the DOM node still exists during
  // layout-effect cleanup and the adapter reads its live ref, so the position
  // survives even though nothing transitioned to hidden first.
  useLayoutEffect(() => {
    return () => {
      commitIfTileLive();
      cancelRetry();
    };
  }, [commitIfTileLive, cancelRetry]);

  return cancelRetry;
}

/**
 * Re-attempt `applyAnchor` on the next animation frame while it reports
 * `"retry"` (content still laying out) or `"defend"` (applied but an external
 * autoscroll may overwrite it), bounded by `MAX_RESTORE_FRAMES`. Using rAF (not
 * setTimeout) means each attempt reads layout post-paint, so `scrollHeight` is
 * populated, and does one read + one write per frame.
 */
function scheduleRestoreRetry(
  adapterRef: RefObject<ScrollRestorationAdapter>,
  retryRef: RefObject<RetryState>,
  restoredRef: RefObject<boolean>,
  anchor: TileScrollAnchor,
): void {
  retryRef.current.rafId = requestAnimationFrame(() => {
    retryRef.current.rafId = 0;
    retryRef.current.frame += 1;
    const result = adapterRef.current.applyAnchor(anchor);
    const keepGoing = result === "retry" || result === "defend";
    if (keepGoing && retryRef.current.frame < MAX_RESTORE_FRAMES) {
      scheduleRestoreRetry(adapterRef, retryRef, restoredRef, anchor);
      return;
    }
    restoredRef.current = true;
    retryRef.current.frame = 0;
  });
}
