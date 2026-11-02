import { useEffect, type RefObject } from "react";

/**
 * Makes a press inside a guest frame count as a press on the frame element
 * for every overlay on the page.
 *
 * A sandboxed iframe (HTML artifacts, canvases, MCP apps) and a `<webview>`
 * swallow their own pointer events: nothing reaches this document, and Chrome
 * fires no `focusin` here when focus moves into the frame. So an overlay that
 * dismisses on an outside interaction - a Radix popover, a menu, a tooltip -
 * never hears about the click and stays open over the frame. The parent does
 * get one signal: the window loses focus to the frame, and
 * `document.activeElement` is then the frame element itself.
 *
 * On that signal this replays the press as a `pointerdown` followed by a
 * `click` on the frame element, the pair Radix's dismissable layer needs:
 * it defers its outside-pointerdown dismissal to the gesture's click, and a
 * pointerdown with no click would leave the dismissal armed until the next
 * click anywhere. Both events bubble like the real ones would, so document
 * listeners of every kind see one ordinary outside press.
 *
 * When the whole application loses focus while the frame holds it, the
 * active element is the frame too, but the document no longer has focus:
 * such a blur is not a press and relays nothing. (Chrome delivers that blur
 * to the frame's own window; the check is for an engine that delivers it
 * here.)
 *
 * Not relayed: a press while the frame already holds focus - the window does
 * not blur again - and anything the frame does with the press itself.
 */
export function useGuestFramePressRelay(
  frameRef: RefObject<Element | null>,
): void {
  useEffect(() => {
    const onWindowBlur = (): void => {
      const frame = frameRef.current;
      if (frame === null || document.activeElement !== frame) return;
      if (!document.hasFocus()) return;
      relayGuestFramePress(frame);
    };
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, [frameRef]);
}

/** The pointerdown + click pair an outside press produces, on `frame`. */
function relayGuestFramePress(frame: Element): void {
  frame.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: "mouse",
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: 1,
    }),
  );
  frame.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
    }),
  );
}
