import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

/**
 * Whether dnd-kit drag sources must stay inert because a touch-grade pointer
 * is driving the window.
 *
 * A drag and a scroll are the SAME gesture on a coarse pointer: press a row,
 * move a finger. A live drag source claims that gesture, so a list the user
 * meant to scroll picks up a row instead. On a fine pointer the two are
 * distinct - a wheel scrolls, a press-and-move drags - so nothing is taken.
 *
 * This is a POINTER-MODEL question, not a layout or a build one, so it reads
 * `useCoarsePointer()` rather than `useIsMobileViewport()` / `isMobileApp()`:
 * a narrow desktop window driven by a mouse keeps every drag, and a touch
 * tablet at desktop width loses them, because that is where the harm is.
 *
 * Feed it to `useDraggable({ disabled })`. dnd-kit then hands back an empty
 * `listeners` object, so no pointer handler is attached at all and the
 * browser scrolls natively - rather than a sensor activating and having to be
 * out-raced. Drop targets need no gate: they are unreachable with no drag in
 * flight.
 *
 * The exception is a drag whose listeners live on a dedicated handle rather
 * than the row (the queued-message reorder grip). Pressing a grip is explicit
 * drag intent and cannot be a scroll, so those sources stay enabled.
 */
export function useDragSourceDisabled(): boolean {
  return useCoarsePointer();
}
