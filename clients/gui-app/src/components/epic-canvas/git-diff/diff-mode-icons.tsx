import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

// Custom diff-view glyphs modelled on diffshub's split control: a rounded square
// halved by a divider, with a deletion mark (-) on one side and an addition mark
// (+) on the other. Lucide has no +/- split icon, so these are hand-rolled to
// match lucide's API (currentColor fill, sizing via className).

// Split view: vertical divider, "-" left cell, "+" right cell.
export function DiffSplitIcon(props: SVGProps<SVGSVGElement>) {
  const { className, ...svgProps } = props;

  return (
    <svg
      {...svgProps}
      xmlns="http://www.w3.org/2000/svg"
      fill="currentcolor"
      viewBox="0 0 16 16"
      className={cn("size-4", className)}
    >
      <path d="M14 0H8.5v16H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2m-1.5 6.5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1a.5.5 0 0 1 1 0" />
      <path
        d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5.5V0zm.5 7.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1"
        opacity="0.3"
      />
    </svg>
  );
}

// Unified view: horizontal divider, "-" top cell, "+" bottom cell.
export function DiffUnifiedIcon(props: SVGProps<SVGSVGElement>) {
  const { className, ...svgProps } = props;

  return (
    <svg
      {...svgProps}
      xmlns="http://www.w3.org/2000/svg"
      fill="currentcolor"
      viewBox="0 0 16 16"
      className={cn("size-4", className)}
    >
      <path
        fillRule="evenodd"
        d="M16 14a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8.5h16zm-8-4a.5.5 0 0 0-.5.5v1h-1a.5.5 0 0 0 0 1h1v1a.5.5 0 0 0 1 0v-1h1a.5.5 0 0 0 0-1h-1v-1A.5.5 0 0 0 8 10"
        clipRule="evenodd"
      />
      <path
        fillRule="evenodd"
        d="M14 0a2 2 0 0 1 2 2v5.5H0V2a2 2 0 0 1 2-2zM6.5 3.5a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z"
        clipRule="evenodd"
        opacity="0.4"
      />
    </svg>
  );
}
