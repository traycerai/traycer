import { useEffect, type RefObject } from "react";
import {
  rectFromDomRect,
  registerBrowserOverlayTile,
  updateBrowserOverlayTileRect,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import type {
  BrowserViewBounds,
  BrowserViewBridge,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";

interface UseBrowserViewBoundsBridgeArgs {
  readonly browserView: BrowserViewBridge | null;
  readonly surfaceRef: RefObject<HTMLDivElement | null>;
  readonly tileKey: BrowserViewTileKey;
  readonly visible: boolean;
}

/**
 * Shared bounds + overlay-registry bridge for every Electron tile.
 * Both user and agent tiles punch through popovers unless the overlay
 * coordinator knows their live rect, so this hook is capability-agnostic.
 *
 * Bounds stream CONTINUOUSLY, including through panel resize drags (BT-102):
 * the previous behavior froze sends while the layout's resizing class was on
 * `<html>`, which left the native view at its pre-drag rect compositing over
 * neighboring tiles until pointer-up. Every ResizeObserver tick updates the
 * overlay registry immediately and hands an rAF-coalesced rect to the main
 * process, which drops redundant geometry itself (BT-101). The one-frame IPC
 * trail this produces during a drag is the accepted physics of the
 * WebContentsView architecture (ADR 0001 R1); re-tune only if BT-103
 * measurement shows guest relayout jank at display rate.
 */
export function useBrowserViewBoundsBridge(
  args: UseBrowserViewBoundsBridgeArgs,
): void {
  const { browserView, surfaceRef, tileKey, visible } = args;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (browserView === null || surface === null || !visible) return;
    const unregisterOverlayTile = registerBrowserOverlayTile({
      key: tileKey,
      rect: rectFromDomRect(surface.getBoundingClientRect()),
    });

    let frameId: number | null = null;

    const sendBounds = (): void => {
      const rect = surface.getBoundingClientRect();
      const bounds = readElementBounds(rect);
      if (bounds.width <= 0 || bounds.height <= 0) return;
      updateBrowserOverlayTileRect(tileKey, rectFromDomRect(rect));
      // Cancel-and-reschedule so a burst of RO ticks during one frame sends
      // only the newest rect (latest-wins), never a superseded one.
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        void browserView
          .updateBounds({ ...tileKey, bounds })
          .catch(ignoreError);
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      sendBounds();
    });
    resizeObserver.observe(surface);
    window.addEventListener("resize", handleWindowResize, { passive: true });
    sendBounds();

    function handleWindowResize(): void {
      sendBounds();
    }

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      unregisterOverlayTile();
    };
  }, [browserView, surfaceRef, tileKey, visible]);
}

function readElementBounds(rect: DOMRectReadOnly): BrowserViewBounds {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}
