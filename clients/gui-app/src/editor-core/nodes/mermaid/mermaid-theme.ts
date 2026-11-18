/**
 * Builds a `themeVariables` object for Mermaid by sampling the live Tailwind
 * CSS variables from `:root`. We use `theme: "base"` and override the
 * variables that matter for diagram chrome (primary accent, text, lines,
 * backgrounds). The mapping is intentionally small - Mermaid exposes many
 * more variables, but the defaults derived from these five are consistent
 * enough to blend with the surrounding prose.
 *
 * Called both on the initial lazy boot of the mermaid module and again
 * whenever `html.dark` toggles so the palette follows system / user theme
 * without a page reload.
 */

import { resolveCssColor } from "@/lib/css-color";

export interface MermaidPaletteSample {
  readonly primary: string;
  readonly foreground: string;
  readonly muted: string;
  readonly border: string;
  readonly background: string;
  readonly accent: string;
}

/**
 * Read the editor palette from the document root. Defaults mirror the
 * shadcn light-theme values so server-rendered snapshots or jsdom tests
 * without CSS still get a sensible diagram.
 */
export function readMermaidPalette(doc: Document): MermaidPaletteSample {
  return {
    primary: resolveCssColor(doc, "--color-primary", "hsl(222 47% 40%)"),
    foreground: resolveCssColor(doc, "--color-foreground", "hsl(0 0% 10%)"),
    muted: resolveCssColor(doc, "--color-muted", "hsl(0 0% 96%)"),
    border: resolveCssColor(doc, "--color-border", "hsl(0 0% 88%)"),
    background: resolveCssColor(doc, "--color-background", "hsl(0 0% 100%)"),
    accent: resolveCssColor(doc, "--color-accent", "hsl(0 0% 94%)"),
  };
}

/**
 * Maps the workspace palette onto the subset of Mermaid theme variables
 * that actually render. `primaryColor` is the fill of nodes; `lineColor`
 * controls edges; `textColor` is used for labels. Sequence / class / ER /
 * gantt diagrams each have their own keys, but without overriding them
 * mermaid falls back to `primaryColor` + `textColor` which is what we want.
 */
export function buildMermaidThemeVariables(
  palette: MermaidPaletteSample,
): Record<string, string> {
  return {
    background: palette.background,
    primaryColor: palette.accent,
    primaryTextColor: palette.foreground,
    primaryBorderColor: palette.border,
    secondaryColor: palette.muted,
    tertiaryColor: palette.background,
    lineColor: palette.border,
    textColor: palette.foreground,
    mainBkg: palette.accent,
    nodeBorder: palette.border,
    clusterBkg: palette.muted,
    clusterBorder: palette.border,
    titleColor: palette.foreground,
    edgeLabelBackground: palette.background,
    noteBkgColor: palette.muted,
    noteBorderColor: palette.border,
    noteTextColor: palette.foreground,
  };
}
