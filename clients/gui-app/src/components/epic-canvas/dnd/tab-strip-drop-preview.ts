/**
 * Tab-over-tab insertion-index math, ported from paseo's
 * `split-container-tab-drop-preview.ts`. Compares the dragged chip's center
 * against the hovered chip's center to decide before/after, yielding a raw
 * slot index in 0..N (with the source tab still counted). The canvas store's
 * `moveTabOnTabStrip` performs the same-group source-removal adjustment, so
 * the same index drives both the indicator line and the commit.
 *
 * Non-tab sources (sidebar node, git-diff tile, workspace file) keep the
 * pointer-x midpoint math in `dnd.ts` (`getArtifactTabDropIndexFromPoint`):
 * their dragged rect is a tree row whose center is far from the pointer, so
 * chip-center comparison would feel detached.
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
