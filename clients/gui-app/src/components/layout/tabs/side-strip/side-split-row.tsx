import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SplitFocusIcon } from "../split-tab-chrome";
import type { SideRowFrame, SideTabRowVariant } from "./side-tab-row";
import {
  SIDE_SPLIT_RAIL_CLASS,
  SIDE_SPLIT_ROW_CLASS,
  SIDE_SPLIT_ROW_LINE_CLASS,
} from "./side-strip-tokens";

export interface SideSplitRowProps {
  /** The pair's own element props: its role, name, join and ref. */
  readonly frame: SideRowFrame;
  readonly variant: SideTabRowVariant;
  /** `split-tab-group-<id>`. */
  readonly testId: string;
  /** The split icon: the actions button, or the bare icon on the drag overlay. */
  readonly icon: ReactNode;
  readonly left: ReactNode;
  readonly right: ReactNode;
  /** The Activity view's second line under the halves, or `null`. */
  readonly detail: ReactNode | null;
}

/**
 * The split icon where it opens no menu: on the drag overlay, and on a pair
 * whose halves are both empty. Sized and toned as the actions button is.
 */
export function SideSplitIcon(props: {
  readonly splitId: string;
  readonly focusedSide: "left" | "right";
  readonly engaged: boolean;
}): ReactNode {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center",
        props.engaged ? "text-info-foreground" : "text-muted-foreground",
      )}
    >
      <SplitFocusIcon
        splitId={props.splitId}
        focusedSide={props.focusedSide}
        size="size-4"
      />
    </span>
  );
}

/**
 * A split pair in the vertical strip, as paint only. Expanded, it is one row:
 * the split icon, then its two halves side by side, each a tab of its own,
 * and the second line under them when a half needs the person. In the rail it
 * is the icon over the two halves' tiles in one container.
 */
export function SideSplitRow(props: SideSplitRowProps): ReactNode {
  const { frame } = props;
  const expanded = props.variant === "expanded";
  return (
    <div
      {...frame}
      data-testid={props.testId}
      data-side-split-pair={props.variant}
      className={cn(
        expanded ? SIDE_SPLIT_ROW_CLASS : SIDE_SPLIT_RAIL_CLASS,
        frame.className,
      )}
    >
      {expanded ? (
        <>
          <div className={SIDE_SPLIT_ROW_LINE_CLASS}>
            {props.icon}
            {props.left}
            {props.right}
          </div>
          {props.detail}
        </>
      ) : (
        <>
          {props.icon}
          {props.left}
          {props.right}
        </>
      )}
    </div>
  );
}
