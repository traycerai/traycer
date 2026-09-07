import { use, useEffect } from "react";
import {
  clearBrowserViewSnapshot,
  listBrowserOverlayElements,
  listBrowserOverlaySurfaces,
  listBrowserOverlayTiles,
  markBrowserViewSnapshotStale,
  resolveBrowserOverlayMotionTargets,
  resolveBrowserOverlayOcclusionTargets,
  setBrowserViewSnapshot,
  subscribeBrowserOverlayLayout,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { registerReservedBrowserChords } from "@/lib/browser-view/reserved-chords-registration";
import type {
  BrowserViewBridge,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostContext } from "@/providers/runner-host-context";

export function BrowserOverlayCoordinatorBridge() {
  const runnerHost = use(RunnerHostContext);
  useEffect(() => {
    // BT-303: app chords outrank guest keystrokes; main replaces its whole
    // set on each call, so this is idempotent across HMR.
    if (runnerHost !== null) registerReservedBrowserChords(runnerHost);
  }, [runnerHost]);
  const browserView = runnerHost?.browserView ?? null;
  return <BrowserOverlayCoordinator browserView={browserView} />;
}

function BrowserOverlayCoordinator(props: {
  readonly browserView: BrowserViewBridge | null;
}): null {
  useEffect(() => {
    const browserView = props.browserView;
    if (browserView === null) return;

    const activeSignaturesByOverlayId = new Map<string, string>();
    const ackedOverlayIds = new Set<string>();
    let frameId: number | null = null;
    let disposed = false;

    /**
     * BT-202 flicker fix, phase 2: the native view must not leave the screen
     * until the replacement frame is DECODED and COMPOSITED. We wait one
     * frame (commit), wait for every snapshot <img> to settle decoding, one
     * more frame (paint), then ack — main moves the view offscreen only after
     * this resolves.
     */
    const ackWhenPainted = async (overlayId: string): Promise<void> => {
      if (ackedOverlayIds.has(overlayId)) return;
      ackedOverlayIds.add(overlayId);
      try {
        const waitFrame = () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        const decodeAll = () =>
          Promise.all(
            Array.from(
              document.querySelectorAll<HTMLImageElement>(
                "[data-browser-view-snapshot] img",
              ),
            ).map((img) =>
              typeof img.decode === "function"
                ? img.decode().catch(() => undefined)
                : Promise.resolve(),
            ),
          );
        await waitFrame();
        await decodeAll();
        await waitFrame();
        await browserView.overlayPaintAck(overlayId);
      } catch {
        // A failed ack must never break the occlusion lifecycle; the view
        // simply stays live until release.
      } finally {
        ackedOverlayIds.delete(overlayId);
      }
    };

    const applyRestoredTiles = (tiles: readonly BrowserViewTileKey[]): void => {
      tiles.forEach((tile) => {
        clearBrowserViewSnapshot(tile);
      });
    };

    const scheduleScan = (): void => {
      if (disposed) return;
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        runScan();
      });
    };

    const releaseOverlay = (overlayId: string): void => {
      activeSignaturesByOverlayId.delete(overlayId);
      void browserView
        .releaseOverlay({ overlayId })
        .then((result) => {
          if (disposed) return;
          applyRestoredTiles(result.restoredTiles);
        })
        .catch(ignoreError);
    };

    const runScan = (): void => {
      const tiles = listBrowserOverlayTiles();
      // Invariant 8: motion is a second freeze input to this same state
      // machine, not a parallel one - a moving tile's synthetic owner runs
      // through the exact per-owner occlude/release/ack path below, so it
      // gets the capturePage stand-in, paint-ack and exit handshake for
      // free. It never touches `resolveBrowserOverlayOcclusionTargets`
      // (there is no overlay rect to intersect for a motion owner).
      const targets = [
        ...resolveBrowserOverlayOcclusionTargets(
          listBrowserOverlaySurfaces(),
          tiles,
        ),
        ...resolveBrowserOverlayMotionTargets(tiles),
      ];
      const nextTargetsByOverlayId = new Map(
        targets.map((target) => [target.overlayId, target]),
      );

      // Occlude before release: main-process release is synchronous while
      // occlude is async, so releasing first can un-park a tile that another
      // overlay in this same scan still covers for the duration of that
      // overlay's occludeForOverlay round trip. A tile must stay parked
      // across an ownership handoff between overlays, never revealed in
      // between - so occlusion for the still-active overlays goes out before
      // any release for the ones that dropped out.
      targets.forEach((target) => {
        if (
          activeSignaturesByOverlayId.get(target.overlayId) === target.signature
        ) {
          return;
        }
        // Latched up front so the in-flight call is not repeated by the next
        // scan, and dropped again whenever the occlusion did not take: a
        // rejected call, or one that matched no tile in main (a scan racing
        // tile teardown or rebind). Keeping the signature there would make
        // that miss permanent - the tile would stay live under the overlay
        // until the overlay closed.
        activeSignaturesByOverlayId.set(target.overlayId, target.signature);
        const forgetSignature = (): void => {
          if (
            activeSignaturesByOverlayId.get(target.overlayId) ===
            target.signature
          ) {
            activeSignaturesByOverlayId.delete(target.overlayId);
          }
        };
        void browserView
          .occludeForOverlay({
            overlayId: target.overlayId,
            tiles: target.tiles,
          })
          .then((result) => {
            if (disposed) return;
            // A PARTIAL match is a miss too: the tiles that did match are
            // occluded and keep their frames, but the ones that did not stay
            // live under the overlay. Dropping the signature is what lets the
            // next layout notification (tile registration, rebind) retry them
            // - keeping it latched would compute the same signature and
            // return early until the overlay closed.
            if (result.matchedCount < target.tiles.length) forgetSignature();
            // Before the zero-match return, not after it: an occlusion that
            // parked NOTHING can still have RESTORED something. Main runs its
            // own diff-release on every `occlude()` call, so a tile this
            // overlay used to cover and no longer targets comes back in
            // `restoredTiles` even when every tile in the new set missed.
            // Returning first would strand that tile under a stale stand-in.
            applyRestoredTiles(result.restoredTiles);
            if (result.matchedCount === 0) return;
            result.snapshots.forEach((snapshot) => {
              setBrowserViewSnapshot(snapshot);
            });
            void ackWhenPainted(target.overlayId);
          })
          .catch((error: unknown) => {
            forgetSignature();
            ignoreError(error);
          });
      });

      activeSignaturesByOverlayId.forEach((_signature, overlayId) => {
        if (!nextTargetsByOverlayId.has(overlayId)) releaseOverlay(overlayId);
      });
    };

    const invalidationSubscription = browserView.onSnapshotInvalidated(
      markBrowserViewSnapshotStale,
    );
    // Invariant 4 (ticket 04): a tile that WAS parked cannot answer
    // `restoredTiles` synchronously - its stand-in stays mounted until this
    // fires, on the un-parked view's first composited frame.
    const restoreSubscription = browserView.onOverlayTileRestored((tile) => {
      applyRestoredTiles([tile]);
    });
    // Registration reports mount/unmount; it cannot report the predicate's
    // own inputs (`class`, `data-state`, `hidden`, `style`) moving on an
    // already-registered element without a React render (a Radix fade-out,
    // a `hidden` toggle). So the observer stays, re-targeted to exactly the
    // currently-registered elements on every layout change instead of the
    // whole `document.body` subtree the old scan needed to find overlays at
    // all.
    const mutationObserver = new MutationObserver(scheduleScan);
    const observeRegisteredElements = (): void => {
      mutationObserver.disconnect();
      listBrowserOverlayElements().forEach((element) => {
        mutationObserver.observe(element, {
          attributes: true,
          attributeFilter: ["class", "data-state", "hidden", "style"],
          // Descendant growth (e.g. sonner's inner `<ol>` mounting once a
          // toast exists) must trigger a rescan too - a handful of
          // registered elements, not `document.body`, so subtree is cheap
          // here.
          childList: true,
          subtree: true,
        });
      });
    };
    // The layout channel also fires on every tile rect move (a drag), which
    // re-observes a handful of already-registered elements each time - cheap
    // (disconnect/observe do no DOM work of their own), so no separate
    // registration-only channel is worth the extra plumbing.
    const unsubscribeLayout = subscribeBrowserOverlayLayout(() => {
      observeRegisteredElements();
      scheduleScan();
    });
    observeRegisteredElements();
    window.addEventListener("resize", scheduleScan, { passive: true });
    window.addEventListener("scroll", scheduleScan, true);
    scheduleScan();

    return () => {
      disposed = true;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      unsubscribeLayout();
      invalidationSubscription.dispose();
      restoreSubscription.dispose();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleScan);
      window.removeEventListener("scroll", scheduleScan, true);
      activeSignaturesByOverlayId.forEach((_signature, overlayId) => {
        void browserView
          .releaseOverlay({ overlayId })
          .then((result) => {
            applyRestoredTiles(result.restoredTiles);
          })
          .catch(ignoreError);
      });
      activeSignaturesByOverlayId.clear();
    };
  }, [props.browserView]);

  return null;
}
