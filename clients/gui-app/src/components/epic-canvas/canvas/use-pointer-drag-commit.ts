/**
 * Shared pointer state machine for "drag-to-resize, commit-on-release"
 * handles (the canvas/sidebar-section `SplitResizeHandle` and the hoisted
 * sidebar's width handle).
 *
 * Owns the generic mechanics every handle would otherwise duplicate:
 * primary-button + pointer-capture bookkeeping with pointerId matching, the
 * global `traycer-panel-resizing` freeze (see
 * `lib/layout/panel-resizing-class.ts`), per-frame axis deltas,
 * commit-on-pointer-up vs restore-on-pointer-cancel, double-click reset,
 * and the axis-aware arrow-key nudge.
 *
 * Consumers keep ONLY their clamp math and DOM mutation: resolve drag
 * targets in `onDragStart` (stashed in a consumer-owned ref), mutate styles
 * in `onDragFrame`, and decide what commit/restore mean for their store.
 * During a drag NO React state changes - `onDragFrame` must mutate the DOM
 * directly; the single store write happens in `onDragCommit`.
 */
import { useRef } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { beginPanelResizeInteraction } from "@/lib/layout/panel-resizing-class";

/** Drag axis: "horizontal" tracks `clientX`, "vertical" tracks `clientY`. */
export type PointerDragAxis = "horizontal" | "vertical";

export interface UsePointerDragCommitArgs {
  readonly axis: PointerDragAxis;
  /**
   * Begin a drag session: resolve drag targets / clamp inputs from the DOM
   * and stash them in a consumer-owned ref. Return false to reject the drag
   * (unexpected sibling shape, zero-size container, ...).
   */
  readonly onDragStart: (event: ReactPointerEvent<HTMLDivElement>) => boolean;
  /**
   * Per-frame delta in px along the axis since pointer-down. Direct DOM
   * mutation only - zero React renders while the pointer moves.
   */
  readonly onDragFrame: (deltaPx: number) => void;
  /** Pointer-up: commit the session's latest value to the store (once). */
  readonly onDragCommit: () => void;
  /** Pointer-cancel: restore the pre-drag DOM state; nothing is committed. */
  readonly onDragCancel: () => void;
  /** Double-click reset (committed immediately - no drag phase). */
  readonly onReset: () => void;
  /**
   * Arrow-key nudge along the axis (committed immediately): `1` for the
   * grow key (ArrowRight / ArrowDown), `-1` for the shrink key
   * (ArrowLeft / ArrowUp).
   */
  readonly onKeyNudge: (direction: 1 | -1) => void;
}

/**
 * Spread onto the handle element. `role="slider"`: the focusable-resize-
 * handle ARIA pattern (a separator role is treated as non-interactive by
 * jsx-a11y, but the handle IS the interactive control adjusting the size).
 * `aria-orientation` describes the divider line, which runs perpendicular
 * to the drag axis. Consumers add `aria-valuenow/min/max`, `aria-label`,
 * test ids, and className.
 */
export interface PointerDragSliderProps {
  readonly role: "slider";
  readonly tabIndex: 0;
  readonly "aria-orientation": PointerDragAxis;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

interface ActivePointerDrag {
  readonly pointerId: number;
  readonly startCoordinate: number;
  readonly interactionId: number;
  readonly stopPanelResizeInteraction: () => void;
}

let nextPointerResizeInteractionId = 0;
let activePointerResizeInteractionId: number | null = null;

function clearActivePointerResizeInteraction(interactionId: number): void {
  if (activePointerResizeInteractionId === interactionId) {
    activePointerResizeInteractionId = null;
  }
}

/**
 * Shared 1px visual line + widened invisible hit area (via `::after`) for a
 * given drag axis (inherently fixed touch target, allowed hardcoded size).
 */
export function pointerDragHandleAxisClassName(axis: PointerDragAxis): string {
  return axis === "horizontal"
    ? "w-px cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-2.5 after:-translate-x-1/2"
    : "h-px cursor-row-resize touch-none after:absolute after:inset-x-0 after:top-1/2 after:h-2.5 after:-translate-y-1/2";
}

export function usePointerDragCommit(
  args: UsePointerDragCommitArgs,
): PointerDragSliderProps {
  const {
    axis,
    onDragStart,
    onDragFrame,
    onDragCommit,
    onDragCancel,
    onReset,
    onKeyNudge,
  } = args;
  const horizontal = axis === "horizontal";
  const dragRef = useRef<ActivePointerDrag | null>(null);

  const endDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean,
  ): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const active = activePointerResizeInteractionId === drag.interactionId;
    drag.stopPanelResizeInteraction();
    if (commit && active) {
      onDragCommit();
      return;
    }
    onDragCancel();
  };

  return {
    role: "slider",
    tabIndex: 0,
    "aria-orientation": horizontal ? "vertical" : "horizontal",
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      if (activePointerResizeInteractionId !== null) return;
      if (!onDragStart(event)) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const interactionId = nextPointerResizeInteractionId + 1;
      nextPointerResizeInteractionId = interactionId;
      activePointerResizeInteractionId = interactionId;
      const stopPanelResizeInteraction = beginPanelResizeInteraction(
        event.pointerId,
        () => {
          clearActivePointerResizeInteraction(interactionId);
        },
      );
      dragRef.current = {
        pointerId: event.pointerId,
        startCoordinate: horizontal ? event.clientX : event.clientY,
        interactionId,
        stopPanelResizeInteraction,
      };
    },
    onPointerMove: (event) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      onDragFrame(
        (horizontal ? event.clientX : event.clientY) - drag.startCoordinate,
      );
    },
    onPointerUp: (event) => {
      endDrag(event, true);
    },
    onPointerCancel: (event) => {
      endDrag(event, false);
    },
    onDoubleClick: onReset,
    onKeyDown: (event) => {
      const grow = horizontal ? "ArrowRight" : "ArrowDown";
      const shrink = horizontal ? "ArrowLeft" : "ArrowUp";
      if (event.key !== grow && event.key !== shrink) return;
      event.preventDefault();
      onKeyNudge(event.key === grow ? 1 : -1);
    },
  };
}
