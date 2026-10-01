import type {
  EdgeSide,
  TabStripPlacement,
} from "@/lib/layout/layout-arrangement";

/** What a window with a side tab strip draws above its content column. */
export type SideTitleBandKind = "band" | "none";

/**
 * What an app window draws above its content column:
 * - `"header"`: the app header with the horizontal tab strip.
 * - `"band"`: a slim title band as tall as the native window controls.
 * - `"none"`: nothing; the content (and a side strip) reaches the window top.
 */
export type AppTitleBandKind = "header" | SideTitleBandKind;

/**
 * The placement and title band together, as the only pairs a window can
 * draw: the header goes with the top placement and never with a side strip.
 */
export type AppColumnChrome =
  | { readonly placement: "top"; readonly titleBand: "header" }
  | { readonly placement: EdgeSide; readonly titleBand: SideTitleBandKind };

export interface AppColumnChromeInput {
  readonly placement: TabStripPlacement;
  readonly platform: "darwin" | "win32" | "linux" | null;
  readonly frameless: boolean;
}

/**
 * The top placement always keeps the header. A browser shell has no native
 * window controls to clear, so a side strip takes no band there. On macOS a
 * left strip's own top block is the title bar under the traffic lights, so no
 * band is drawn. Every other frameless side placement (macOS with the strip at
 * the right, Windows, Linux, which always has the controls overlay) draws the
 * band.
 */
export function appColumnChrome(input: AppColumnChromeInput): AppColumnChrome {
  const { placement } = input;
  if (placement === "top") return { placement, titleBand: "header" };
  if (!input.frameless) return { placement, titleBand: "none" };
  if (sideStripOwnsTitleBar(input)) return { placement, titleBand: "none" };
  return { placement, titleBand: "band" };
}

/**
 * Whether a side strip's top block is the window's title bar (S-04): only on
 * a frameless macOS window with the strip at the left, where no band is drawn
 * and the strip's first row sits under the traffic lights.
 */
export function sideStripOwnsTitleBar(input: AppColumnChromeInput): boolean {
  return (
    input.frameless && input.platform === "darwin" && input.placement === "left"
  );
}
