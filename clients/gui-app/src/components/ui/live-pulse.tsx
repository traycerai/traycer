import { PingRing } from "@/components/ui/ping-ring";
import { cn } from "@/lib/utils";

export type LivePulseSize = "xs" | "sm" | "md";
export type LivePulseTone = "active" | "idle";

interface LivePulseProps {
  size: LivePulseSize;
  tone: LivePulseTone;
  ariaLabel: string;
  className: string | undefined;
}

const SIZE_CLASS: Record<LivePulseSize, string> = {
  xs: "size-1.5",
  sm: "size-2",
  md: "size-2.5",
};

const TONE_CLASS: Record<LivePulseTone, string> = {
  active: "bg-emerald-500",
  idle: "bg-muted-foreground/50",
};

const ACTIVE_RING_PEAK_OPACITY = 0.75;

export function LivePulse(props: LivePulseProps) {
  const { size, tone, ariaLabel, className } = props;
  const toneClass = TONE_CLASS[tone];

  return (
    <span
      aria-label={ariaLabel}
      className={cn("relative inline-flex", SIZE_CLASS[size], className)}
    >
      {tone === "active" ? (
        <PingRing
          toneClass={toneClass}
          peakOpacity={ACTIVE_RING_PEAK_OPACITY}
        />
      ) : null}
      <span
        className={cn(
          "relative inline-flex h-full w-full rounded-full",
          toneClass,
        )}
      />
    </span>
  );
}
