import { useEffect, type ReactNode } from "react";
import {
  clearPrimaryFocusInteraction,
  handlePrimaryFocus,
  reconcilePrimaryFocus,
  subscribeToPrimaryFocusIntent,
  setPrimaryFocusInteractionActive,
} from "./primary-focus-coordinator";

export function PrimaryFocusCoordinatorProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") reconcilePrimaryFocus();
    };
    const handleFocus = (event: FocusEvent): void => {
      handlePrimaryFocus(event.target instanceof Element ? event.target : null);
    };
    const handlePointerDown = (): void => {
      setPrimaryFocusInteractionActive(true);
    };
    const handlePointerSettled = (): void => {
      setPrimaryFocusInteractionActive(false);
    };
    // React portals and retained xterm hosts can move an already-focused
    // endpoint without emitting a new focus event. Child-list commits are the
    // concrete readiness signal for that relocation; observe only while a
    // semantic focus intent is parked.
    const observer = new MutationObserver(() => reconcilePrimaryFocus());
    const unsubscribeFromIntent = subscribeToPrimaryFocusIntent((pending) => {
      if (pending) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        observer.disconnect();
      }
    });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    // Electron webviews emit a non-bubbling `focus` when their guest takes
    // focus, without a host-document `focusin` or `pointerdown`. Observe the
    // handoff in capture, before pane activation can re-register the old owner.
    document.addEventListener("focus", handleFocus, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointerup", handlePointerSettled, true);
    window.addEventListener("pointercancel", handlePointerSettled, true);
    window.addEventListener("blur", handlePointerSettled);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("focus", handleFocus, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointerup", handlePointerSettled, true);
      window.removeEventListener("pointercancel", handlePointerSettled, true);
      window.removeEventListener("blur", handlePointerSettled);
      unsubscribeFromIntent();
      observer.disconnect();
      clearPrimaryFocusInteraction();
    };
  }, []);

  return props.children;
}
