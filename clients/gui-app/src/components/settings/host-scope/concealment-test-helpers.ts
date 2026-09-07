/** Suites asserting the honest-state gate should treat "absent" and "concealed" as the same claim -
 * `expect(node === null || isConcealed(node))`. */
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
