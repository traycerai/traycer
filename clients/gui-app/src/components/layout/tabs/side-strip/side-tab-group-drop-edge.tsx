import type { ReactNode } from "react";
import * as m from "motion/react-m";
import { DropLine } from "@/components/ui/drop-line";
import { cn } from "@/lib/utils";
import { SIDE_TAB_DROP_LINE_SEAT_CLASS } from "./side-strip-tokens";
import type { SideTabRowVariant } from "./side-tab-row";

/**
 * A drop's insertion line on a group's outer edge, in the gap beside the block
 * or column: the drop lands outside the group, at its end or between two groups,
 * where no row's own edge is outside it.
 */
export function SideTabGroupDropEdge(props: {
  readonly edge: "top" | "bottom";
  readonly variant: SideTabRowVariant;
}): ReactNode {
  return (
    <m.span
      aria-hidden
      data-testid="tab-drop-indicator"
      data-side={props.edge === "top" ? "before" : "after"}
      initial={{ opacity: 0, scaleX: 0.45 }}
      animate={{ opacity: 1, scaleX: 1 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
      className={cn(
        "pointer-events-none absolute inset-x-2 z-20 origin-center",
        SIDE_TAB_DROP_LINE_SEAT_CLASS[props.variant][
          props.edge === "top" ? "before" : "after"
        ],
      )}
    >
      <DropLine
        orientation="horizontal"
        glow={false}
        className="w-full"
        testId={undefined}
      />
    </m.span>
  );
}
