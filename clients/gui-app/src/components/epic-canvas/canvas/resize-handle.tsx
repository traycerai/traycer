/**
 * Custom split-container resize handle.
 *
 * Pointer/keyboard mechanics live in the shared `usePointerDragCommit`
 * state machine; this component keeps only the adjacent-pair fraction
 * math. During a drag NO React state changes: the handle mutates
 * `style.flexGrow` on its two adjacent sibling child wrappers per frame
 * (refs resolved from the DOM at pointer-down), and commits the final
 * fractions to the store ONCE on pointer-up via `onCommitSizes`. The
 * global `traycer-panel-resizing` class freezes expensive overlays for the
 * drag's duration (see `lib/layout/panel-resizing-class.ts`).
 *
 * Double-click equalizes the containing group's fractions. Arrow keys nudge
 * the pair by 5% per press (committed immediately - keyboard resize has no
 * "drag" phase).
 */
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { MIN_SPLIT_SIZE } from "@/stores/epics/canvas/tile-tree-constants";
import { evenSizes } from "@/stores/epics/canvas/tile-tree";
import type { SplitDirection } from "@/stores/epics/canvas/tile-tree";
import {
  computeResizeHandleSizes,
  resizeHandleSizesEqual,
} from "./resize-handle-sizes";
import {
  pointerDragHandleAxisClassName,
  usePointerDragCommit,
} from "./use-pointer-drag-commit";

const KEYBOARD_STEP_RATIO = 0.05;

interface SplitResizeHandleProps {
  readonly groupId: string;
  /** Index of the child BEFORE this handle within the group. */
  readonly index: number;
  readonly direction: SplitDirection;
  /** The group's committed fractions (one per child). */
  readonly sizes: ReadonlyArray<number>;
  /**
   * Px floor for each adjacent child while the container can afford it
   * (canvas panes pass `MIN_PANE_PX`; sidebar sections pass their own,
   * much smaller floor). The fraction floor `MIN_SPLIT_SIZE` applies
   * regardless.
   */
  readonly minChildPx: number;
  readonly className: string | undefined;
  readonly onCommitSizes: (
    groupId: string,
    sizes: ReadonlyArray<number>,
  ) => void;
}

interface DragState {
  readonly containerSize: number;
  readonly minSize: number;
  readonly previousChild: HTMLElement;
  readonly nextChild: HTMLElement;
  latestSizes: ReadonlyArray<number>;
}

function isSplitChild(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement && element.dataset.splitChild !== undefined
  );
}

export function SplitResizeHandle(props: SplitResizeHandleProps) {
  const { groupId, index, direction, sizes, minChildPx, onCommitSizes } = props;
  const horizontal = direction === "horizontal";
  const dragRef = useRef<DragState | null>(null);

  const restoreCommittedPair = (drag: DragState): void => {
    drag.previousChild.style.flexGrow = String(sizes[index]);
    drag.nextChild.style.flexGrow = String(sizes[index + 1]);
  };

  const sliderProps = usePointerDragCommit({
    axis: direction,
    onDragStart: (event) => {
      const handle = event.currentTarget;
      const container = handle.parentElement;
      const previousChild = handle.previousElementSibling;
      const nextChild = handle.nextElementSibling;
      if (
        container === null ||
        !isSplitChild(previousChild) ||
        !isSplitChild(nextChild)
      ) {
        return false;
      }
      const rect = container.getBoundingClientRect();
      const containerSize = horizontal ? rect.width : rect.height;
      if (containerSize <= 0) return false;
      dragRef.current = {
        containerSize,
        // The px floor follows the live container: a child never shrinks
        // below `minChildPx` while the container can afford it, and never
        // below the fraction floor regardless.
        minSize: Math.max(MIN_SPLIT_SIZE, minChildPx / containerSize),
        previousChild,
        nextChild,
        latestSizes: sizes,
      };
      return true;
    },
    onDragFrame: (deltaPx) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const nextSizes = computeResizeHandleSizes({
        sizes,
        index,
        deltaRatio: deltaPx / drag.containerSize,
        minSize: drag.minSize,
      });
      drag.latestSizes = nextSizes;
      // Direct DOM mutation - zero React renders while the pointer moves.
      drag.previousChild.style.flexGrow = String(nextSizes[index]);
      drag.nextChild.style.flexGrow = String(nextSizes[index + 1]);
    },
    onDragCommit: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      if (!resizeHandleSizesEqual(drag.latestSizes, sizes)) {
        onCommitSizes(groupId, drag.latestSizes);
        return;
      }
      // Nothing moved: restore the committed fractions on the mutated pair.
      restoreCommittedPair(drag);
    },
    onDragCancel: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      // Cancelled: restore the committed fractions on the mutated pair.
      restoreCommittedPair(drag);
    },
    onReset: () => {
      onCommitSizes(groupId, evenSizes(sizes.length));
    },
    onKeyNudge: (nudgeDirection) => {
      onCommitSizes(
        groupId,
        computeResizeHandleSizes({
          sizes,
          index,
          deltaRatio: nudgeDirection * KEYBOARD_STEP_RATIO,
          minSize: MIN_SPLIT_SIZE,
        }),
      );
    },
  });

  const fraction = sizes[index];
  return (
    <div
      {...sliderProps}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Resize pane"
      data-testid="split-resize-handle"
      // NOT `data-group-id`: that attribute marks tab-group panes, and the
      // canvas focus-navigation `readTileRects` collects every `[data-group-id]`
      // as a focus target. A handle sits exactly on the seam between two panes,
      // so it would win the spatial neighbour search - but its id is a split
      // GROUP id, not a pane id, so the focus update would silently no-op.
      // Keep handles on their own attribute so focus nav never sees them.
      data-resize-group-id={groupId}
      data-handle-index={index}
      className={cn(
        "relative z-10 shrink-0 bg-border ring-offset-background focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        pointerDragHandleAxisClassName(direction),
        props.className,
      )}
    />
  );
}
