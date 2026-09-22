import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

interface TabChromeBackgroundProps {
  readonly fill: string;
  readonly borderColor: string | undefined;
  readonly coversBaseline: boolean;
  readonly className: string | undefined;
}

export function TabChromeBackground({
  fill,
  borderColor,
  coversBaseline,
  className,
}: TabChromeBackgroundProps) {
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 flex", className)}
    >
      <TabCap side="left" fill={fill} borderColor={borderColor} />
      <span
        data-testid="tab-chrome-center"
        className={cn(
          "-mx-px h-full flex-1 bg-[var(--swatch)]",
          borderColor && "border-t border-t-[var(--swatch-border)]",
        )}
        style={
          { "--swatch": fill, "--swatch-border": borderColor } as CSSProperties
        }
      />
      <TabCap side="right" fill={fill} borderColor={borderColor} />
      {coversBaseline ? (
        <span
          aria-hidden
          data-testid="tab-baseline-cover"
          className="absolute inset-x-0 bottom-0 z-0 h-px bg-[var(--swatch)]"
          style={{ "--swatch": fill } as CSSProperties}
        />
      ) : null}
    </span>
  );
}

function TabCap({
  side,
  fill,
  borderColor,
}: {
  side: "left" | "right";
  fill: string;
  borderColor: string | undefined;
}) {
  const d =
    side === "left"
      ? "M 24 0 H 22 A 10 10 0 0 0 12 10 V 24 A 12 12 0 0 1 0 36 H 24 Z"
      : "M 0 0 H 2 A 10 10 0 0 1 12 10 V 24 A 12 12 0 0 0 24 36 H 0 Z";
  // Match the 1px center border, header baseline, and task-surface-frame.
  // Inset the centered SVG stroke by half a pixel at the horizontal joins.
  const outline =
    side === "left"
      ? "M -2 35.5 H 0 A 12 12 0 0 0 12 23.5 V 10.5 A 10 10 0 0 1 22 0.5 H 24"
      : "M 0 0.5 H 2 A 10 10 0 0 1 12 10.5 V 23.5 A 12 12 0 0 0 24 35.5 H 26";
  return (
    <svg
      data-testid={`tab-cap-${side}`}
      viewBox="0 0 24 36"
      preserveAspectRatio="none"
      className="relative z-10 h-full w-6 shrink-0 overflow-visible"
    >
      <path d={d} fill={fill} />
      {borderColor ? (
        <path
          data-testid={`tab-cap-outline-${side}`}
          d={outline}
          fill="none"
          stroke={borderColor}
          strokeWidth="1"
          strokeLinecap="square"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}
