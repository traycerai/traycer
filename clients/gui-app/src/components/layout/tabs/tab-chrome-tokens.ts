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
 * Deliberately crisper than the tab layout spring (ζ≈1.05, ω≈35.7,
 * ~174ms to settle, no overshoot) because the general layout spring settles in
 * ~258ms — which reads as lagging next to Chrome, whose displaced tab covers its
 * visible 230 native px in 142ms with a strictly decaying per-frame delta.
 * Scaled for our 191px tabs against Chrome's 235px, the comparable visible
 * segment is ~115ms.
 *
 * Overdamped on purpose: Chrome's displacement has zero overshoot, and an
 * overshoot here would read as a bounce Chrome does not have.
 */
export const HEADER_TAB_REORDER_TRANSITION = {
  type: "spring",
  stiffness: 700,
  damping: 41,
  mass: 0.55,
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
