import { createContext, use } from "react";

/**
 * DOM node that nested Radix overlays (Popover/DropdownMenu) should portal
 * into instead of `document.body`. A modal Radix `Dialog` runs a body
 * scroll-lock that only recognizes wheel/touch scrolling on content that is
 * an actual DOM descendant of the dialog - an overlay portalled to
 * `document.body` renders as a DOM sibling of the dialog instead, so the lock
 * silently swallows wheel input over it even though the content itself
 * scrolls fine (e.g. via a dragged scrollbar or a programmatic `scrollTop`).
 * `null` outside a modal dialog, where portalling to `document.body` is fine.
 */
export const DialogOverlayBoundaryContext = createContext<HTMLElement | null>(
  null,
);

export function useDialogOverlayBoundaryEl(): HTMLElement | null {
  return use(DialogOverlayBoundaryContext);
}
