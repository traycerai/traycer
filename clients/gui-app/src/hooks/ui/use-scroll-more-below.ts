import { useEffect, useState } from "react";

/**
 * The mask that fades a vertical scroller's bottom edge: what the reader sees
 * of the next item says the list goes on. Pair it with
 * {@link useScrollMoreBelow} so the last item is not faded once it is in view.
 */
export const SCROLL_MORE_BELOW_FADE_CLASS =
  "[-webkit-mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)] [mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]";

/**
 * Whether `scroller` hides content below its bottom edge, tracked from scroll
 * and from resizes of the scroller and its children. Takes the element rather
 * than a ref: a dialog's list mounts after the dialog's own first render.
 */
export function useScrollMoreBelow(scroller: HTMLElement | null): boolean {
  const [moreBelow, setMoreBelow] = useState(false);
  useEffect(() => {
    if (scroller === null) return;
    const update = (): void => {
      // 1px slack: fractional scroll positions never settle on the bound.
      setMoreBelow(
        scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1,
      );
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    for (const child of scroller.children) observer.observe(child);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [scroller]);
  return moreBelow;
}
