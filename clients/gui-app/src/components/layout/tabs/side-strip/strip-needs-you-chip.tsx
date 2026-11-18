import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { SIDE_STRIP_NEEDS_YOU_CHIP_WORDS_CLASS } from "./side-strip-tokens";

/**
 * "↑ N need you", in the stuck header's row while the Needs you header is
 * scrolled out of view above, in the Notifications pill's amber chip. Where
 * the row is narrow it says "↑ N"; its name always says it all. It takes the
 * person back to Needs you and puts focus on that header, so the keyboard
 * does not lose its place when the chip goes. A pointer click scrolls
 * smoothly; a keyboard press and the app's motion setting jump.
 */
export function StripNeedsYouChip(props: {
  readonly scroller: HTMLElement;
  readonly count: number;
}): ReactNode {
  const { scroller, count } = props;
  const motionEnabled = useMotionEnabled();
  const words = `${count === 1 ? "needs" : "need"} you`;
  return (
    <Badge asChild variant="warning" size="sm">
      <button
        type="button"
        data-testid="side-strip-needs-you-chip"
        aria-label={`${String(count)} ${words}`}
        onClick={(event) => {
          scroller.scrollTo({
            top: 0,
            behavior: motionEnabled && event.detail > 0 ? "smooth" : "instant",
          });
          scroller
            .querySelector<HTMLElement>('[data-strip-section="needs-you"]')
            ?.focus({ preventScroll: true });
        }}
      >
        <span aria-hidden>↑</span>
        <span className="tabular-nums">{count}</span>
        <span className={SIDE_STRIP_NEEDS_YOU_CHIP_WORDS_CLASS}>{words}</span>
      </button>
    </Badge>
  );
}
