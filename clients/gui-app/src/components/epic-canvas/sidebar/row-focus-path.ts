/**
 * Mounting a lazy Radix root around a sidebar row re-creates the row's DOM:
 * the element tree above it changes, so React replaces the nodes. Focus on a
 * node that is replaced falls to the page body, and a Radix menu opened next
 * records the body as the place to return focus to on close.
 *
 * These carry focus across that re-creation by position: the focused node's
 * child indexes below the row, restored on the equal node the new render puts
 * at the same place.
 */

/** Child indexes from `root` down to the focused element, or `null`. */
export function focusPathWithin(
  root: HTMLElement | null,
): readonly number[] | null {
  const active = document.activeElement;
  if (root === null || active === null || !root.contains(active)) return null;
  const path: number[] = [];
  for (let node: Element = active; node !== root;) {
    const parent = node.parentElement;
    if (parent === null) return null;
    path.unshift(Array.from(parent.children).indexOf(node));
    node = parent;
  }
  return path;
}

/** Focuses the element at `path` below `root`, when there is one. */
export function focusAtPath(
  root: HTMLElement | null,
  path: readonly number[],
): void {
  let node: Element | null = root;
  for (const index of path) node = node?.children[index] ?? null;
  if (node instanceof HTMLElement) node.focus({ preventScroll: true });
}
