/**
 * The http(s) URL `value` parses to, or null. The parsed form is what gets
 * both printed and opened: the parser drops tabs and line breaks, so the raw
 * string could print as one link and open as another.
 */
export function httpUrlOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}
