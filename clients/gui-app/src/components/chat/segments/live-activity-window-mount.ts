import { useEffect, useState } from "react";

/**
 * How long the window takes to fold away once the run stops being live.
 *
 * Also the delay before its children unmount - the rows must stay in the DOM
 * for the whole exit or the box would collapse against empty content and the
 * transition would have nothing to show. The CSS transition is driven from
 * this same constant (inline `transitionDuration`) rather than a `duration-300`
 * class, so the timer and the animation cannot drift apart.
 */
export const LIVE_ACTIVITY_WINDOW_EXIT_MS = 300;

/**
 * Owns "are the live window's rows in the DOM", which outlasts its `shown` prop
 * by the exit duration.
 *
 * Lives in its own module, apart from `LiveActivityWindow`, for two reasons.
 * `react-refresh/only-export-components` refuses a hook exported beside a
 * component - but more to the point, this state has two readers now. The window
 * renders against it, and `ActivityGroupSegment` records its headed-header
 * latch against it, because the difference between "shown" and "on screen" is
 * exactly where that latch had a blind spot: a group that settles in the same
 * update that adds a second segment turns `shown` off while the newly headed
 * reasoning row is still visible for 300ms.
 *
 * Entering is a render-phase adjustment (React's documented "adjusting state
 * when a prop changes" pattern), not an effect: the rows must be in the DOM in
 * the same commit that turns the window on, and deferring that to an effect
 * would flash an empty box for a frame. Leaving is deferred so the height
 * transition has content to animate against, with the setState inside the timer
 * callback - an effect that set state synchronously would cascade a render.
 */
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
