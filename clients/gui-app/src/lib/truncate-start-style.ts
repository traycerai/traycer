import type { CSSProperties } from "react";

/**
 * Inline style that truncates text from the START rather than the end -
 * shows "…/end/of/path/file.ts" with the leaf filename always visible
 * and an ellipsis on the left when the container is too narrow.
 *
 * Mechanism: the OUTER element uses `direction: rtl` to flip the
 * `text-overflow: ellipsis` clipping edge to the visual left, then
 * pins the visible content back to the left with `text-align: left`.
 *
 * Pair this with `TRUNCATE_START_INNER_STYLE` on a child span. Keeping
 * the actual path text in an isolated LTR run prevents punctuation such
 * as a leading slash from being visually reordered to the end.
 */
export const TRUNCATE_START_STYLE: CSSProperties = {
  direction: "rtl",
  overflow: "hidden",
  textAlign: "left",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const TRUNCATE_START_INNER_STYLE: CSSProperties = {
  direction: "ltr",
  unicodeBidi: "isolate",
};
