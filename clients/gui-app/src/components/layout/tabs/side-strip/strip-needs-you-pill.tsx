import type { ReactNode } from "react";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import {
  SIDE_STRIP_NEEDS_YOU_PILL_CLASS,
  SIDE_STRIP_NEEDS_YOU_PILL_SEAT_CLASS,
} from "./side-strip-tokens";

/**
 * "↑ N need you", floating under the sticky header while the Needs you header
 * is scrolled out of view above. It takes the person back to Needs you and puts
 * focus on that header, so the keyboard does not lose its place when the pill
 * goes. A pointer click scrolls smoothly; a keyboard press and the app's
 * motion setting jump.
 */
export function StripNeedsYouPill(props: {
  readonly scroller: HTMLElement;
  readonly count: number;
}): ReactNode {
  const { scroller, count } = props;
  const motionEnabled = useMotionEnabled();
  return (
    <div className={SIDE_STRIP_NEEDS_YOU_PILL_SEAT_CLASS}>
      <button
        type="button"
        data-testid="side-strip-needs-you-pill"
        onClick={(event) => {
          scroller.scrollTo({
            top: 0,
            behavior: motionEnabled && event.detail > 0 ? "smooth" : "instant",
          });
          scroller
            .querySelector<HTMLElement>('[data-strip-section="needs-you"]')
            ?.focus({ preventScroll: true });
        }}
        className={SIDE_STRIP_NEEDS_YOU_PILL_CLASS}
      >
        <span aria-hidden>↑ </span>
        {count} {count === 1 ? "needs" : "need"} you
      </button>
    </div>
  );
}
