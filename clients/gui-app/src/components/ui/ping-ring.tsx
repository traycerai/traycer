import { useCallback, useRef } from "react";
import {
  STATUS_ANIMATION_PULSE_CADENCE_MS,
  useStatusAnimation,
} from "@/lib/animation/status-animation-clock";
import { cn } from "@/lib/utils";

const CYCLE_MS = 1000;
const ACTIVE_FRACTION = 0.75;

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** The expanding, fading ring behind a live dot. */
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
  // Back to the resting look the element mounts with (the JSX `style` below): React only rewrites `style` when
  // the prop changes, so the cleanup has to restore it, not blank it.
  const clear = useCallback(
    (element: HTMLSpanElement) => {
      element.style.transform = "";
      element.style.opacity = String(peakOpacity);
    },
    [peakOpacity],
  );
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
