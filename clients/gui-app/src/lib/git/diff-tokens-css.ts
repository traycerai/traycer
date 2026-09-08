/** App surface tokens surround syntax and diff colors from the active theme. */
export const DIFF_PANEL_UNSAFE_CSS = `
  :host, [data-diffs-host] {
    --diffs-font-family: var(--font-mono);
    --diffs-font-size: var(--code-font-size, 13px);
  }

  [data-code] {
    --diffs-bg: var(--canvas);
    --diffs-fg: var(--canvas-foreground);
  }

  [data-interactive-lines] [data-line] {
    cursor: text;
  }
`;
