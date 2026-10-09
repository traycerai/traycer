/**
 * A value made safe to interpolate into a `querySelector` string, as an
 * identifier or inside a quoted attribute value.
 *
 * `CSS.escape` where the runtime has it (every browser this app targets), and
 * where it does not (jsdom, and the other non-browser runtimes these modules
 * load in) a backslash before every character that is not a word character or
 * a hyphen, which CSS reads back as that same character in both positions.
 */
export function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^\w-]/g, "\\$&");
}
