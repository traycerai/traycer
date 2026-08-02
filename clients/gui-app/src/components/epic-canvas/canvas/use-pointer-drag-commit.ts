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
 *
 * Ticket 21 wave-2 live pass (row 1): once `onDragStart` succeeds, move/up/
 * cancel/blur are handled via `window`-level listeners rather than React
 * props on the handle. `setPointerCapture` is supposed to make the handle
 * the sole recipient of subsequent pointer events regardless of what else
 * is under the cursor, but a live divider drag under a stacked-plane layout
 * (a later DOM-order sibling with its own `pointer-events:auto` content
 * abutting the handle's seam) showed `onDragStart` succeeding (capture
 * engaged, the `traycer-panel-resizing` class active) while every
 * subsequent move/up event silently failed to reach the handle's own
 * listeners for the duration of the drag - not reproducible in jsdom, since
 * this repo's test setup stubs both `setPointerCapture` and
 * `elementFromPoint` to inert no-ops (jsdom implements neither real pointer
 * capture nor real hit-testing). A `window` listener is reached by the
 * native event's normal bubble phase, independent of which element the
 * browser ends up treating as the authoritative pointer-capture target.
 *
 * Fix-round 2 (same live pass): moving ownership to imperative `window`
 * listeners means THIS hook alone is responsible for every terminal path,
 * not just pointerup/pointercancel:
 * - Blur must be a terminal event the hook itself owns (not just observed
 *   via `beginPanelResizeInteraction`'s own blur cleanup, which only clears
 *   the shared interaction id - it does not know about `dragRef` and cannot
 *   detach this hook's listeners). Without the hook's own blur listener,
 *   `onDragFrame` keeps firing on later moves after focus loss even though
 *   the resize-freeze lifecycle already ended.
 * - A component can unmount mid-drag (e.g. a structural op removes the
 *   pane). React only runs effect cleanups on unmount, and this hook had no
 *   effect - so nothing detached the listeners, and a later release could
 *   commit through a dead component's closures.
 * Every handler AND the detach function are declared inside `onPointerDown`
 * itself (`function` declarations, not top-level consts, so they can
 * reference each other regardless of textual order) and stored together on
 * `dragRef.current`. This makes them exact per-drag identities - the same
 * function references used to `addEventListener` are the ones used to
 * `removeEventListener`, and both the unmount-cleanup effect and every
 * window listener always act through the ONE currently-active drag record,
 * never a stale one from an earlier or later render.
 */
import { useEffect, useRef } from "react";
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
 *
 * Move/up/cancel are NOT exposed here - once a drag starts, they are handled
 * by `window`-level listeners attached imperatively (see module doc), not by
 * React props on the handle itself.
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
   * Cancels this exact drag: detaches this exact drag's window listeners,
   * releases pointer capture, stops the panel-resize interaction, and
   * restores via `onDragCancel` - never commits. Bound at drag-start with
   * that render's closures, so the unmount-cleanup effect (and blur) can
   * call it correctly regardless of how many renders happened since.
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
 * In-flow split divider footprint. The whole pointer region consumes layout
 * space; it never extends over either adjacent pane's content or native
 * scrollbar gutter.
 */
export function inFlowPointerDragHandleAxisClassName(
  axis: PointerDragAxis,
): string {
  return axis === "horizontal"
    ? "w-1 cursor-col-resize touch-none"
    : "h-1 cursor-row-resize touch-none";
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

  // Unmount safety net (fix-round 2, F2): a drag active when this component
  // unmounts (e.g. a structural op removes the pane mid-gesture) would
  // otherwise leak its window listeners and let a LATER pointerup commit
  // through a dead component. `drag.cancel` was captured at drag-start with
  // THAT render's exact closures/listener identities, so calling it here is
  // correct no matter how many (or how few) renders happened between
  // drag-start and unmount - this effect's own closure is never involved.
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

    // Declared as hoisted function declarations (not consts) so they can
    // reference each other regardless of textual order - `finish` needs
    // `detach`, `detach` needs the four handlers, three of the handlers need
    // `finish`. All close over `pointerId`/`startCoordinate`/`handleElement`/
    // `interactionId` from THIS `onPointerDown` invocation, never a
    // different render's.
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
    // Blur is a terminal event this hook owns directly (fix-round 2, F1):
    // `beginPanelResizeInteraction`'s own blur listener only clears the
    // shared interaction id for the panel-resize CSS class - it has no
    // knowledge of `dragRef` and cannot stop this hook from continuing to
    // mutate geometry on a later move. Blur always cancels, never commits;
    // it carries no pointerId to match against.
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

    // Registered before `beginPanelResizeInteraction`'s own window
    // pointerup/pointercancel/blur listeners (below) so this hook's own
    // commit/cancel decision - and its `stopPanelResizeInteraction()` call -
    // always runs first; `stop()` is idempotent, so the panel-resizing
    // class's own listener is then a harmless no-op for the same event.
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
