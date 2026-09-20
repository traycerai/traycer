import { useLayoutEffect } from "react";
import { useCustomizeStore } from "@/stores/customize/customize-store";

export function useCustomizeInert(active: boolean): void {
  const sample = useCustomizeStore(
    (state) => state.session?.scene === "sample",
  );
  useLayoutEffect(() => {
    if (!active) return;
    const owned = new Set<Element>();
    const sync = () => {
      for (const node of document.querySelectorAll("[data-customize-inert]")) {
        // The sample owns its passive content; its viewport must still scroll.
        if (sample && node.tagName === "MAIN") continue;
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
  }, [active, sample]);
}
