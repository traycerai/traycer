import { useRef, type MouseEvent, type PointerEvent } from "react";

import { cn } from "@/lib/utils";

/**
 * The phone composer's two sizes: in flow under the content, or a sheet over
 * it. The surface that owns the editor owns this too, so it can drop back to
 * the compact size the moment a message is sent.
 */
export interface ComposerExpansion {
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
}

/** Vertical travel that reads as a deliberate pull rather than a wobble. */
const DRAG_THRESHOLD_PX = 24;

/**
 * The grabber pill on the top edge of the phone composer. A pull up expands
 * the composer into a sheet, a pull down puts it back, and a tap toggles - the
 * same three gestures an iOS sheet's grabber answers to. Pointer capture keeps
 * the drag on this element once it starts, and `preventDefault` on the press
 * keeps the editor focused so the keyboard does not dip mid-gesture.
 */
export function ComposerExpandHandle({
  expanded,
  onExpandedChange,
}: ComposerExpansion) {
  const startY = useRef<number | null>(null);
  const settled = useRef(false);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    startY.current = event.clientY;
    settled.current = false;
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    if (startY.current === null || settled.current) return;
    const travel = event.clientY - startY.current;
    if (travel <= -DRAG_THRESHOLD_PX && !expanded) {
      settled.current = true;
      onExpandedChange(true);
    } else if (travel >= DRAG_THRESHOLD_PX && expanded) {
      settled.current = true;
      onExpandedChange(false);
    }
  };
  const onPointerUp = (): void => {
    if (startY.current === null) return;
    startY.current = null;
    if (!settled.current) onExpandedChange(!expanded);
  };
  const onPointerCancel = (): void => {
    startY.current = null;
  };
  // Enter, Space and a screen reader's activation arrive as a `click` with no
  // pointer sequence in front of it; a real press has already toggled on
  // pointer-up and its trailing click carries a positive `detail`.
  const onClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (event.detail === 0) onExpandedChange(!expanded);
  };

  return (
    <button
      type="button"
      data-composer-expand-handle=""
      aria-label={expanded ? "Collapse composer" : "Expand composer"}
      aria-expanded={expanded}
      className={cn(
        "absolute inset-x-0 top-0 z-30 flex h-4 touch-none items-center justify-center",
        // The pill sits in the editor frame's top padding, so the press target
        // reaches up past the card edge rather than down into the first line.
        "after:absolute after:inset-x-0 after:-top-2 after:bottom-0 after:content-['']",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
    >
      <span aria-hidden className="h-1 w-9 rounded-full bg-foreground/25" />
    </button>
  );
}
