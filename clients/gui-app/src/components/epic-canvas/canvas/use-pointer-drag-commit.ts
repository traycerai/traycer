/**
 * After onDragStart, move/up/cancel/blur go through window listeners: setPointerCapture loses to a later pointer-events:auto sibling (jsdom cannot reproduce this).
 * During a drag, onDragFrame mutates the DOM only; the one store write is onDragCommit. Unmount and blur must detach the same listener identities stored on the drag record.
 */
import { useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { beginPanelResizeInteraction } from "@/lib/layout/panel-resizing-class";

/** Drag axis: "horizontal" tracks `clientX`, "vertical" tracks `clientY`. */
export type PointerDragAxis = "horizontal" | "vertical";

export interface UsePointerDragCommitArgs {
  readonly axis: PointerDragAxis;
  /**
   * Begin a drag session: resolve drag targets / clamp inputs from the DOM and stash them in a consumer-owned ref.
   * Return false to reject the drag (unexpected sibling shape, zero-size container, ...).
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
   * Arrow-key nudge along the axis (committed immediately): `1` for the grow key (ArrowRight / ArrowDown), `-1` for the shrink key (ArrowLeft / ArrowUp).
   */
  readonly onKeyNudge: (direction: 1 | -1) => void;
}

/**
 * Spread onto the handle element.
 * `role="slider"`: the focusable-resize- handle ARIA pattern (a separator role is treated as non-interactive by jsx-a11y, but the handle IS the interactive control adjusting the size).
 */
export interface PointerDragSliderProps {
  readonly role: "slider";
  readonly tabIndex: 0;
  readonly "aria-orientation": PointerDragAxis;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

interface ActivePointerDrag {
  readonly pointerId: number;
  readonly handleElement: HTMLDivElement;
  /**
   * Cancels this exact drag: detaches this exact drag's window listeners, releases pointer capture, stops the panel-resize interaction, and restores via `onDragCancel` - never commits.
   */
  readonly cancel: () => void;
}

let nextPointerResizeInteractionId = 0;
let activePointerResizeInteractionId: number | null = null;

function clearActivePointerResizeInteraction(interactionId: number): void {
  if (activePointerResizeInteractionId === interactionId) {
    activePointerResizeInteractionId = null;
  }
}

export function pointerDragHandleAxisClassName(axis: PointerDragAxis): string {
  return axis === "horizontal"
    ? "w-px cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-2.5 after:-translate-x-1/2"
    : "h-px cursor-row-resize touch-none after:absolute after:inset-x-0 after:top-1/2 after:h-2.5 after:-translate-y-1/2";
}

/**
 * The whole 4px pointer region consumes layout space, so the old visual returns without extending an invisible hit target over either adjacent pane's content or native scrollbar gutter.
 */
export function inFlowPointerDragHandleAxisClassName(
  axis: PointerDragAxis,
): string {
  return axis === "horizontal"
    ? "w-1 cursor-col-resize touch-none before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:content-['']"
    : "h-1 cursor-row-resize touch-none before:pointer-events-none before:absolute before:inset-x-0 before:top-1/2 before:h-px before:-translate-y-1/2 before:bg-border before:content-['']";
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

  // `drag.cancel` was captured at drag-start with THAT render's exact closures/listener identities, so calling it here is correct no matter how many (or how few) renders happened between drag-start and unmount - this effect's own closure is never involved.
  useEffect(() => {
    return () => {
      dragRef.current?.cancel();
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    if (activePointerResizeInteractionId !== null) return;
    if (!onDragStart(event)) return;
    event.preventDefault();
    const handleElement = event.currentTarget;
    const pointerId = event.pointerId;
    const startCoordinate = horizontal ? event.clientX : event.clientY;
    handleElement.setPointerCapture(pointerId);
    const interactionId = nextPointerResizeInteractionId + 1;
    nextPointerResizeInteractionId = interactionId;
    activePointerResizeInteractionId = interactionId;

    // All close over `pointerId`/`startCoordinate`/`handleElement`/ `interactionId` from THIS `onPointerDown` invocation, never a different render's.
    function handleMove(moveEvent: PointerEvent): void {
      if (dragRef.current === null || moveEvent.pointerId !== pointerId) {
        return;
      }
      onDragFrame(
        (horizontal ? moveEvent.clientX : moveEvent.clientY) - startCoordinate,
      );
    }
    function handleUp(upEvent: PointerEvent): void {
      if (dragRef.current === null || upEvent.pointerId !== pointerId) return;
      finish(true);
    }
    function handlePointerCancelEvent(cancelEvent: PointerEvent): void {
      if (dragRef.current === null || cancelEvent.pointerId !== pointerId) {
        return;
      }
      finish(false);
    }
    // Blur always cancels, never commits; it carries no pointerId to match against.
    function handleBlur(): void {
      finish(false);
    }
    function detach(): void {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handlePointerCancelEvent);
      window.removeEventListener("blur", handleBlur);
    }
    function finish(commit: boolean): void {
      if (dragRef.current === null) return;
      dragRef.current = null;
      detach();
      if (handleElement.hasPointerCapture(pointerId)) {
        handleElement.releasePointerCapture(pointerId);
      }
      const active = activePointerResizeInteractionId === interactionId;
      stopPanelResizeInteraction();
      if (commit && active) {
        onDragCommit();
        return;
      }
      onDragCancel();
    }

    // Registered before `beginPanelResizeInteraction`'s own window pointerup/pointercancel/blur listeners (below) so this hook's own commit/cancel decision - and its `stopPanelResizeInteraction()` call - always runs first; `stop()` is idempotent, so the panel-resizing class's own listener is then a harmless no-op for the same event.
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handlePointerCancelEvent);
    window.addEventListener("blur", handleBlur);
    const stopPanelResizeInteraction = beginPanelResizeInteraction(
      pointerId,
      () => {
        clearActivePointerResizeInteraction(interactionId);
      },
    );

    dragRef.current = {
      pointerId,
      handleElement,
      cancel: () => finish(false),
    };
  };

  return {
    role: "slider",
    tabIndex: 0,
    "aria-orientation": horizontal ? "vertical" : "horizontal",
    onPointerDown,
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
