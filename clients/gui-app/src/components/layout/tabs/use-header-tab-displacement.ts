import { useLayoutEffect, type RefObject } from "react";
import {
  animate,
  useMotionValue,
  type MotionValue,
  type Transition,
} from "motion/react";
import {
  registerHeaderStripItem,
  syncHeaderStripItem,
} from "./header-strip-commit-handoff";

/**
 * Drive a header tab's displacement transform.
 *
 * The value is bound through `style`, not `animate`, because the commit frame
 * needs an INSTANTANEOUS re-base and an `animate` target cannot express one -
 * it would spring the correction, which is the defect rather than the fix.
 *
 * The re-base itself is NOT performed here. It runs from the strip container
 * over every registered item, because an item's correction has to depend on
 * whether its baseline moved and never on whether React re-rendered it - this
 * component is memoized, so those are different questions. See
 * `header-strip-commit-handoff.ts`.
 *
 * The frame's ref belongs to the CALLER rather than being handed back: a hook
 * that returns a ref alongside a value taints the whole returned object as
 * ref-like, and every read of it then counts as reading a ref during render.
 */
export function useHeaderTabDisplacement(input: {
  readonly nodeRef: RefObject<HTMLElement | null>;
  readonly offsetX: number;
  readonly transition: Transition;
}): MotionValue<number> {
  const { nodeRef, offsetX, transition } = input;
  const x = useMotionValue(offsetX);

  useLayoutEffect(() => registerHeaderStripItem(x), [x]);

  // No dependency array on purpose: the element and the target are re-published
  // on EVERY render because both can change. React can recreate the node, and a
  // registry holding a stale one would leave this item exempt from every commit
  // while reading as registered.
  useLayoutEffect(() => {
    syncHeaderStripItem({
      value: x,
      node: nodeRef.current,
      targetX: offsetX,
      transition,
    });
  });

  useLayoutEffect(() => {
    animate(x, offsetX, transition);
    // Deliberately no `stop()` on cleanup. Motion replaces the running
    // animation when a new one starts on the same value, and the container's
    // re-base starts one AFTER this effect - so a cleanup here would cancel the
    // correction rather than tidy up after it.
  }, [offsetX, transition, x]);

  return x;
}
