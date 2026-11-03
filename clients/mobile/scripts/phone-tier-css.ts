import type { Plugin } from "vite";

// Anchored to a line start, so prose quoting the query in a comment is not one.
const PHONE_TIER_QUERY =
  /^\s*@media \((?:max-width: 767px|pointer: coarse)\) \{/m;

/** Set on `<html>` by `main.tsx` in the installed app and nowhere else. */
export const PHONE_LAYOUT_ONLY_CLASS = "traycer-phone-layout-only";

/**
 * Repeats each hand-written phone tier under the installed app's class, so it
 * applies on every device there: at any width, and with a stylus, which Android
 * ranks as a fine pointer. `index.native.css` reaches Tailwind's variants and
 * cannot reach a query in a plain stylesheet. The browser tab has no such class
 * and keeps deciding by its window and pointer.
 */
export function withPhoneTiersAtEveryWidth(css: string): string {
  let result = "";
  let cursor = 0;
  for (;;) {
    const match = PHONE_TIER_QUERY.exec(css.slice(cursor));
    if (match === null) return result + css.slice(cursor);
    const start = cursor + match.index;
    const open = start + match[0].length - 1;
    let depth = 1;
    let index = open + 1;
    while (depth > 0) {
      const char = css[index];
      if (char === undefined) {
        throw new Error(`Unbalanced phone tier at offset ${start}`);
      }
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      index += 1;
    }
    const body = css.slice(open + 1, index - 1);
    result += `${css.slice(cursor, index)}\n.${PHONE_LAYOUT_ONLY_CLASS} {${body}}\n`;
    cursor = index;
  }
}

/** Runs before Tailwind and Vite's CSS pipeline, which lower the nesting. */
export function phoneTiersAtEveryWidth(): Plugin {
  return {
    name: "traycer-phone-tiers-at-every-width",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0].endsWith(".css")) return null;
      if (!PHONE_TIER_QUERY.test(code)) return null;
      return withPhoneTiersAtEveryWidth(code);
    },
  };
}
