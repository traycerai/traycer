/**
 * True when the node, or any DOM ancestor, is hidden from view — the `hidden`
 * attribute or an inline `display: none`. A hidden `<Activity>` conceals its
 * subtree this way, and (measured) applies the same inline style to the root
 * host nodes of portals created inside it, so the walk covers a concealed
 * Radix dialog too.
 *
 * Suites asserting the honest-state gate should treat "absent" and
 * "concealed" as the same claim — `expect(node === null || isConcealed(node))`
 * — because content that has never been visible may or may not have been
 * prerendered into the hidden boundary yet.
 *
 * Lives outside `__tests__/` so suites in sibling directories can import it
 * without reaching into another folder's test-only tree (same rationale as
 * `host-scope-fixture`).
 */
export function isConcealed(node: Element): boolean {
  let current: Element | null = node;
  while (current !== null) {
    if (current instanceof HTMLElement) {
      if (current.hidden) return true;
      if (current.style.display === "none") return true;
    }
    current = current.parentElement;
  }
  return false;
}
