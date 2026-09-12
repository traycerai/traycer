import type { BrowserViewViewportPresetId } from "@traycer-clients/shared/platform/browser-view";

/**
 * Browser facts, not canvas facts.
 *
 * Both live in `stores/epics/canvas/tile-schema/browser-tile.ts` historically,
 * because the canvas tile ref was the only thing that needed them. They are
 * read by the shared tab-tile body and its two surfaces, which must not import
 * the canvas store at all (`src/__tests__/browser-tile-canvas-boundary.test.ts`
 * is the gate), so they live here and the tile schema re-exports them for its
 * own use.
 */

/**
 * The address a browser tab opens on, and the one the tile reads as "show the
 * browser start page instead of the page". Both surfaces compare against it.
 */
export const DEFAULT_BROWSER_TILE_URL = "about:blank";

export const DEFAULT_BROWSER_VIEWPORT_PRESET: BrowserViewViewportPresetId =
  "responsive";

/**
 * The zoom a browser tile opens at, and the bounds a remembered one is read
 * back through.
 *
 * Zoom is remembered per tile because it is a statement about the PAGE, not
 * about the session: a developer who zoomed a cramped admin panel to 125% means
 * it for that panel, and losing it on every reopen is the kind of small
 * forgetting that reads as the app not paying attention. The bounds match the
 * control-action schema's, so a value that survives a round trip through
 * persistence is one main will still accept.
 */
export const DEFAULT_BROWSER_ZOOM_FACTOR = 1;
export const MIN_BROWSER_ZOOM_FACTOR = 0.25;
export const MAX_BROWSER_ZOOM_FACTOR = 5;

/**
 * Reads a persisted zoom factor. Total rather than throwing: this parses a
 * stored document, where a missing key means a tile written before zoom was
 * remembered and an out-of-range one means a bound that has since moved -
 * neither is a reason to discard the whole tile.
 */
export function readBrowserZoomFactor(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BROWSER_ZOOM_FACTOR;
  }
  return Math.min(
    MAX_BROWSER_ZOOM_FACTOR,
    Math.max(MIN_BROWSER_ZOOM_FACTOR, value),
  );
}
