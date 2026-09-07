/** The single definition of the hover-preview card surface: a normal popover card (bordered, rounded, elevated)
 * rather than a plain tooltip's inverted `bg-foreground`/`text-background` chip. */
export const HOVER_PREVIEW_SURFACE_CLASS =
  "overflow-hidden rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-lg";

/** Scroll area inside a hover-preview card. */
export const HOVER_PREVIEW_SCROLL_CLASS =
  "min-h-0 overflow-y-auto overscroll-contain px-3 py-2";
