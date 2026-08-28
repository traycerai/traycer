/**
 * Whether a drag release landed outside the renderer viewport - the coarse
 * signal that a tab was pulled out of its window entirely.
 */
export function pointIsOutsideViewport(
  point: { readonly x: number; readonly y: number } | null,
  viewport: { readonly width: number; readonly height: number },
): boolean {
  if (point === null) return false;
  return (
    point.x < 0 ||
    point.y < 0 ||
    point.x > viewport.width ||
    point.y > viewport.height
  );
}
