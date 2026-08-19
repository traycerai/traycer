/** Keep app-owned typography and interaction behavior; @pierre/diffs owns its colors. */
export const DIFF_PANEL_UNSAFE_CSS = `
  :host, [data-diffs-host] {
    --diffs-font-family: var(--font-mono);
    --diffs-font-size: var(--code-font-size, 13px);
  }

  [data-interactive-lines] [data-line] {
    cursor: text;
  }
`;
