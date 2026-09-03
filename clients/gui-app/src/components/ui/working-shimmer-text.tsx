import { useCallback, useRef } from "react";
import { useStatusAnimation } from "@/lib/animation/status-animation-clock";
import { cn } from "@/lib/utils";

const SWEEP_MS = 2200;
/** `background-position` sweeps from 150% to -50%: off one side to off the other. */
const SWEEP_START_PERCENT = 150;
const SWEEP_SPAN_PERCENT = 200;

/**
 * In-progress verb text with a foreground highlight sweeping across it
 * ("Pondering", "Refreshing"). The gradient, clip and reduced-motion fallback
 * are the `.working-text-shimmer` rules in index.css; the sweep is written as
 * an inline `background-position` from the shared status animation clock (see
 * `status-animation-clock.ts` for why it is not a CSS animation).
 */
export function WorkingShimmerText(props: {
  readonly children: string;
  readonly className: string | undefined;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const write = useCallback((element: HTMLSpanElement, elapsedMs: number) => {
    const progress = (elapsedMs / SWEEP_MS) % 1;
    element.style.backgroundPosition = `${SWEEP_START_PERCENT - progress * SWEEP_SPAN_PERCENT}% center`;
  }, []);
  useStatusAnimation(ref, write);
  return (
    <span ref={ref} className={cn("working-text-shimmer", props.className)}>
      {props.children}
    </span>
  );
}
