export function cssPixelsToWindowDips(
  value: number,
  zoomFactor: number,
): number {
  const safeZoomFactor =
    Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return Math.round(value * safeZoomFactor);
}
