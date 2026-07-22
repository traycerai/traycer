import {
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type HTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

const RATIO_STEP = 0.02;
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

export interface SplitDividerProps {
  readonly splitId: string;
  readonly leftRatio: number;
  readonly hostBoundsRef: RefObject<HTMLDivElement | null>;
  readonly onPreviewRatioChange: (ratio: number | null) => void;
}

/**
 * The drag keeps ratio transient until pointer release. That means Escape or
 * pointer cancellation restores the saved layout without a compensating store
 * write or persistence echo.
 */
export function SplitDivider(props: SplitDividerProps) {
  const originRef = useRef<number | null>(null);
  const commit = (ratio: number): void => {
    tabCommandCoordinator.resizeSplit({
      splitId: props.splitId,
      leftRatio: clampRatio(ratio),
    });
  };
  const ratioAtPointer = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = props.hostBoundsRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0) return props.leftRatio;
    return clampRatio((event.clientX - rect.left) / rect.width);
  };
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    originRef.current = props.leftRatio;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (originRef.current === null) return;
    originRef.current = null;
    const ratio = ratioAtPointer(event);
    props.onPreviewRatioChange(null);
    commit(ratio);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (originRef.current === null) return;
    props.onPreviewRatioChange(ratioAtPointer(event));
  };
  const restore = (): void => {
    originRef.current = null;
    props.onPreviewRatioChange(null);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      restore();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      commit(props.leftRatio - RATIO_STEP);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      commit(props.leftRatio + RATIO_STEP);
    }
    if (event.key === "Home") {
      event.preventDefault();
      commit(MIN_RATIO);
    }
    if (event.key === "End") {
      event.preventDefault();
      commit(MAX_RATIO);
    }
  };
  const percentage = Math.round(props.leftRatio * 100);
  const separatorA11yProps = {
    role: "separator",
    tabIndex: 0,
    "aria-label": "Resize split view",
    "aria-orientation": "vertical",
    "aria-valuemin": Math.round(MIN_RATIO * 100),
    "aria-valuemax": Math.round(MAX_RATIO * 100),
    "aria-valuenow": percentage,
    "aria-valuetext": `Left view ${percentage}%`,
  } satisfies HTMLAttributes<HTMLDivElement>;
  const separatorInteractionProps = {
    onDoubleClick: (): void => commit(0.5),
    onKeyDown: handleKeyDown,
    onPointerCancel: restore,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
  };

  return (
    <div
      {...separatorA11yProps}
      {...separatorInteractionProps}
      data-testid={`split-divider-${props.splitId}`}
      style={{ left: `${props.leftRatio * 100}%` }}
      className={cn(
        "absolute inset-y-0 z-30 w-3 -translate-x-1/2 border-l border-border bg-transparent",
        "cursor-col-resize touch-none outline-none focus-visible:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    />
  );
}

function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}
