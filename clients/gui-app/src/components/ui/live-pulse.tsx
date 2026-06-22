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

export function LivePulse(props: LivePulseProps) {
  const { size, tone, ariaLabel, className } = props;
  const toneClass = TONE_CLASS[tone];

  return (
    <span
      aria-label={ariaLabel}
      className={cn("relative inline-flex", SIZE_CLASS[size], className)}
    >
      {tone === "active" ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
            toneClass,
          )}
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
