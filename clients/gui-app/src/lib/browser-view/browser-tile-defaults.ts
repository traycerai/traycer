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
