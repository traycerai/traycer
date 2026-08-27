import { useLayoutEffect, type RefObject } from "react";
import {
  animate,
  useMotionValue,
  type MotionValue,
  type Transition,
} from "motion/react";
import {
  registerTileStripItem,
  syncTileStripItem,
} from "./tile-strip-commit-handoff";

export function useTileTabDisplacement(input: {
  readonly nodeRef: RefObject<HTMLElement | null>;
  readonly offsetX: number;
  readonly transition: Transition;
}): MotionValue<number> {
  const { nodeRef, offsetX, transition } = input;
  const x = useMotionValue(offsetX);
  useLayoutEffect(() => registerTileStripItem(x), [x]);
  useLayoutEffect(() => {
    syncTileStripItem({
      value: x,
      node: nodeRef.current,
      targetX: offsetX,
      transition,
    });
  });
  useLayoutEffect(() => {
    animate(x, offsetX, transition);
  }, [offsetX, transition, x]);
  return x;
}
