/**
 * `@pierre/trees` stamps every row with `data-item-path="<tree-path>"` and
 * does not expose a callback for "row activated" (e.g. double-click) - its
 * activation handlers live inside its own shadow-DOM. To open a file on
 * double-click we walk the composed event path looking for the nearest
 * element carrying that attribute.
 *
 * Isolating the DOM access here keeps the brittle integration in one
 * place. Any Pierre upgrade that renames the attribute breaks the
 * adapter's unit test (`pierre-tree-adapter.test.ts`) before it reaches
 * the file-tree UI.
 */
export const PIERRE_ITEM_PATH_ATTR = "data-item-path";

/**
 * Minimal event shape consumed by the adapter. Accepts React's
 * `MouseEvent<HTMLElement>` (whose `nativeEvent` is a DOM `Event`) and any
 * other object that exposes a `composedPath`-returning `nativeEvent`.
 */
export interface PierreActivationEvent {
  readonly nativeEvent: { composedPath(): ReadonlyArray<EventTarget> };
}

export function extractPierreItemPathFromEvent(
  event: PierreActivationEvent,
): string | null {
  return (
    findPierreItemElement(event)?.getAttribute(PIERRE_ITEM_PATH_ATTR) ?? null
  );
}

/**
 * Returns the nearest row element carrying `data-item-path` on the event's
 * composed path, or `null` for a non-row press. The drag bridge sets this as
 * the dnd-kit draggable's `element` so the drag overlay anchors to the grabbed
 * row (matching per-row draggables) instead of the whole-tree wrapper.
 */
export function extractPierreItemElementFromEvent(
  event: PierreActivationEvent,
): HTMLElement | null {
  return findPierreItemElement(event);
}

function findPierreItemElement(
  event: PierreActivationEvent,
): HTMLElement | null {
  for (const target of event.nativeEvent.composedPath()) {
    if (!(target instanceof HTMLElement)) continue;
    // Read through the named constant so a Pierre attribute rename is a
    // one-line change here (and trips `pierre-tree-adapter.test.ts`).
    const path = target.getAttribute(PIERRE_ITEM_PATH_ATTR);
    if (path !== null && path.length > 0) return target;
  }
  return null;
}
