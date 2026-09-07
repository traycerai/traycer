import { resolveCssColor } from "@/lib/css-color";

/** Overlay colors for the Windows native window controls (min/max/close). */
export interface TitleBarOverlayColors {
  /** Overlay background - matches the header's `bg-canvas` surface. */
  readonly color: string;
  /** Glyph color for the min/max/close symbols. */
  readonly symbolColor: string;
}

// Dark shell defaults - the pre-theme launch colors baked into the `BrowserWindow` (`window-factory.ts`).
// Used only if the surface tokens are somehow unset so the controls never fall back to an unstyled state.
const FALLBACK_COLOR = "#0b0b0d";
const FALLBACK_SYMBOL_COLOR = "#e5e5e5";

/**
 * Reads the overlay background + symbol colors from the same `--canvas` / `--canvas-foreground` tokens the app header paints with, resolved to `rgb(...)` - the format Chromium's overlay accepts (Tailwind stores tokens as `oklch()` literals the native overlay.
 */
export function deriveTitleBarOverlayColors(
  doc: Document,
): TitleBarOverlayColors {
  return {
    color: resolveCssColor(doc, "--canvas", FALLBACK_COLOR),
    symbolColor: resolveCssColor(
      doc,
      "--canvas-foreground",
      FALLBACK_SYMBOL_COLOR,
    ),
  };
}
