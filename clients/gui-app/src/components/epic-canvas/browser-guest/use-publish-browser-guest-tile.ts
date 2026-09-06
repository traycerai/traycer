import { useLayoutEffect, useState, type RefObject } from "react";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import {
  browserGuestCssAnchorName,
  clearBrowserGuestTilePlacement,
  setBrowserGuestTilePlacement,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";
import {
  notifyTileRects,
  registerTileRect,
} from "@/lib/browser-view/tiles/tile-rect-registry";

export function usePublishBrowserGuestTile(input: {
  readonly surfaceRef: RefObject<HTMLElement | null>;
  readonly registrationId: string;
  readonly instanceId: string;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly presented: boolean;
  readonly tileKey: BrowserViewTileKey | null;
}): void {
  const [owner] = useState(() => Symbol("browser-guest-tile"));
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
    owner,
    paneId,
    presented,
    registrationId,
    surfaceRef,
    viewTabId,
  ]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null || tileKey === null || !presented) return;
    const unregister = registerTileRect(tileKey, surface);
    const observer = new ResizeObserver(notifyTileRects);
    observer.observe(surface);
    return () => {
      observer.disconnect();
      unregister();
    };
  }, [presented, surfaceRef, tileKey]);
}
