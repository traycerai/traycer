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

/** The value is bound through `style`, not `animate`, because the commit frame needs an instantaneous re-base
 * and an `animate` target cannot express one. */
export function useHeaderTabDisplacement(input: {
  readonly nodeRef: RefObject<HTMLElement | null>;
  readonly offsetX: number;
  readonly transition: Transition;
}): MotionValue<number> {
  const { nodeRef, offsetX, transition } = input;
  const x = useMotionValue(offsetX);

  useLayoutEffect(() => registerHeaderStripItem(x), [x]);

  // React can recreate the node, and a registry holding a stale one would leave this item exempt from every
  // commit while reading as registered.
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
    // Motion replaces the running animation when a new one starts on the same value, and the container's re-base
    // starts one after this effect - so a cleanup here would cancel the correction rather than tidy up after it.
  }, [offsetX, transition, x]);

  return x;
}
