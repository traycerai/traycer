import { useMemo } from "react";
import { formatRgb, oklch, parse } from "culori";
import type { ITheme } from "@xterm/xterm";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { readCssVar, resolveCssColor, rgbify } from "@/lib/css-color";

const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;
type AnsiName = (typeof ANSI_NAMES)[number];
function shiftLightness(value: string, delta: number): string {
  const parsed = parse(value);
  if (parsed === undefined) return value;
  const inOklch = oklch(parsed);
  const next = {
    ...inOklch,
    l: Math.max(0, Math.min(1, inOklch.l + delta)),
  };
  const formatted = formatRgb(next);
  return formatted.length > 0 ? formatted : value;
}

/**
 * Restate an already-resolved color at `alpha`. Mirrors what the stylesheets
 * express as `color-mix(in oklch, <token> N%, transparent)`, for the consumers
 * that paint outside the CSS cascade.
 */
function withAlpha(color: string, alpha: number): string {
  const parsed = parse(color);
  if (parsed === undefined) return color;
  const formatted = formatRgb({ ...parsed, alpha });
  return formatted.length > 0 ? formatted : color;
}
function buildTerminalTheme(
  resolvedTheme: "light" | "dark",
  doc: Document,
): ITheme {
  const foreground = resolveCssColor(doc, "--canvas-foreground", "#000000");
  const background = resolveCssColor(doc, "--canvas", "#ffffff");
  const primary = resolveCssColor(doc, "--primary", "#3b82f6");
  // xterm 6 draws its own scrollbar (a VS Code-derived slider div), so it never
  // sees the app-wide `::-webkit-scrollbar` theme in index.css and would keep
  // its default `foreground @ 20%` slider. Feed it the same `--muted-foreground`
  // steps that theme uses so a terminal tile and a chat pane sitting side by
  // side read as one scrollbar.
  const scrollbarSlider = resolveCssColor(
    doc,
    "--muted-foreground",
    foreground,
  );

  const normals = {} as Record<AnsiName, string>;
  for (const name of ANSI_NAMES) {
    normals[name] = resolveCssColor(doc, `--term-ansi-${name}`, foreground);
  }

  const brightDelta = resolvedTheme === "dark" ? 0.08 : -0.08;
  const brights = {} as Record<AnsiName, string>;
  for (const name of ANSI_NAMES) {
    const raw = readCssVar(doc, `--term-ansi-bright-${name}`);
    brights[name] =
      raw.length > 0 ? rgbify(raw) : shiftLightness(normals[name], brightDelta);
  }

  return {
    foreground,
    background,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: withAlpha(primary, 0.3),
    scrollbarSliderBackground: withAlpha(scrollbarSlider, 0.35),
    scrollbarSliderHoverBackground: withAlpha(scrollbarSlider, 0.6),
    scrollbarSliderActiveBackground: withAlpha(scrollbarSlider, 0.75),
    // Setting `scrollbar.width` is what enables xterm's overview ruler, and the
    // ruler unconditionally strokes a full-height 1px outline down its own left
    // edge. We want the ruler (find-match marks) but not a hairline rule
    // dividing every terminal from its scrollbar, so paint that outline away.
    overviewRulerBorder: "transparent",
    black: normals.black,
    red: normals.red,
    green: normals.green,
    yellow: normals.yellow,
    blue: normals.blue,
    magenta: normals.magenta,
    cyan: normals.cyan,
    white: normals.white,
    brightBlack: brights.black,
    brightRed: brights.red,
    brightGreen: brights.green,
    brightYellow: brights.yellow,
    brightBlue: brights.blue,
    brightMagenta: brights.magenta,
    brightCyan: brights.cyan,
    brightWhite: brights.white,
  };
}

/**
 * React-side entry point. Re-builds the ITheme whenever the resolved
 * light/dark mode or the active preset changes. The build itself is
 * synchronous, so a component can safely use the returned ITheme inside
 * `new Terminal({ theme })` on its mount effect - avoiding the
 * mount-then-effect flash of default colors.
 */
export function useTerminalTheme(): ITheme {
  const { resolvedTheme, themePreset } = useResolvedTheme();
  return useMemo(() => {
    // `themePreset` is part of the memo's cache identity but its values
    // flow in through the CSS cascade (`[data-theme="X"]` selectors that
    // `getComputedStyle` resolves below) rather than appearing in the
    // closure body. Reference it here so `react-hooks/exhaustive-deps`
    // can verify the deps array is complete.
    themePreset;
    return buildTerminalTheme(resolvedTheme, document);
  }, [resolvedTheme, themePreset]);
}
