import type { SizedValues } from "@/lib/layout/layout-values";

/**
 * Whether a dock member is on screen at all: its own Shown value, or the editor
 * pointing at a hidden one (L-14).
 *
 * Named once because the row's gate and the chip's used to disagree about it.
 * `planDockRow` asked `shown || ghost` while both chip derivations asked
 * `shown` alone, so a member that was Hidden AND Chip materialised as a full
 * ROW under the editor - the one picture of it the user was ever shown was the
 * one shape it never takes at rest.
 *
 * Named arguments, like its sibling below: two interchangeable booleans is a
 * signature a caller can swap and still compile, which is the class of mistake
 * this module exists to prevent (R2-09).
 */
export function dockMemberMaterialised(input: {
  readonly shown: boolean;
  readonly ghost: boolean;
}): boolean {
  return input.shown || input.ghost;
}

/**
 * Whether one dock member draws as a CHIP rather than as a full row.
 *
 * Both hosts that fold the dock read this - the real tile
 * (`chat-tile-lower-surfaces.tsx`) and the sample workspace
 * (`sample-workspace-body.tsx`) - so the two cannot drift apart again. The
 * caller still owns the per-tile REVEAL on top of it: a chip the user has
 * opened is not folded, and that is component state this function knows
 * nothing about.
 *
 * `hasContent` is a parameter rather than a read off the hotspot because the
 * chip's content gate is legitimately the broader of the two on a real tile -
 * a received A2A row with no descendants keeps the chip alive while the panel
 * the hotspot anchors has nothing of its own to draw.
 */
export function dockMemberFolded(input: {
  readonly values: SizedValues;
  readonly ghost: boolean;
  readonly hasContent: boolean;
}): boolean {
  return (
    dockMemberMaterialised({
      shown: input.values.shown === "shown",
      ghost: input.ghost,
    }) &&
    input.values.size === "chip" &&
    input.hasContent
  );
}
