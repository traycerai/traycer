import { useCallback, useRef } from "react";

/**
 * Keeps touch scrolling alive for a scroller that lives inside a shadow root
 * when the surface hosting it also mounts a modal scroll lock.
 *
 * On iOS WKWebView, a non-passive document-level `touchmove` listener (the
 * scroll-lock layer of a modal drawer/dialog registers one while open) makes
 * the engine defer its native-scroll decision until the event has finished
 * dispatching. A touch inside a shadow root retargets to the light-DOM host
 * for that document-level dispatch, and the deferred decision resolves
 * against the host's light-DOM chain — which contains no scroller — so the
 * native pan never starts: every `touchmove` flows uncancelled, no `scroll`
 * event fires, and the rows sit frozen under the finger. Light-DOM scrollers
 * are unaffected, and programmatic `scrollTop` writes still work, which is
 * what makes the failure look like a hit-testing bug rather than what it is.
 *
 * Stopping `touchmove` propagation at the light-DOM wrapper keeps those
 * touches away from document BUBBLE listeners — capture-phase listeners on
 * document or window still run, since capture descends before the wrapper's
 * bubble position — and the engine engages the native pan for the
 * shadow-internal scroller directly. Bubble phase, not capture: listeners at
 * and below the touched element (the scroller's own shadow-internal ones
 * included) have already run by the time the wrapper's bubble listener
 * stops the event. The listener is inert wherever no document-level
 * `touchmove` consumer is mounted (desktop, and sheets without scroll locks).
 *
 * Attach the returned ref to the nearest light-DOM wrapper of the
 * shadow-rooted scroller. The wrapper must not itself need `touchmove` to
 * reach ancestors — drawer drag-to-dismiss decisions ride pointer events and
 * are unaffected. The flip side is a standing constraint: any bubble-phase
 * `touchmove` listener above the wrapper — native or React synthetic — is
 * deaf to tree gestures. Nothing above listens for `touchmove` today; a
 * future listener that must hear these gestures needs a capture-phase
 * registration.
 */
export function useShadowScrollerTouchShield(): (
  node: HTMLElement | null,
) => void {
  const cleanupRef = useRef<(() => void) | null>(null);
  return useCallback((node: HTMLElement | null) => {
    if (cleanupRef.current !== null) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (node === null) return;
    const stopTouchMove = (event: TouchEvent): void => {
      event.stopPropagation();
    };
    node.addEventListener("touchmove", stopTouchMove);
    cleanupRef.current = () => {
      node.removeEventListener("touchmove", stopTouchMove);
    };
  }, []);
}
