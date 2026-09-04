import { useCallback, useRef } from "react";
import {
  STATUS_ANIMATION_PULSE_CADENCE_MS,
  useStatusAnimation,
} from "@/lib/animation/status-animation-clock";
import { cn } from "@/lib/utils";

const CYCLE_MS = 1400;
const STAGGER_MS = 200;
/** Fraction of the cycle spent rising and falling; the rest is rest. */
const ACTIVE_FRACTION = 0.8;
const REST_OPACITY = 0.3;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;
}

/** 0 at rest, 1 at the top of the bounce, eased, per dot. */
function dotLift(elapsedMs: number, index: number): number {
  const shifted = elapsedMs - index * STAGGER_MS;
  const phase = (((shifted / CYCLE_MS) % 1) + 1) % 1;
  if (phase >= ACTIVE_FRACTION) return 0;
  const half = ACTIVE_FRACTION / 2;
  const linear = phase < half ? phase / half : 1 - (phase - half) / half;
  return easeInOut(linear);
}

/**
 * 3-dot "typing" loader for in-progress cues: three steadily, sequentially
 * pulsing dots. Static layout comes from the `.working-dots` rules in
 * index.css; the bounce is written as inline styles from the shared status
 * animation clock (see `status-animation-clock.ts` for why it is not a CSS
 * animation).
 */
export function WorkingDots(props: {
  readonly className: string | undefined;
  readonly testId: string | undefined;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const write = useCallback((element: HTMLSpanElement, elapsedMs: number) => {
    const dots = element.children;
    for (let index = 0; index < dots.length; index++) {
      const dot = dots[index];
      if (!(dot instanceof HTMLElement)) continue;
      const lift = dotLift(elapsedMs, index);
      dot.style.opacity = String(REST_OPACITY + (1 - REST_OPACITY) * lift);
      dot.style.transform = `translateY(${(-lift).toFixed(3)}px)`;
    }
  }, []);
  const clear = useCallback((element: HTMLSpanElement) => {
    for (const dot of element.children) {
      if (!(dot instanceof HTMLElement)) continue;
      dot.style.opacity = "";
      dot.style.transform = "";
    }
  }, []);
  useStatusAnimation(ref, write, clear, STATUS_ANIMATION_PULSE_CADENCE_MS);
  return (
    <span
      ref={ref}
      className={cn("working-dots text-current", props.className)}
      aria-hidden="true"
      data-testid={props.testId}
    >
      <span />
      <span />
      <span />
    </span>
  );
}
