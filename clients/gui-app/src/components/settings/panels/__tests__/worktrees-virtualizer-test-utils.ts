export const WORKTREE_TEST_VIRTUAL_ITEM_HEIGHT = 80;

export function installWorktreeVirtualizerOffsetHeight(
  getViewportHeight: () => number,
): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.dataset.testid === "worktrees-virtual-scroll") {
        return getViewportHeight();
      }
      if (this.hasAttribute("data-index")) {
        return WORKTREE_TEST_VIRTUAL_ITEM_HEIGHT;
      }
      return 0;
    },
  });
  return () => {
    if (previousDescriptor === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
      return;
    }
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      previousDescriptor,
    );
  };
}
