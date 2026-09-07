import { useCallback, useRef } from "react";
import {
  STATUS_ANIMATION_SMOOTH_CADENCE_MS,
  useStatusAnimation,
} from "@/lib/animation/status-animation-clock";
import { cn } from "@/lib/utils";

const SWEEP_MS = 2200;
const SWEEP_START_PERCENT = 150;
const SWEEP_SPAN_PERCENT = 200;

/** The gradient, clip and reduced-motion fallback are the `.working-text-shimmer` rules in index.css. */
export function WorkingShimmerText(props: {
  readonly children: string;
  readonly className: string | undefined;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const write = useCallback((element: HTMLSpanElement, elapsedMs: number) => {
    const progress = (elapsedMs / SWEEP_MS) % 1;
    element.style.backgroundPosition = `${SWEEP_START_PERCENT - progress * SWEEP_SPAN_PERCENT}% center`;
  }, []);
  const clear = useCallback((element: HTMLSpanElement) => {
    element.style.backgroundPosition = "";
  }, []);
  useStatusAnimation(ref, write, clear, STATUS_ANIMATION_SMOOTH_CADENCE_MS);
  return (
    <span ref={ref} className={cn("working-text-shimmer", props.className)}>
      {props.children}
    </span>
  );
}
