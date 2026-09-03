import { useLayoutEffect, useRef, type RefObject } from "react";
import {
  browserGuestCssAnchorName,
  clearBrowserGuestTilePlacement,
  setBrowserGuestTilePlacement,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";

export function usePublishBrowserGuestTile(input: {
  readonly surfaceRef: RefObject<HTMLElement | null>;
  readonly registrationId: string;
  readonly instanceId: string;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly presented: boolean;
}): void {
  const ownerRef = useRef(Symbol("browser-guest-tile"));
  const {
    presented,
    registrationId,
    instanceId,
    surfaceRef,
    viewTabId,
    paneId,
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
}
