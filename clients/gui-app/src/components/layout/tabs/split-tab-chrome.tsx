import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TabChromeBackground, TabColorMark } from "./tab-chrome-background";
import { TAB_BOX_CLASS } from "./tab-chrome-tokens";
import { useWhollyInTabStrip } from "./use-wholly-in-tab-strip";

const SPLIT_ROW_PADDING_CLASS = "pr-[clamp(0.75rem,5%,1.5rem)] pl-2";
const SPLIT_CONTROL_WIDTH_CLASS = "w-11";

interface SplitTabLayoutProps {
  readonly splitId: string;
  readonly selectedSide: "left" | "right" | null;
  /**
   * Whether the active pair runs into the sheet below as one tab: the pair
   * owns both surfaces under it, so the join is the group's
   * box and the focused member keeps its own box inside it.
   */
  readonly joined: boolean;
  readonly control: ReactNode;
  readonly left: ReactNode;
  readonly right: ReactNode;
}

/** Shared group layout keeps both member footprints equal in the strip and overlay. */
export function SplitTabLayout(props: SplitTabLayoutProps): ReactNode {
  const [node, setNode] = useState<HTMLSpanElement | null>(null);
  const inStrip = useWhollyInTabStrip(node, props.joined);
  return (
    <div className="relative flex w-full min-w-0 items-end">
      <div
        className={cn(
          "relative flex h-9 w-full min-w-0 items-center",
          SPLIT_ROW_PADDING_CLASS,
        )}
      >
        {props.joined ? (
          <span
            aria-hidden
            data-testid={`split-tab-joined-${props.splitId}`}
            ref={setNode}
            data-sheet-joined={inStrip ? "top" : undefined}
            className={cn(TAB_BOX_CLASS, "border border-transparent")}
          />
        ) : null}
        <span
          className={cn(
            "relative z-20 flex shrink-0 items-center",
            SPLIT_CONTROL_WIDTH_CLASS,
          )}
        >
          {props.control}
        </span>
        <div
          className="relative flex min-w-0 flex-1 [container-type:inline-size]"
          data-split-member="left"
        >
          {props.left}
        </div>
        {props.selectedSide === null ? (
          <span
            aria-hidden
            data-testid={`split-tab-divider-${props.splitId}`}
            className="relative z-20 my-2 w-px shrink-0 self-stretch bg-border/70"
          />
        ) : null}
        <div
          className="relative flex min-w-0 flex-1 [container-type:inline-size]"
          data-split-member="right"
        >
          {props.right}
        </div>
      </div>
    </div>
  );
}

export function SplitFocusIcon(props: {
  readonly splitId: string;
  readonly focusedSide: "left" | "right";
}): ReactNode {
  const leftFocused = props.focusedSide === "left";

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      data-testid={`split-focus-indicator-${props.splitId}`}
      data-focused-side={props.focusedSide}
      className="size-5"
    >
      <rect
        data-split-pane="left"
        data-focused={leftFocused ? "true" : "false"}
        x="3"
        y="4"
        width="8"
        height="16"
        rx="1.5"
        fill={leftFocused ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <rect
        data-split-pane="right"
        data-focused={leftFocused ? "false" : "true"}
        x="13"
        y="4"
        width="8"
        height="16"
        rx="1.5"
        fill={leftFocused ? "none" : "currentColor"}
        stroke="currentColor"
        strokeWidth="1.75"
      />
    </svg>
  );
}

/**
 * Selection treatment for one member of a split group. The focused member is
 * the same box as an ordinary selected tab, and a hover and a colour the same
 * box and mark as an ordinary tab's. The pair is one strip item under one
 * split control, which is what says they belong together.
 */
export function SplitMemberChrome(props: {
  readonly focused: boolean;
  readonly color: string | null;
}) {
  if (props.focused) {
    return (
      <TabChromeBackground
        fill="var(--color-background)"
        borderColor={props.color ?? "var(--color-primary)"}
        joined={false}
        className={undefined}
      />
    );
  }

  return (
    <>
      <span
        aria-hidden
        data-testid="tab-hover-box"
        className={cn(
          TAB_BOX_CLASS,
          "transition-colors duration-150 ease-out group-hover/tab:bg-foreground/5",
        )}
      />
      {props.color === null ? null : <TabColorMark color={props.color} />}
    </>
  );
}
