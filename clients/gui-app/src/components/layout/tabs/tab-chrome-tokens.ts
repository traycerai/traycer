import { useReducedMotion, type Transition } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * Shared header-tab presentation tokens.
 *
 * These live outside `tab-strip-item.tsx` so both an ordinary tab and a split
 * group can size and animate identically without that component file exporting
 * non-components (which would cost it fast refresh).
 */
export const TAB_CLASS_BASE =
  "group/tab relative flex h-9 w-full min-w-0 items-center gap-1.5 px-[var(--header-tab-padding,1.5rem)] text-ui-sm transition-[color,transform] duration-300 ease-spring";

/**
 * Where a header tab's box sits in its 36px frame: 2px in from every side, so
 * the box is 32px tall and centred in the 40px header, and neighbouring boxes
 * keep 4px of ground between them. The corners are the sheets' own
 * `radius-xl`: a hover, a split's focused member and an unjoined active tab
 * are this one box; the joined active tab is the same box opened at the
 * bottom onto the task tray (the tray join in `index.css`).
 */
export const TAB_BOX_CLASS =
  "pointer-events-none absolute inset-0.5 rounded-xl";

export const SPLIT_MEMBER_CLASS =
  "gap-1 px-[var(--header-tab-padding,1.25rem)]";
export const SPLIT_TAB_CONTROL_CLASS =
  "relative z-20 mr-1 flex h-7 w-10 shrink-0 items-center justify-center rounded-md";

export function headerTabClassName(
  chrome: "own" | "member",
  isActive: boolean,
): string {
  return cn(
    TAB_CLASS_BASE,
    chrome === "member" && SPLIT_MEMBER_CLASS,
    isActive
      ? "z-10 font-medium text-foreground"
      : "text-muted-foreground hover:text-foreground",
  );
}

export function splitFillableMemberClassName(focused: boolean): string {
  return cn(
    TAB_CLASS_BASE,
    SPLIT_MEMBER_CLASS,
    "text-muted-foreground",
    focused && "text-foreground",
  );
}

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

/**
 * Transition for the drag overlay fading out while a split preview shows and
 * back in when the drop is a move again: the displacement's own tween, so the
 * overlay leaves as the strip settles, and instant under reduced motion.
 */
export function useHeaderTabOverlayFadeTransition(): Transition {
  return useReducedMotion() === true
    ? { duration: 0 }
    : HEADER_TAB_REORDER_TRANSITION;
}
