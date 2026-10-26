import { useRef, type CSSProperties, type ReactNode } from "react";
import {
  GROUND_RESIZE_HANDLE_LINE_CLASS,
  pointerDragHandleAxisClassName,
  usePointerDragCommit,
} from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import { cn } from "@/lib/utils";
import {
  BOT_PANE_BOUNDS,
  clampBotPaneWidth,
  useBotPaneWidthsStore,
  type BotPane,
} from "@/stores/bots/bot-pane-widths-store";

/** One arrow-key press moves the edge by this much. */
const KEYBOARD_RESIZE_STEP_PX = 24;

/** Where the handle sits: the pane's edge that faces the channel. */
const HANDLE_EDGE_CLASS: Record<"left" | "right", string> = {
  left: "left-0",
  right: "right-0",
};

interface PaneDragState {
  readonly pane: HTMLElement;
  readonly startWidth: number;
  readonly initialWidth: string;
  latestWidth: number;
}

/**
 * A pane of a bot tab the person widens or narrows by dragging the edge that
 * faces the channel (decision 80): the channel sidebar's right edge, the
 * thread panel's left. On the shared `usePointerDragCommit` machine, the
 * width is written to the pane per frame with no React render and stored
 * once on release, per device (`useBotPaneWidthsStore`); double-click resets
 * it and the arrow keys nudge it. Toward the channel always grows the pane.
 *
 * The width reaches the pane as `--bot-pane-width`, so `className` decides
 * where it applies (beside the channel, not over it on a narrow tab), and
 * `handleClassName` hides the handle wherever it does not.
 */
export function BotResizablePane(props: {
  readonly pane: BotPane;
  /** The pane's edge that faces the channel. */
  readonly edge: "left" | "right";
  /** The handle's accessible name. */
  readonly label: string;
  readonly className: string;
  readonly handleClassName: string;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  const { pane, edge, label, className, handleClassName, testId, children } =
    props;
  const widthPx = useBotPaneWidthsStore((state) => state.widthPx[pane]);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<PaneDragState | null>(null);
  const sign = edge === "left" ? -1 : 1;
  const bounds = BOT_PANE_BOUNDS[pane];

  const sliderProps = usePointerDragCommit({
    axis: "horizontal",
    onDragStart: () => {
      const element = paneRef.current;
      if (element === null) return false;
      const startWidth = element.getBoundingClientRect().width;
      dragRef.current = {
        pane: element,
        startWidth,
        initialWidth: element.style.getPropertyValue("--bot-pane-width"),
        latestWidth: startWidth,
      };
      return true;
    },
    onDragFrame: (deltaPx) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const next = clampBotPaneWidth(pane, drag.startWidth + deltaPx * sign);
      drag.latestWidth = next;
      // Direct DOM write: no React render while the pointer moves.
      drag.pane.style.setProperty("--bot-pane-width", `${next}px`);
    },
    onDragCommit: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      useBotPaneWidthsStore.getState().setWidthPx(pane, drag.latestWidth);
    },
    onDragCancel: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      drag.pane.style.setProperty("--bot-pane-width", drag.initialWidth);
    },
    onReset: () => {
      useBotPaneWidthsStore.getState().resetWidth(pane);
    },
    onKeyNudge: (direction) => {
      useBotPaneWidthsStore
        .getState()
        .setWidthPx(pane, widthPx + direction * sign * KEYBOARD_RESIZE_STEP_PX);
    },
  });

  return (
    <div
      ref={paneRef}
      data-testid={testId}
      className={cn("relative", className)}
      style={{ "--bot-pane-width": `${widthPx}px` } as CSSProperties}
    >
      {children}
      <div
        {...sliderProps}
        aria-valuenow={widthPx}
        aria-valuemin={bounds.minPx}
        aria-valuemax={bounds.maxPx}
        aria-label={label}
        data-testid={`${testId}-resize-handle`}
        className={cn(
          "absolute inset-y-0 z-20 focus-visible:bg-ring focus-visible:outline-hidden",
          HANDLE_EDGE_CLASS[edge],
          pointerDragHandleAxisClassName("horizontal"),
          GROUND_RESIZE_HANDLE_LINE_CLASS,
          handleClassName,
        )}
      />
    </div>
  );
}
