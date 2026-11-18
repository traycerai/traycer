import { useCallback, useRef, useState, type PointerEvent } from "react";

/**
 * `down` owns the continuous preview until release; `active` and `moved`
 * survive release until the trailing click has been suppressed. The origin
 * distinguishes click jitter from a deliberate drag.
 */
interface PointerGesture {
  startX: number;
  startY: number;
  active: boolean;
  down: boolean;
  moved: boolean;
}

interface ReasoningSliderGesture {
  readonly position: number;
  readonly step: number;
  readonly dragging: boolean;
  readonly pressed: boolean;
  readonly onPointerDown: (event: PointerEvent<HTMLSpanElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLSpanElement>) => void;
  readonly finishPointer: () => void;
  readonly onPointerCancel: () => void;
  readonly onClick: () => void;
  readonly onValueChange: (next: number[]) => void;
  readonly movedByGesture: () => boolean;
}

/**
 * Slow the visible thumb slightly near each stop without a dead zone or a
 * jump at the midpoint. Cap the pull at 7% of an interval and 1.4% of the
 * total travel, so two-level catalogs do not resist the pointer more than
 * a six-level catalog. Endpoints and the selected level stay unchanged.
 */
export function reasoningDragPosition(
  position: number,
  lastIndex: number,
): number {
  const offset = position - Math.round(position);
  // Keep the coefficient below 1 / (2π): above that bound the thumb would
  // move backwards near a stop while the pointer continues forwards.
  const pull = 0.07 * Math.min(1, lastIndex / 5);
  return position - Math.sin(offset * Math.PI * 2) * pull;
}

export function useReasoningSliderGesture(
  thumbIndex: number,
  lastIndex: number,
  disabled: boolean,
  selectLevel: (index: number) => void,
): ReasoningSliderGesture {
  const gesture = useRef<PointerGesture>({
    active: false,
    down: false,
    moved: false,
    startX: 0,
    startY: 0,
  });
  const [dragging, setDragging] = useState(false);
  // Pointer travel is continuous; provider settings and keyboard steps remain
  // catalog indices. Releasing the pointer removes this preview so the thumb
  // eases onto the nearest committed level instead of jumping between stops.
  const [pointerValue, setPointerValue] = useState<number | null>(null);

  const finishPointer = () => {
    gesture.current.down = false;
    setPointerValue(null);
    setDragging(false);
  };

  const movedByGesture = useCallback(
    () => gesture.current.active && gesture.current.moved,
    [],
  );

  return {
    position:
      pointerValue === null
        ? thumbIndex
        : reasoningDragPosition(pointerValue, lastIndex),
    step: pointerValue === null ? 1 : 0.001,
    dragging,
    pressed: pointerValue !== null,
    onPointerDown: (event) => {
      if (disabled) return;
      setPointerValue(thumbIndex);
      gesture.current = {
        active: true,
        down: true,
        moved: false,
        startX: event.clientX,
        startY: event.clientY,
      };
      setDragging(false);
    },
    onPointerMove: (event) => {
      if (event.buttons === 0) {
        gesture.current.active = false;
        gesture.current.moved = false;
        finishPointer();
        return;
      }
      const start = gesture.current;
      if (!start.down) return;
      const distance = Math.hypot(
        event.clientX - start.startX,
        event.clientY - start.startY,
      );
      if (distance > 3) setDragging(true);
    },
    finishPointer,
    onPointerCancel: () => {
      finishPointer();
      gesture.current.active = false;
      gesture.current.moved = false;
    },
    // A drag starting on a stop delivers its trailing click to that same
    // stop. Keep `moved` through release so it cannot undo the drag's value.
    onClick: () => {
      gesture.current.active = false;
      gesture.current.moved = false;
    },
    onValueChange: (next) => {
      const position = next.at(0) ?? thumbIndex;
      if (gesture.current.down) {
        gesture.current.moved = true;
        setPointerValue(position);
      }
      selectLevel(Math.round(position));
    },
    movedByGesture,
  };
}
