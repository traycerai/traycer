import { useLayoutEffect, useState, type RefObject } from "react";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import {
  browserGuestCssAnchorName,
  browserGuestCssClipAnchorName,
  browserGuestCssClipSizeAnchorName,
  clearBrowserGuestTilePlacement,
  setBrowserGuestTilePlacement,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";
import {
  notifyTileRects,
  registerTileRect,
} from "@/lib/browser-view/tiles/tile-rect-registry";

export function usePublishBrowserGuestTile(input: {
  readonly surfaceRef: RefObject<HTMLElement | null>;
  readonly stageRef: RefObject<HTMLElement | null> | null;
  readonly registrationId: string;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly scale: number;
    readonly autoFit: boolean;
  } | null;
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
    stageRef,
    viewTabId,
    paneId,
    tileKey,
    viewport,
  } = input;
  const anchorName = browserGuestCssAnchorName(registrationId);
  const clipAnchorName = browserGuestCssClipAnchorName(registrationId);
  const clipSizeAnchorName = browserGuestCssClipSizeAnchorName(registrationId);
  const width = viewport?.width ?? null;
  const height = viewport?.height ?? null;
  const scale = viewport?.scale ?? null;
  const autoFit = viewport?.autoFit ?? true;

  useLayoutEffect(() => {
    const stage = stageRef?.current;
    if (stage === undefined || stage === null) return;
    stage.style.setProperty("anchor-name", clipAnchorName);
    stage.style.setProperty("--browser-clip-size-anchor", clipSizeAnchorName);
    return () => {
      if (stage.style.getPropertyValue("anchor-name") === clipAnchorName)
        stage.style.removeProperty("anchor-name");
      if (
        stage.style.getPropertyValue("--browser-clip-size-anchor") ===
        clipSizeAnchorName
      )
        stage.style.removeProperty("--browser-clip-size-anchor");
    };
  }, [clipAnchorName, clipSizeAnchorName, presented, stageRef]);

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
      viewport:
        width === null || height === null || scale === null
          ? null
          : { width, height, scale, autoFit },
    });
  }, [
    anchorName,
    instanceId,
    owner,
    paneId,
    presented,
    registrationId,
    surfaceRef,
    viewTabId,
    width,
    height,
    scale,
    autoFit,
  ]);

  // Geometry updates keep the guest bound. Only identity loss/unmount releases
  // its placement; an effect cleanup per resize would briefly park it offscreen.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    return () => {
      if (surface?.style.getPropertyValue("anchor-name") === anchorName)
        surface.style.removeProperty("anchor-name");
      clearBrowserGuestTilePlacement(owner, registrationId);
    };
  }, [anchorName, owner, registrationId, surfaceRef]);

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
