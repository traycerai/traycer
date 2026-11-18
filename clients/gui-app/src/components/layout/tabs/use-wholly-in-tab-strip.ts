import { useEffect, useState } from "react";

/**
 * Whether `node` lies wholly inside the tab list that scrolls it, observed
 * only while `watching`. Starts true, so a row that joins does so on its first
 * frame; the observer's first report corrects it at once if it is clipped.
 */
export function useWhollyInTabStrip(
  node: HTMLElement | null,
  watching: boolean,
): boolean {
  const [inList, setInList] = useState(true);
  useEffect(() => {
    if (!watching || node === null) return;
    if (typeof IntersectionObserver === "undefined") return;
    const list = node.closest<HTMLElement>("[data-strip-axis]");
    if (list === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry !== undefined) setInList(entry.intersectionRatio >= 1);
      },
      { root: list, threshold: [0, 1] },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [node, watching]);
  return inList;
}
