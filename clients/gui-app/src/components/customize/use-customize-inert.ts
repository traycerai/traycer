import { useLayoutEffect } from "react";

export function useCustomizeInert(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    const owned = new Set<Element>();
    const sync = () => {
      for (const node of document.querySelectorAll("[data-customize-inert]")) {
        if (!node.hasAttribute("inert")) {
          owned.add(node);
          node.setAttribute("inert", "");
        }
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const node of owned) node.removeAttribute("inert");
    };
  }, [active]);
}
