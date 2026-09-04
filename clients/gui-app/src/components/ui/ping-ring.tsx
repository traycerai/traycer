import { useCallback, useRef } from "react";
import {
  STATUS_ANIMATION_PULSE_CADENCE_MS,
  useStatusAnimation,
} from "@/lib/animation/status-animation-clock";
import { cn } from "@/lib/utils";

const CYCLE_MS = 1000;
/** The ring grows and fades over the first three quarters of the cycle, then rests. */
const ACTIVE_FRACTION = 0.75;

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/**
 * The expanding, fading ring behind a live dot - Tailwind's `animate-ping`
 * look (scale 1 -> 2, opacity `peakOpacity` -> 0 each second) written as
 * inline styles from the shared status animation clock instead of a CSS
 * animation; see `status-animation-clock.ts` for why. The `status-ping`
 * class is a marker for tests and reduced-motion styling, not an animation.
 *
 * Position it inside a `relative inline-flex` box the same size as the dot it
 * sits behind; `toneClass` carries the fill.
 */
export function PingRing(props: {
  readonly toneClass: string;
  readonly peakOpacity: number;
}) {
  const { peakOpacity } = props;
  const ref = useRef<HTMLSpanElement | null>(null);
  const write = useCallback(
    (element: HTMLSpanElement, elapsedMs: number) => {
      const phase = (elapsedMs / CYCLE_MS) % 1;
      const progress = easeOut(Math.min(phase / ACTIVE_FRACTION, 1));
      element.style.transform = `scale(${(1 + progress).toFixed(3)})`;
      element.style.opacity = String(peakOpacity * (1 - progress));
    },
    [peakOpacity],
  );
  const clear = useCallback((element: HTMLSpanElement) => {
    element.style.transform = "";
    element.style.opacity = "";
  }, []);
  useStatusAnimation(ref, write, clear, STATUS_ANIMATION_PULSE_CADENCE_MS);
  return (
    <span
      ref={ref}
      className={cn(
        "status-ping absolute inline-flex h-full w-full rounded-full",
        props.toneClass,
      )}
      style={{ opacity: peakOpacity }}
    />
  );
}
