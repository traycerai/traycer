import type { BrowserViewBounds } from "@traycer-clients/shared/platform/browser-view";

/**
 * The one CSS-px -> window-DIP conversion in the main process.
 *
 * Renderer geometry (`DOMRect`, `getBoundingClientRect`) is CSS pixels, which
 * page zoom scales; native window geometry (`BrowserWindow` popup anchors,
 * `WebContentsView.setBounds`) is device-independent window pixels, which it
 * does not. Anything crossing that boundary multiplies by the window's zoom
 * factor here - a renderer rect handed to `setBounds` unconverted lands at the
 * wrong place and size on every zoom level but 100%.
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

/**
 * Rect form of {@link cssPixelsToWindowDips}. Edges are converted, then the
 * extents derived from them, so neighbouring tiles keep sharing an edge
 * instead of drifting a pixel apart from independent rounding.
 */
export function cssBoundsToWindowDips(
  bounds: BrowserViewBounds,
  zoomFactor: number,
): BrowserViewBounds {
  const x = cssPixelsToWindowDips(bounds.x, zoomFactor);
  const y = cssPixelsToWindowDips(bounds.y, zoomFactor);
  return {
    x,
    y,
    width: Math.max(
      0,
      cssPixelsToWindowDips(bounds.x + bounds.width, zoomFactor) - x,
    ),
    height: Math.max(
      0,
      cssPixelsToWindowDips(bounds.y + bounds.height, zoomFactor) - y,
    ),
  };
}
