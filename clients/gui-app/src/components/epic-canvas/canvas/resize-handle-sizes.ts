/**
 * Adjacent-pair fraction math for split-container resize handles. A handle
 * between children `index` and `index + 1` redistributes ONLY that pair's
 * summed fraction - every other child keeps its committed fraction, so a
 * drag never reflows unrelated siblings.
 */
interface ComputeResizeHandleSizesArgs {
  readonly sizes: ReadonlyArray<number>;
  readonly index: number;
  readonly deltaRatio: number;
  /**
   * Per-child minimum fraction for this drag. Callers derive it from
   * `max(MIN_SPLIT_SIZE, MIN_PANE_PX / containerPx)` so the px floor follows
   * the live container size.
   */
  readonly minSize: number;
}

const RESIZE_SIZE_EPSILON = 1e-9;

export function computeResizeHandleSizes(
  args: ComputeResizeHandleSizesArgs,
): ReadonlyArray<number> {
  const { sizes, index, deltaRatio, minSize } = args;
  const nextSizes = [...sizes];
  if (index < 0 || index + 1 >= sizes.length) {
    return nextSizes;
  }
  const leftSize = sizes[index];
  const rightSize = sizes[index + 1];

  const pairSize = leftSize + rightSize;
  if (pairSize <= 0) {
    return nextSizes;
  }

  const adjacentMinSize = Math.min(minSize, pairSize / 2);
  const nextLeftSize = Math.min(
    pairSize - adjacentMinSize,
    Math.max(adjacentMinSize, leftSize + deltaRatio),
  );
  nextSizes[index] = nextLeftSize;
  nextSizes[index + 1] = pairSize - nextLeftSize;
  return nextSizes;
}

export function resizeHandleSizesEqual(
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (leftSize, index) =>
        Math.abs(leftSize - (right[index] ?? Number.NaN)) <=
        RESIZE_SIZE_EPSILON,
    )
  );
}
