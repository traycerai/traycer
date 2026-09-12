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
          "-mx-px h-full flex-1",
          borderColor && "border-t-[1.5px]",
        )}
        style={{ backgroundColor: fill, borderTopColor: borderColor }}
      />
      <TabCap side="right" fill={fill} borderColor={borderColor} />
      {coversBaseline ? (
        <span
          aria-hidden
          data-testid="tab-baseline-cover"
          className="absolute inset-x-0 bottom-0 z-0 h-[1.5px]"
          style={{ backgroundColor: fill }}
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
  // SVG strokes are centered on their path. Inset the top edge by half the
  // stroke width so it occupies the same inside pixel row as the center's CSS
  // border; placing it at y=0 clips the outer half and makes the center look
  // like a second line at display scaling.
  const outline =
    side === "left"
      ? "M -2 35.25 H 0 A 12 12 0 0 0 12 23.25 V 10.75 A 10 10 0 0 1 22 0.75 H 24"
      : "M 0 0.75 H 2 A 10 10 0 0 1 12 10.75 V 23.25 A 12 12 0 0 0 24 35.25 H 26";
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
          strokeWidth="1.5"
          strokeLinecap="square"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}
