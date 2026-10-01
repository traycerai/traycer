import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SideTabRowVariant } from "./side-tab-row";
import {
  SIDE_STRIP_LIST_CLASS,
  SIDE_TAB_ROW_PLACEHOLDER_CLASS,
  SIDE_TAB_TILE_CLASS,
} from "./side-strip-tokens";

/**
 * The row list before the windows bridge hydrates: one placeholder per
 * persisted strip ref at the row (or tile) size, so the list keeps its height
 * across the hydration boundary. The top block and the foot stay live above
 * and below it.
 */
export function SideStripSkeleton(props: {
  readonly count: number;
  readonly variant: SideTabRowVariant;
}): ReactNode {
  const collapsed = props.variant === "collapsed";
  return (
    <div
      data-testid="side-strip-skeleton"
      aria-busy
      aria-label="Restoring open tabs"
      className={cn(
        SIDE_STRIP_LIST_CLASS[props.variant],
        "min-h-0 flex-[0_1_auto] overflow-hidden [-webkit-app-region:no-drag]",
      )}
    >
      {Array.from({ length: props.count }, (_, index) => (
        <Skeleton
          key={index}
          data-testid="side-strip-skeleton-row"
          className={cn(
            "shrink-0",
            collapsed
              ? cn(SIDE_TAB_TILE_CLASS, "self-center")
              : SIDE_TAB_ROW_PLACEHOLDER_CLASS,
          )}
        />
      ))}
    </div>
  );
}
