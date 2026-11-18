import { useLayoutEffect } from "react";
import {
  animate,
  useMotionValue,
  useTransform,
  type MotionValue,
} from "motion/react";
import type { StripGroupPlacement } from "@/components/epic-canvas/dnd/strip-group-layout";
import { useHeaderTabDisplacementTransition } from "./tab-chrome-tokens";

/** What a group's chrome draws while a drag lays the strip out around it. */
export interface GroupChromeMotion {
  /** How far the chrome has moved along the strip's axis. */
  readonly offset: MotionValue<number>;
  /** The bottom inset, in px, that makes the block's fill reach `grow` further. */
  readonly reach: MotionValue<string>;
  /** Whether a drag has placed the group, so its chrome draws as the layout says. */
  readonly placed: boolean;
  /** False once the group has no tab left. */
  readonly visible: boolean;
}

/**
 * The motion of a group's chrome (a block's fill and header, a chip) to where
 * the drag's layout puts it, on the spring the tabs move on, so they move as
 * one. At rest, and the frame a drop commits, the chrome is where it is drawn
 * at once: the commit has laid the strip out as the preview was, so there is
 * nothing to spring to, and the tabs carry their own re-base.
 */
export function useGroupChromeMotion(
  placement: StripGroupPlacement | null,
): GroupChromeMotion {
  const transition = useHeaderTabDisplacementTransition();
  const placed = placement !== null;
  const offsetTarget = placement?.offset ?? 0;
  const growTarget = placement?.grow ?? 0;
  const offset = useMotionValue(offsetTarget);
  const grow = useMotionValue(growTarget);
  const reach = useTransform(grow, (value) => `${String(-value)}px`);
  useLayoutEffect(() => {
    if (!placed) {
      offset.jump(0);
      grow.jump(0);
      return;
    }
    animate(offset, offsetTarget, transition);
    animate(grow, growTarget, transition);
  }, [placed, offsetTarget, growTarget, transition, offset, grow]);
  return { offset, reach, placed, visible: placement?.visible ?? true };
}
