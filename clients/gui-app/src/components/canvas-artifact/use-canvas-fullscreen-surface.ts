import { useEffect, useLayoutEffect } from "react";
import {
  claimFullscreen,
  isFullscreenBlocked,
  releaseFullscreen,
  type FullscreenClaim,
} from "@/lib/sandbox/overlay-owner";
/** Promote the existing canvas DOM; moving an iframe into a dialog reloads it. */
export function useCanvasFullscreenSurface(
  surface: HTMLDivElement | null,
  active: boolean,
  onClose: () => void,
): void {
  useLayoutEffect(() => {
    const element = surface;
    if (!active || element === null) return;
    const claim: FullscreenClaim = {
      exit: () => onClose(),
      pinnedRowKey: null,
    };
    if (!claimFullscreen(claim)) {
      onClose();
      return;
    }
    const previous = document.activeElement;
    element.showPopover();
    element.querySelector<HTMLButtonElement>("[data-canvas-exit]")?.focus();
    return () => {
      releaseFullscreen(claim);
      element.hidePopover();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        (document.activeElement === document.body ||
          element.contains(document.activeElement))
      )
        previous.focus({ preventScroll: true });
    };
  }, [active, surface, onClose]);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // The draft owns Escape and its dirty-text confirmation.
      if (surface?.querySelector("[data-slot=anchored-draft-popover]")) return;
      event.preventDefault();
      onClose();
    };
    const onFocus = (event: FocusEvent): void => {
      const element = surface;
      if (
        element === null ||
        !(event.target instanceof Node) ||
        element.contains(event.target) ||
        isFullscreenBlocked()
      )
        return;
      element.querySelector<HTMLButtonElement>("[data-canvas-exit]")?.focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [active, surface, onClose]);
}
