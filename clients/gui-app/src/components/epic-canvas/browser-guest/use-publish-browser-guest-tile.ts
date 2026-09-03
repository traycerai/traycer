import { useLayoutEffect, useRef, type RefObject } from "react";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import {
  browserGuestCssAnchorName,
  clearBrowserGuestTilePlacement,
  setBrowserGuestTilePlacement,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";
import {
  rectFromDomRect,
  registerBrowserOverlayTile,
  updateBrowserOverlayTileRect,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";

export function usePublishBrowserGuestTile(input: {
  readonly surfaceRef: RefObject<HTMLElement | null>;
  readonly registrationId: string;
  readonly instanceId: string;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly presented: boolean;
  readonly tileKey: BrowserViewTileKey | null;
}): void {
  const ownerRef = useRef(Symbol("browser-guest-tile"));
  const {
    presented,
    registrationId,
    instanceId,
    surfaceRef,
    viewTabId,
    paneId,
    tileKey,
  } = input;
  const anchorName = browserGuestCssAnchorName(registrationId);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (surface !== null) {
      surface.style.setProperty("anchor-name", anchorName);
    }
    const owner = ownerRef.current;
    setBrowserGuestTilePlacement(owner, {
      registrationId,
      instanceId,
      viewTabId,
      paneId,
      presented,
    });
    return () => {
      if (
        surface !== null &&
        surface.style.getPropertyValue("anchor-name") === anchorName
      ) {
        surface.style.removeProperty("anchor-name");
      }
      clearBrowserGuestTilePlacement(owner, registrationId);
    };
  }, [
    anchorName,
    instanceId,
    paneId,
    presented,
    registrationId,
    surfaceRef,
    viewTabId,
  ]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null || tileKey === null || !presented) return;
    const unregister = registerBrowserOverlayTile({
      key: tileKey,
      rect: rectFromDomRect(surface.getBoundingClientRect()),
    });
    const observer = new ResizeObserver(() => {
      updateBrowserOverlayTileRect(
        tileKey,
        rectFromDomRect(surface.getBoundingClientRect()),
      );
    });
    observer.observe(surface);
    return () => {
      observer.disconnect();
      unregister();
    };
  }, [presented, surfaceRef, tileKey]);
}
