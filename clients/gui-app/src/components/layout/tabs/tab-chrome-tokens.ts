import { useReducedMotion, type Transition } from "motion/react";

/**
 * Shared header-tab presentation tokens.
 *
 * These live outside `tab-strip-item.tsx` so both an ordinary tab and a split
 * group can size and animate identically without that component file exporting
 * non-components (which would cost it fast refresh).
 */
export const TAB_CLASS_BASE =
  "group/tab relative flex h-9 w-full min-w-0 items-center gap-1.5 px-[clamp(0.75rem,10%,1.5rem)] text-ui-sm transition-[color,transform] duration-300 ease-spring";

/** Neighbour movement settles quickly without overshooting its open slot. */
export const HEADER_TAB_REORDER_TRANSITION = {
  type: "tween",
  duration: 0.16,
  ease: [0.2, 0, 0, 1],
} satisfies Transition;

const HEADER_TAB_DISPLACEMENT_TRANSITION: Transition = {
  ...HEADER_TAB_REORDER_TRANSITION,
  opacity: { duration: 0 },
};
const HEADER_TAB_REDUCED_MOTION_TRANSITION: Transition = { duration: 0 };

/**
 * Transition for a tab frame's displacement while a sibling is dragged past it.
 *
 * Under `prefers-reduced-motion` the order still changes - the strip must still
 * say where the tab is going - but it changes instantly, with no travel to
 * animate. Opacity never springs in either mode: the dragged tab's source frame
 * has to vanish on the same frame its overlay is painted, or the strip shows
 * two copies of one tab.
 */
export function useHeaderTabDisplacementTransition(): Transition {
  const reduceMotion = useReducedMotion() === true;
  return reduceMotion
    ? HEADER_TAB_REDUCED_MOTION_TRANSITION
    : HEADER_TAB_DISPLACEMENT_TRANSITION;
}
