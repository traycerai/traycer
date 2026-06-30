/**
 * jsdom has no `PointerEvent` constructor, so Testing Library's
 * `fireEvent.pointerDown(...)` falls back to a bare `Event` and silently
 * drops `clientX` / `button` / `pointerId`. This helper builds a
 * MouseEvent-backed pointer event (MouseEvent carries the coordinate and
 * button fields) with `pointerId` defined on top - enough for React's
 * `onPointer*` synthetic events, which dispatch by event TYPE, not by
 * constructor. Fire it with `fireEvent(target, pointerEvent(...))` so the
 * dispatch stays act()-wrapped.
 */
export interface PointerEventOptions {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly button: number;
}

export type PointerEventType =
  "pointerdown" | "pointermove" | "pointerup" | "pointercancel";

export function pointerEvent(
  type: PointerEventType,
  options: PointerEventOptions,
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX,
    clientY: options.clientY,
    button: options.button,
  });
  Object.defineProperty(event, "pointerId", { value: options.pointerId });
  return event;
}
