import type { CSSProperties } from "react";

/**
 * Inline style that truncates text from the START rather than the end - shows "…/end/of/path/file.ts" with the leaf filename always visible and an ellipsis on the left when the container is too narrow.
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
