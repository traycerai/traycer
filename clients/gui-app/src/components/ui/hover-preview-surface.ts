/**
 * The single definition of the hover-preview card surface: a normal popover
 * card (bordered, rounded, elevated) rather than a plain tooltip's inverted
 * `bg-foreground`/`text-background` chip.
 *
 * Every hover preview in the app renders on this surface - the composer's
 * @mention/slash preview panel (`MentionPreviewPanel`, positioned by
 * floating-ui) and the `HoverCard` previews (`HoverCardContent` /
 * `HoverPreviewCard`: the workspace picker's folder list and the chat/owner
 * workspace preview). They are anchored by different machinery, which is why
 * this is a shared class definition rather than a shared component; keeping the
 * surface in one place is what stops them from drifting into different-looking
 * cards again.
 *
 * Short label tooltips ("Copy", "⌘K", …) intentionally keep the inverted chip
 * surface - the split is preview-card vs. label-chip, not per-call-site taste.
 */
export const HOVER_PREVIEW_SURFACE_CLASS =
  "overflow-hidden rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-lg";

/**
 * Scroll area inside a hover-preview card. Owns the card's padding; callers
 * add their own width and `max-h-*` cap.
 */
export const HOVER_PREVIEW_SCROLL_CLASS =
  "min-h-0 overflow-y-auto overscroll-contain px-3 py-2";
