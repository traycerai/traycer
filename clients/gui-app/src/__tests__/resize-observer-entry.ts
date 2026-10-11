/** A `ResizeObserverEntry` naming `target`, for tests that fire a mock observer. */
export function resizeObserverEntryFor(target: Element): ResizeObserverEntry {
  return {
    target,
    contentRect: {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    },
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
}
