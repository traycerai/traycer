/** The rail's unclamped icon span plus padding, independent of its container width. */
export function railContentWidthPx(rail: HTMLElement): number {
  const style = getComputedStyle(rail);
  const padding =
    Number.parseFloat(style.paddingLeft) +
    Number.parseFloat(style.paddingRight);
  let left = Infinity;
  let right = -Infinity;
  for (const child of rail.children) {
    const rect = child.getBoundingClientRect();
    // A `display: contents` wrapper has no box of its own.
    if (rect.width === 0) continue;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  return right > left ? right - left + padding : padding;
}
