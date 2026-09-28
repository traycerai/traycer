import { useRef, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  GROUND_RESIZE_HANDLE_LINE_CLASS,
  pointerDragHandleAxisClassName,
  usePointerDragCommit,
} from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import { cn } from "@/lib/utils";
import {
  useSideStripCollapsed,
  useSideTabStripStore,
} from "@/stores/layout/side-tab-strip-store";
import {
  SIDE_STRIP_MAX_WIDTH_PX,
  SIDE_STRIP_MIN_WIDTH_PX,
  SIDE_STRIP_RAIL_WIDTH_PX,
  SIDE_STRIP_SNAP_TO_RAIL_BELOW_PX,
} from "./side-strip-tokens";

/** One arrow-key press moves the edge by this much. */
const KEYBOARD_RESIZE_STEP_PX = 24;

/** Which side of the strip faces the content, where the handle sits. */
const HANDLE_EDGE_CLASS: Record<EdgeSide, string> = {
  left: "right-0",
  right: "left-0",
};

interface StripDragState {
  readonly strip: HTMLElement;
  readonly startWidth: number;
  latestWidth: number;
  /** The layout the strip draws for `latestWidth`: the stored one until a crossing. */
  drawnCollapsed: boolean;
}

/**
 * The strip's width handle on its content-facing edge (S-20), on the shared
 * `usePointerDragCommit` machine: `style.width` is written per frame with no
 * React render, and the store once on release. The drag and the arrow nudge
 * are negated for a right-edge strip, so moving toward the content always
 * grows it. A release below the snap point collapses the strip and keeps the
 * stored width; from the rail, a release past it expands. Double-click resets
 * to the default width.
 *
 * The layout follows the drag (F9): the frame that carries the width across
 * the snap point switches the strip between the rail and the expanded layout
 * through the store's transient `dragCollapsed`, rendered synchronously so the
 * new layout and the new width paint together. That crossing is a jump between
 * the rail and the minimum, not pointer tracking, so the same render turns on
 * the strip's width easing and the jump eases like the collapse button's
 * (L-165); every other frame, the release and a cancel are instant, and the
 * drag's start stops an ease still running. The release (or a cancel) clears
 * `dragCollapsed` in the same batch as its store write.
 */
export function SideStripResizeHandle(props: {
  readonly edge: EdgeSide;
  readonly stripRef: RefObject<HTMLElement | null>;
  /** Eases the width change of the render it is called in. */
  readonly easeWidth: () => void;
  /** Ends any width easing synchronously, so the next width lands instantly. */
  readonly stopWidthEasing: () => void;
}): ReactNode {
  const { edge, stripRef, easeWidth, stopWidthEasing } = props;
  const widthPx = useSideTabStripStore((state) => state.widthPx);
  const collapsed = useSideStripCollapsed();
  const dragRef = useRef<StripDragState | null>(null);
  const sign = edge === "right" ? -1 : 1;

  const sliderProps = usePointerDragCommit({
    axis: "horizontal",
    onDragStart: () => {
      const strip = stripRef.current;
      if (strip === null) return false;
      stopWidthEasing();
      const startWidth = strip.getBoundingClientRect().width;
      dragRef.current = {
        strip,
        startWidth,
        latestWidth: startWidth,
        drawnCollapsed: useSideTabStripStore.getState().collapsed,
      };
      return true;
    },
    onDragFrame: (deltaPx) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const nextWidth = previewWidthOf(drag.startWidth + deltaPx * sign);
      drag.latestWidth = nextWidth;
      const nextCollapsed = collapsesAt(nextWidth);
      if (nextCollapsed !== drag.drawnCollapsed) {
        drag.drawnCollapsed = nextCollapsed;
        const state = useSideTabStripStore.getState();
        // Synchronous, so the width written below lands after React's own
        // write of the strip's width for the new layout, in the same frame.
        flushSync(() => {
          state.setDragCollapsed(
            nextCollapsed === state.collapsed ? null : nextCollapsed,
          );
          easeWidth();
        });
      }
      drag.strip.style.width = `${nextWidth}px`;
    },
    onDragCommit: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      stopWidthEasing();
      // The width as rendered after the last frame, so a floor or cap the
      // strip's own classes apply (S-43, the 40vw cap) is what gets stored.
      const renderedWidth = drag.strip.getBoundingClientRect().width;
      commitReleasedWidth(drag.latestWidth, renderedWidth);
      settleStripWidth(drag.strip);
    },
    onDragCancel: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      stopWidthEasing();
      useSideTabStripStore.getState().setDragCollapsed(null);
      settleStripWidth(drag.strip);
    },
    onReset: () => {
      const state = useSideTabStripStore.getState();
      state.resetWidth();
      state.setCollapsed(false);
    },
    onKeyNudge: (direction) => {
      nudgeWidth(direction === sign ? 1 : -1);
    },
  });

  return (
    <div
      {...sliderProps}
      aria-valuenow={collapsed ? SIDE_STRIP_RAIL_WIDTH_PX : widthPx}
      aria-valuemin={SIDE_STRIP_RAIL_WIDTH_PX}
      aria-valuemax={SIDE_STRIP_MAX_WIDTH_PX}
      aria-valuetext={collapsed ? "Collapsed" : undefined}
      aria-label="Resize tabs"
      data-testid="side-tab-strip-resize-handle"
      className={cn(
        "absolute inset-y-0 z-20 focus-visible:bg-ring focus-visible:outline-hidden [-webkit-app-region:no-drag]",
        HANDLE_EDGE_CLASS[edge],
        pointerDragHandleAxisClassName("horizontal"),
        GROUND_RESIZE_HANDLE_LINE_CLASS,
      )}
    />
  );
}

/**
 * The width a drag frame shows: below the snap point the rail's own width, the
 * moment the pointer crosses it, so the rail is never drawn in a wider strip;
 * above it the pointer's width, never under the minimum. The preview is the
 * width a release there commits.
 */
function previewWidthOf(rawWidth: number): number {
  if (rawWidth < SIDE_STRIP_SNAP_TO_RAIL_BELOW_PX)
    return SIDE_STRIP_RAIL_WIDTH_PX;
  return Math.min(
    SIDE_STRIP_MAX_WIDTH_PX,
    Math.max(SIDE_STRIP_MIN_WIDTH_PX, rawWidth),
  );
}

/** Whether a drag at this width draws, and a release there commits, the rail. */
function collapsesAt(width: number): boolean {
  return width < SIDE_STRIP_SNAP_TO_RAIL_BELOW_PX;
}

/**
 * A released drag: below the snap point collapses, anything else expands at
 * the width the strip rendered. The drag's live layout clears in the same
 * batch, so the strip never draws the pre-drag layout in between.
 */
function commitReleasedWidth(
  draggedWidth: number,
  renderedWidth: number,
): void {
  const state = useSideTabStripStore.getState();
  state.setDragCollapsed(null);
  if (collapsesAt(draggedWidth)) {
    state.setCollapsed(true);
    return;
  }
  state.setWidthPx(Math.round(renderedWidth));
  state.setCollapsed(false);
}

/**
 * Leaves the strip at the width its stored state renders. React skips a style
 * write whose value it rendered last, and after a crossing that is the drag's
 * layout's width, not the DOM's; so the width is written here rather than
 * handed back to an inline value React may never rewrite.
 */
function settleStripWidth(strip: HTMLElement): void {
  const { collapsed, widthPx } = useSideTabStripStore.getState();
  strip.style.width = `${collapsed ? SIDE_STRIP_RAIL_WIDTH_PX : widthPx}px`;
}

/**
 * One arrow press, `grow` already signed for the edge: from the rail a grow
 * expands; expanded, the width steps and a step below the minimum collapses.
 */
function nudgeWidth(grow: 1 | -1): void {
  const state = useSideTabStripStore.getState();
  if (state.collapsed) {
    if (grow === 1) state.setCollapsed(false);
    return;
  }
  const next = state.widthPx + grow * KEYBOARD_RESIZE_STEP_PX;
  if (next < SIDE_STRIP_MIN_WIDTH_PX) {
    state.setCollapsed(true);
    return;
  }
  state.setWidthPx(next);
}
