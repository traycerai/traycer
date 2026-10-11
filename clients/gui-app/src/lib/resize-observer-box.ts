/**
 * The border-box size a ResizeObserver entry reports, read without forcing
 * layout. Engines without a `borderBoxSize` array (Safari before 15.4, early
 * Firefox's single object, test stubs) get `contentRect`, which every
 * ResizeObserver entry carries; it omits padding and border, close enough for
 * the thresholds that read it.
 */
export function observedBorderBox(entry: ResizeObserverEntry): {
  readonly inlineSize: number;
  readonly blockSize: number;
} {
  const box =
    "borderBoxSize" in entry && entry.borderBoxSize.length > 0
      ? entry.borderBoxSize[0]
      : undefined;
  return (
    box ?? {
      inlineSize: entry.contentRect.width,
      blockSize: entry.contentRect.height,
    }
  );
}
