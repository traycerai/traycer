/**
 * Sample :root Tailwind vars into a small Mermaid themeVariables set; re-run when html.dark toggles.
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
 * Read :root palette. Defaults match shadcn light so jsdom/SSR still diagram.
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

/** Map workspace palette onto primaryColor/lineColor/textColor. Other diagram keys fall back to those. */
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
