/**
 * jsdom has no `PointerEvent` constructor, so Testing Library's `fireEvent.pointerDown(...)` falls back to a bare `Event` and silently drops `clientX` / `button` / `pointerId`.
 */
export interface PointerEventOptions {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly button: number;
}

export type PointerEventType =
  | "pointerdown"
  | "pointermove"
  | "pointerup"
  | "pointercancel";

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
