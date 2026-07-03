/**
 * Tailwind v4 unsafe CSS overrides for @pierre/diffs theming.
 * Layered color-mix() expressions to tint diff backgrounds with
 * the active theme's semantic tokens (--success, --destructive, etc).
 *
 * The `[data-diffs-host]` selector matches the component's root container.
 * All variables are resolved at paint time against the active Tailwind theme.
 */

export const DIFF_PANEL_UNSAFE_CSS = `
  [data-diffs-host] {
    --diffs-font-family: var(--font-mono);
    --diffs-font-size: var(--code-font-size, 13px);
    --diffs-bg: color-mix(in srgb, var(--card) 100%, transparent 0%);
    --diffs-bg-addition-override: color-mix(in srgb, var(--success) 14%, var(--card) 86%);
    --diffs-bg-deletion-override: color-mix(in srgb, var(--destructive) 14%, var(--card) 86%);
    --diffs-bg-addition-number-override: color-mix(in srgb, var(--success) 22%, var(--card) 78%);
    --diffs-bg-deletion-number-override: color-mix(in srgb, var(--destructive) 22%, var(--card) 78%);
    --diffs-bg-addition-hover-override: color-mix(in srgb, var(--success) 24%, var(--card) 76%);
    --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--destructive) 24%, var(--card) 76%);
    --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--success) 32%, var(--card) 68%);
    --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--destructive) 32%, var(--card) 68%);
    --diffs-bg-context-override: color-mix(in srgb, var(--card) 100%, transparent 0%);
    --diffs-bg-hover-override: color-mix(in srgb, var(--border) 100%, transparent 0%);
    --diffs-bg-separator-override: color-mix(in srgb, var(--border) 100%, transparent 0%);
    --diffs-bg-buffer-override: color-mix(in srgb, var(--border) 100%, transparent 0%);
    --diffs-text-context-override: color-mix(in srgb, var(--muted) 100%, transparent 0%);
    --diffs-text-addition-override: color-mix(in srgb, var(--success) 100%, transparent 0%);
    --diffs-text-deletion-override: color-mix(in srgb, var(--destructive) 100%, transparent 0%);
    --diffs-text-addition-dim-override: color-mix(in srgb, var(--success) 60%, var(--muted) 40%);
    --diffs-text-deletion-dim-override: color-mix(in srgb, var(--destructive) 60%, var(--muted) 40%);
  }
`;
