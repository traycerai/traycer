import { formatRgb, parse } from "culori";

const SAFE_BLACK = "rgb(0, 0, 0)";

/** Convert any CSS color expression - `oklch()`, `hex`, `rgb()`, `hsl()`, named - to an `rgb(...)` string. */
export function rgbify(value: string): string {
  if (value.length === 0) return SAFE_BLACK;
  if (/^(rgb|#)/i.test(value)) return value;
  const parsed = parse(value);
  if (parsed === undefined) return SAFE_BLACK;
  const formatted = formatRgb(parsed);
  return formatted.length > 0 ? formatted : SAFE_BLACK;
}

/** Read a CSS custom property as the cascade resolves it now. */
export function readCssVar(doc: Document, name: string): string {
  return getComputedStyle(doc.documentElement).getPropertyValue(name).trim();
}

/**
 * Resolve a CSS custom property to an `rgb(...)` string, falling back to `fallback` (which may itself be an oklch/hex/named/rgb literal) when the variable is unset on the active cascade.
 */
export function resolveCssColor(
  doc: Document,
  name: string,
  fallback: string,
): string {
  const raw = readCssVar(doc, name);
  return rgbify(raw.length > 0 ? raw : fallback);
}
