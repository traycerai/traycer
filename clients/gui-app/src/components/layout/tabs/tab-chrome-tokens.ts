import { useReducedMotion, type Transition } from "motion/react";

/**
 * Shared header-tab presentation tokens.
 *
 * These live outside `tab-strip-item.tsx` so both an ordinary tab and a split
 * group can size and animate identically without that component file exporting
 * non-components (which would cost it fast refresh).
 */
export const TAB_CLASS_BASE =
  "group/tab relative flex h-10 w-full min-w-0 items-center gap-1.5 px-[clamp(0.75rem,10%,1.5rem)] text-ui-sm transition-[color,transform] duration-300 ease-spring";

/**
 * Neighbour displacement while a tab is being dragged past it.
 *
 * A short, monotone tween deliberately replaces the previous overdamped
 * spring. The spring needed ~174ms to settle, so a quick adjacent gesture could
 * end before the neighbour visibly reached its new position and the tab read
 * as "chasing" the pointer. Chrome's displacement is strictly decaying with no
 * overshoot; this curve preserves that character while completing within the
 * duration of a fast one-slot gesture.
 */
export const HEADER_TAB_REORDER_TRANSITION = {
  type: "tween",
  duration: 0.09,
  ease: [0.2, 0, 0, 1],
} satisfies Transition;

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
    ? { duration: 0 }
    : { ...HEADER_TAB_REORDER_TRANSITION, opacity: { duration: 0 } };
}
