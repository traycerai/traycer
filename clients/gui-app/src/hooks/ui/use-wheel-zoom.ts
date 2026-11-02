import { useEffect, type RefObject } from "react";

/**
 * A wheel gesture is a run of wheel events with no gap longer than this. A
 * trackpad flick keeps coasting for a second or more after the fingers lift,
 * and the OS sends those coasting events back to back, so they stay inside
 * the gesture that started them.
 */
const WHEEL_GESTURE_GAP_MS = 150;

/**
 * Scroll distance that zooms by a factor of e for a held Ctrl/⌘. One mouse
 * notch (40 px in Chromium on macOS, 100 px elsewhere) zooms roughly 8 to 20
 * percent, close to the toolbar's step, and a trackpad zooms smoothly.
 */
const MODIFIER_WHEEL_PX_PER_E = 500;

/**
 * Chromium reports a trackpad pinch as a Ctrl+wheel event whose deltaY is
 * -100·ln(scale), so this divisor turns it back into the fingers' own scale.
 */
const PINCH_WHEEL_PX_PER_E = 100;

/**
 * Ctrl/⌘ + wheel zoom for a document viewer, plus the desktop trackpad pinch
 * that Chromium delivers the same way.
 *
 * A gesture keeps the meaning its first event gave it. Pressing Ctrl/⌘ while
 * a scroll is still coasting must not turn the rest of that scroll into a
 * zoom: the OS stamps the modifier onto the coasting events, and each one
 * would zoom. The zoom also follows the scroll distance, not the event count,
 * because a trackpad sends many small events where a mouse sends one large
 * one.
 *
 * The listener is NATIVE and non-passive because React registers `wheel`
 * passively, where preventDefault is a no-op and the browser's own Ctrl+wheel
 * page zoom would run alongside the viewer's.
 */
export function useWheelZoom(
  zoneRef: RefObject<HTMLElement | null>,
  zoomBy: (factor: number) => void,
): void {
  useEffect(() => {
    const zone = zoneRef.current;
    if (zone === null) return;
    let lastWheelAt = Number.NEGATIVE_INFINITY;
    let gestureZooms = false;
    // A pinch arrives with ctrlKey set while no Control key is down; tracking
    // the physical key is how it is told apart from a held Ctrl.
    let controlKeyDown = false;

    const trackControlKey = (event: KeyboardEvent): void => {
      if (event.key === "Control") controlKeyDown = event.type === "keydown";
    };
    const forgetControlKey = (): void => {
      controlKeyDown = false;
    };
    const handleWheel = (event: WheelEvent): void => {
      if (event.timeStamp - lastWheelAt > WHEEL_GESTURE_GAP_MS) {
        gestureZooms = event.ctrlKey || event.metaKey;
      }
      lastWheelAt = event.timeStamp;
      if (!gestureZooms) return;
      event.preventDefault();
      const isPinch = event.ctrlKey && !event.metaKey && !controlKeyDown;
      const pixelsPerE = isPinch
        ? PINCH_WHEEL_PX_PER_E
        : MODIFIER_WHEEL_PX_PER_E;
      zoomBy(Math.exp(-event.deltaY / pixelsPerE));
    };

    zone.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("keydown", trackControlKey);
    window.addEventListener("keyup", trackControlKey);
    window.addEventListener("blur", forgetControlKey);
    return () => {
      zone.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", trackControlKey);
      window.removeEventListener("keyup", trackControlKey);
      window.removeEventListener("blur", forgetControlKey);
    };
  }, [zoneRef, zoomBy]);
}
