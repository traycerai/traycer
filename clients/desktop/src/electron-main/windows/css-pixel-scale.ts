/**
 * The one CSS-px -> window-DIP conversion in the main process.
 *
 * Renderer geometry (`DOMRect`, `getBoundingClientRect`) is CSS pixels, which
 * page zoom scales; native window geometry (`BrowserWindow` popup anchors)
 * is device-independent window pixels, which it does not. Anything crossing
 * that boundary multiplies by the window's zoom factor here.
 *
 * A non-finite or non-positive factor degrades to 1 rather than producing a
 * collapsed or NaN rect.
 */
export function cssPixelsToWindowDips(
  value: number,
  zoomFactor: number,
): number {
  const safeZoomFactor =
    Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return Math.round(value * safeZoomFactor);
}
