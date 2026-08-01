import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * How long the window takes to fold away once the run stops being live.
 *
 * Also the delay before its children unmount - the rows must stay in the DOM
 * for the whole exit or the box would collapse against empty content and the
 * transition would have nothing to show.
 */
export const LIVE_ACTIVITY_WINDOW_EXIT_MS = 300;

/**
 * Distance from the bottom, in px, within which the window still counts as
 * hugging the tail. Matches `ReasoningTail`'s threshold - a wheel notch lands
 * well outside it, so one deliberate scroll up suspends the pin.
 */
const TAIL_PIN_SLACK_PX = 16;

interface LiveActivityWindowProps {
  /**
   * True while the run is live and the group is collapsed. Going false starts
   * the fold-away; the component stays mounted for `LIVE_ACTIVITY_WINDOW_EXIT_MS`
   * so the height transition has something to animate.
   */
  readonly shown: boolean;
  readonly children: ReactNode;
}

/**
 * Bounded, tail-following viewport for the activity that is happening right
 * now. Rows scroll up out of it instead of growing the turn, so the run
 * indicator below stays put while tools and reasoning stream.
 *
 * Generalized from `ReasoningTail`, which is the same widget scoped to one
 * markdown string. Everything it proved - the tail pin, a manual scroll
 * suspending that pin, and a top fade gated on a MEASURED overflow flag so a
 * short body is not dimmed into invisibility - carries over unchanged.
 *
 * Two things it adds:
 *
 * 1. `overscroll-contain`. The transcript is a LegendList whose scroll policy
 *    treats any real wheel/touch/pointer gesture as intent to leave the live
 *    edge (`free-scrolling`, until the reader deliberately returns). Without
 *    containment, a wheel that bottoms out in here would chain to the
 *    transcript and strand a reader who only meant to look back two rows.
 * 2. An animated exit. The collapse is system-initiated (the turn ended, or
 *    prose started), so it deliberately does NOT route through
 *    `requestChatMeasuredItemChange`: that helper is a flushSync + one-shot
 *    geometric correction and cannot absorb a change spread over 300ms.
 *    LegendList observes every item with a ResizeObserver, so it tracks a
 *    CSS-transitioned height frame by frame on its own.
 */
export function LiveActivityWindow(props: LiveActivityWindowProps) {
  const { shown, children } = props;
  const [mounted, setMounted] = useState(shown);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Stays true while the window hugs the newest row; a manual scroll up (to
  // read something that already went past) suspends the pin until the reader
  // returns to the bottom.
  const pinnedRef = useRef(true);

  // Entering is a render-phase adjustment (React's documented "adjusting state
  // when a prop changes" pattern), not an effect: the rows must be in the DOM
  // in the same commit that turns the window on, and deferring that to an
  // effect would flash an empty box for a frame.
  if (shown && !mounted) setMounted(true);

  // Leaving is deferred so the height transition has content to animate
  // against. The setState is inside the timer callback, never in the effect
  // body - an effect that set state synchronously would cascade a render.
  useEffect(() => {
    if (shown || !mounted) return;
    const timer = setTimeout(
      () => setMounted(false),
      LIVE_ACTIVITY_WINDOW_EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, [mounted, shown]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_PIN_SLACK_PX;
  }, []);

  // Live external sync (browser scroll position <-> streaming rows): no
  // dependency array on purpose. The window only exists while the run is live,
  // and every render of it means a row was added or grew - which is exactly
  // when the tail needs re-pinning and the overflow flag re-measuring. A
  // dependency list here would have to encode "any content changed", which no
  // stable value expresses. Writes DOM only, never state, so it cannot loop.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.dataset.overflowing = String(el.scrollHeight - el.clientHeight > 1);
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  });

  if (!mounted) return null;

  return (
    // The `0fr`/`1fr` grid row is what makes the exit animatable: it
    // interpolates an auto height without anyone having to measure the content.
    // Growth WITHIN the open state is not animated - the specified value stays
    // `1fr` as rows arrive, and a transition only fires on a specified-value
    // change - so rows still appear instantly.
    <div
      data-testid="activity-live-window"
      data-shown={String(shown)}
      className={cn(
        "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
        "motion-reduce:transition-none",
        shown ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          data-testid="activity-live-window-scroller"
          className={cn(
            "mt-0.5 ml-5 flex max-h-[4lh] flex-col gap-0.5 overflow-y-auto overscroll-contain border-l border-border/35 pl-3",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "data-[overflowing=true]:[-webkit-mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)]",
            "data-[overflowing=true]:[mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)]",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
