import { useEffect, useState } from "react";

/** Also the delay before its children unmount - the rows must stay in the DOM for the whole exit or the box would collapse against empty content and the transition would have nothing to show. The CSS transition is driven from this same constant (inline `transitionDuration`) rather than a `duration-300` class, so the timer and the animation cannot drift apart. */
export const LIVE_ACTIVITY_WINDOW_EXIT_MS = 300;

/** Entering is a render-phase adjustment (React's documented "adjusting state when a prop changes" pattern), not an effect: the rows must be in the DOM in the same commit that turns the window on, and deferring that to an effect would flash an empty box for a frame. Leaving is deferred so the height transition has content to animate against, with the setState inside the timer callback - an effect that set state synchronously would cascade a render. */
export function useLiveActivityWindowMounted(shown: boolean): boolean {
  const [mounted, setMounted] = useState(shown);
  if (shown && !mounted) setMounted(true);
  useEffect(() => {
    if (shown || !mounted) return;
    const timer = setTimeout(
      () => setMounted(false),
      LIVE_ACTIVITY_WINDOW_EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, [mounted, shown]);
  return mounted;
}
