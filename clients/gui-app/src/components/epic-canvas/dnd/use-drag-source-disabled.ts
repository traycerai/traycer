import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

/**
 * Whether dnd-kit drag sources must stay inert because a touch-grade pointer is driving the window.
 * Feed it to `useDraggable({ disabled })`. dnd-kit then hands back an empty `listeners` object, so no pointer handler is attached at all and the browser scrolls natively - rather than a sensor activating and having to be out-raced.
 */
export function useDragSourceDisabled(): boolean {
  return useCoarsePointer();
}
