/**
 * Default font stacks mirrored from `--traycer-font-ui` / `--traycer-font-mono`
 * in `index.css`. A user-chosen font override is prepended ahead of these so a
 * missing or misdetected font still degrades to the same defaults the
 * stylesheet ships with. Keep these in sync with `index.css` if those
 * defaults ever change.
 */
export const DEFAULT_UI_FONT_STACK =
  '"Figtree Variable", "Figtree", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const DEFAULT_MONO_FONT_STACK =
  '"SFMono-Regular", "SF Mono", "Cascadia Code", "Roboto Mono", ui-monospace, monospace';

export function quoteFontFamily(name: string): string {
  return `"${name.replace(/"/g, '\\"')}"`;
}

/**
 * Builds a CSS `font-family` value: the chosen font name (quoted) followed by
 * the fallback stack, or just the fallback stack when nothing is chosen.
 */
export function buildFontFamilyValue(
  chosen: string | null,
  defaultStack: string,
): string {
  return chosen === null
    ? defaultStack
    : `${quoteFontFamily(chosen)}, ${defaultStack}`;
}
