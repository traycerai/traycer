import type { CSSProperties } from "react";

// `@pierre/trees` exposes a parameterized theme through CSS custom
// properties. These values pass into the library's internal row layout and
// match the File Tree panel's compact sidebar treatment.
export const PIERRE_FILE_TREE_THEME_STYLE = {
  height: "100%",
  "--trees-font-size-override": "var(--text-ui-sm)",
  "--trees-font-family-override": "inherit",
  "--trees-item-padding-x-override": "0.5rem",
  "--trees-padding-inline-override": "0px",
  "--trees-border-radius-override": "0.375rem",
  "--trees-icon-width-override": "14px",
  "--trees-scrollbar-gutter-override": "0px",
  "--trees-bg-override": "var(--background)",
  "--trees-fg-override":
    "color-mix(in oklab, var(--foreground) 75%, transparent)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-accent-override": "var(--accent)",
  "--trees-selected-bg-override": "var(--accent)",
  "--trees-selected-fg-override": "var(--accent-foreground)",
  "--trees-selected-focused-border-color-override": "transparent",
  "--trees-border-color-override": "var(--border)",
} as CSSProperties;

export const GIT_PANEL_PIERRE_FILE_TREE_THEME_STYLE = {
  ...PIERRE_FILE_TREE_THEME_STYLE,
  "--trees-item-padding-x-override": "0.75rem",
  "--trees-border-radius-override": "0px",
  "--trees-icon-width-override": "14px",
  // Selection mirrors the canvas's focused diff tile; solid accent keeps it
  // visually identical to the flat list's active row.
  "--trees-selected-bg-override": "var(--accent)",
  "--trees-selected-fg-override": "var(--accent-foreground)",
} as CSSProperties;

export const GIT_PANEL_PIERRE_FILE_TREE_UNSAFE_CSS = `
[data-item-type="file"] [data-item-section="icon"] {
  opacity: 0.9;
}

[data-item-type="file"] [data-item-section="content"] {
  color: color-mix(in oklab, var(--foreground) 90%, transparent);
  font-weight: 400;
}

[data-item-type="directory"] [data-item-section="icon"] {
  opacity: 0.55;
}

[data-item-type="directory"] [data-item-section="content"] {
  color: color-mix(in oklab, var(--muted-foreground) 70%, transparent);
  font-size: var(--text-ui-xs);
  font-weight: 400;
}

[data-item-section="decoration"] {
  color: var(--muted-foreground);
  font-size: var(--text-ui-xs);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

[data-item-section="git"] {
  min-width: 1.25rem;
}

button[data-type="item"]:hover,
[data-item-selected="true"] {
  background: color-mix(in oklab, var(--accent) 50%, transparent) !important;
}
`;
