import type { Transition } from "motion/react";

/**
 * Shared header-tab presentation tokens.
 *
 * These live outside `tab-strip-item.tsx` so both an ordinary tab and a split
 * group can size and animate identically without that component file exporting
 * non-components (which would cost it fast refresh).
 */
export const TAB_CLASS_BASE =
  "group/tab relative flex h-10 w-full min-w-0 items-center gap-1.5 px-[clamp(0.75rem,10%,1.5rem)] text-ui-sm transition-[color,transform] duration-300 ease-spring";

export const HEADER_TAB_LAYOUT_TRANSITION = {
  type: "spring",
  stiffness: 520,
  damping: 42,
  mass: 0.72,
} satisfies Transition;
