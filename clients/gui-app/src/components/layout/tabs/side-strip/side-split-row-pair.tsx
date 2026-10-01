import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SideRowFrame, SideTabRowVariant } from "./side-tab-row";
import {
  SIDE_SPLIT_PAIR_CLASS,
  SIDE_SPLIT_PAIR_COLLAPSED_HAIRLINE_CLASS,
  SIDE_SPLIT_PAIR_EXPANDED_HAIRLINE_CLASS,
  SIDE_SPLIT_PAIR_HAIRLINE_CLASS,
  SIDE_SPLIT_PAIR_SEAM_CLASS,
} from "./side-strip-tokens";

export interface SideSplitRowPairProps {
  /** The pair's own element props: its role and aria. */
  readonly frame: SideRowFrame;
  readonly variant: SideTabRowVariant;
  /** `split-tab-group-<id>`. */
  readonly testId: string;
  /** The top member row. */
  readonly first: ReactNode;
  /** The bottom member row. */
  readonly second: ReactNode;
}

/**
 * A split pair in the vertical strip: its two member rows (or, collapsed, two
 * tiles) joined in one container: a shared fill and a seam holding a hairline
 * between the members, with a radius that stays concentric around the rows.
 */
export function SideSplitRowPair(props: SideSplitRowPairProps) {
  const { frame } = props;
  const expanded = props.variant === "expanded";
  return (
    <div
      {...frame}
      data-testid={props.testId}
      data-side-split-pair={props.variant}
      className={cn(
        "flex flex-col",
        SIDE_SPLIT_PAIR_CLASS,
        !expanded && "self-center",
        frame.className,
      )}
    >
      {props.first}
      <span
        aria-hidden
        data-testid="side-split-row-pair-seam"
        className={cn(
          SIDE_SPLIT_PAIR_SEAM_CLASS,
          "pointer-events-none flex w-full shrink-0 items-center justify-center",
        )}
      >
        <span
          className={cn(
            SIDE_SPLIT_PAIR_HAIRLINE_CLASS,
            expanded
              ? SIDE_SPLIT_PAIR_EXPANDED_HAIRLINE_CLASS
              : SIDE_SPLIT_PAIR_COLLAPSED_HAIRLINE_CLASS,
          )}
        />
      </span>
      {props.second}
    </div>
  );
}
