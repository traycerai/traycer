import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TabChromeBackground } from "./tab-chrome-background";

const SPLIT_ROW_PADDING_CLASS = "pr-[clamp(0.75rem,5%,1.5rem)] pl-2";
const SPLIT_CONTROL_WIDTH_CLASS = "w-11";

interface SplitTabLayoutProps {
  readonly leftColor: string | null;
  readonly rightColor: string | null;
  readonly splitId: string;
  readonly selectedSide: "left" | "right" | null;
  readonly control: ReactNode;
  readonly left: ReactNode;
  readonly right: ReactNode;
}

/** Shared group layout keeps both member footprints equal in the strip and overlay. */
export function SplitTabLayout(props: SplitTabLayoutProps): ReactNode {
  return (
    <div className="relative flex w-full min-w-0 items-end">
      <div
        className={cn(
          "relative flex h-9 w-full min-w-0 items-center",
          SPLIT_ROW_PADDING_CLASS,
        )}
      >
        <span
          className={cn(
            "relative z-20 flex shrink-0 items-center",
            SPLIT_CONTROL_WIDTH_CLASS,
          )}
        >
          {props.control}
        </span>
        <div className="relative flex min-w-0 flex-1" data-split-member="left">
          {props.left}
        </div>
        {props.selectedSide === null ? (
          <span
            aria-hidden
            data-testid={`split-tab-divider-${props.splitId}`}
            className="relative z-20 my-2 w-px shrink-0 self-stretch bg-border/70"
          />
        ) : null}
        <div className="relative flex min-w-0 flex-1" data-split-member="right">
          {props.right}
        </div>
      </div>
      <SplitGroupUnderline
        leftColor={props.leftColor}
        rightColor={props.rightColor}
        splitId={props.splitId}
        selectedSide={props.selectedSide}
      />
    </div>
  );
}

function SplitGroupUnderline(props: {
  readonly leftColor: string | null;
  readonly rightColor: string | null;
  readonly splitId: string;
  readonly selectedSide: "left" | "right" | null;
}): ReactNode {
  return (
    <span
      aria-hidden="true"
      data-testid={`split-tab-group-underline-${props.splitId}`}
      style={{ color: "var(--color-primary)" }}
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-30 flex h-px",
        SPLIT_ROW_PADDING_CLASS,
      )}
    >
      <span
        data-testid={`split-tab-group-underline-control-${props.splitId}`}
        className={cn(
          "relative shrink-0 rounded-l-full bg-current",
          SPLIT_CONTROL_WIDTH_CLASS,
          props.selectedSide === "left" &&
            "after:absolute after:inset-y-0 after:-right-0.5 after:w-0.5 after:bg-current",
        )}
      />
      <span
        data-testid={`split-tab-group-underline-left-${props.splitId}`}
        style={{ color: props.leftColor ?? "var(--color-primary)" }}
        className={cn(
          "relative min-w-0 flex-1 rounded-l-full",
          props.selectedSide !== "left" && "bg-current",
          props.selectedSide === "right" &&
            "after:absolute after:inset-y-0 after:-right-0.5 after:w-0.5 after:bg-current",
        )}
      />
      <span
        className={cn(
          "shrink-0",
          props.selectedSide === null ? "w-px bg-current" : "w-0",
        )}
      />
      <span
        data-testid={`split-tab-group-underline-right-${props.splitId}`}
        style={{ color: props.rightColor ?? "var(--color-primary)" }}
        className={cn(
          "relative min-w-0 flex-1 rounded-r-full",
          props.selectedSide !== "right" && "bg-current",
          props.selectedSide === "left" &&
            "before:absolute before:inset-y-0 before:-left-0.5 before:w-0.5 before:bg-current",
        )}
      />
    </span>
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
 * Selection treatment for one member of a split group. The focused member uses
 * the same raised silhouette as an ordinary selected tab; group membership is
 * communicated independently by the split group's accent underline.
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
        coversBaseline
        className={undefined}
      />
    );
  }

  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-px inset-y-1 rounded-sm transition-colors duration-200 ease-out group-hover/tab:bg-accent/20"
    />
  );
}
