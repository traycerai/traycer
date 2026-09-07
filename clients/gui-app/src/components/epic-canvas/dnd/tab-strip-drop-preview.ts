/**
 * Compares the dragged chip's center against the hovered chip's center to decide before/after, yielding a raw slot index in 0..N (with the source tab still counted).
 * The canvas store's `moveTabOnTabStrip` performs the same-group source-removal adjustment, so the same index drives both the indicator line and the commit.
 */
import type { RectLike } from "@/components/epic-canvas/dnd/dnd";

export interface ComputeTabDropIndexInput {
  /** Index of the hovered tab within its strip. */
  readonly overIndex: number;
  /** Translated rect of the dragged chip. */
  readonly activeRect: RectLike;
  /** Rect of the hovered tab chip. */
  readonly overRect: RectLike;
}

export function computeTabDropIndex(input: ComputeTabDropIndexInput): number {
  if (input.overRect.width <= 0) return input.overIndex;
  const activeCenterX = input.activeRect.left + input.activeRect.width / 2;
  const overCenterX = input.overRect.left + input.overRect.width / 2;
  const insertAfterTarget = activeCenterX >= overCenterX;
  return input.overIndex + (insertAfterTarget ? 1 : 0);
}
