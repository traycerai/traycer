/**
 * Geometry constants for the N-ary canvas split tree. Values mirror the
 * reference split-container implementation (paseo) and are shared by the
 * tree math, the resize handles, and the drop-zone hit testing so every
 * consumer agrees on what "too small" and "edge" mean.
 */

/** Minimum normalized fraction a pane may occupy inside its group. */
export const MIN_SPLIT_SIZE = 0.1;

/**
 * Pixel floor applied on top of {@link MIN_SPLIT_SIZE} at render time: a
 * pane's effective minimum is `max(MIN_SPLIT_SIZE * containerPx, MIN_PANE_PX)`
 * when the container is large enough to honor it. Stored fractions stay
 * pure (paseo-style); the px floor only affects live resize clamping so
 * tiny windows degrade gracefully instead of producing unusably thin panes.
 */
export const MIN_PANE_PX = 240;

/**
 * Maximum split-tree depth (a bare pane has depth 1). Edge-drops that would
 * nest beyond this are rejected; same-direction drops merge into the parent
 * group and therefore never deepen the tree.
 */
export const MAX_TREE_DEPTH = 4;

/**
 * Fraction of a pane's width/height that counts as an "edge" for
 * drop-to-split hit testing.
 */
export const EDGE_SPLIT_RATIO = 0.15;

/**
 * Fraction of a pane's width/height (centered) that counts as the "center"
 * drop region (move-into-pane instead of split).
 */
export const CENTER_DROP_RATIO = 0.4;
