// Radix renders nested overlays into separate portals, so their pointerdowns
// land "outside" the chip's Popover and would close it. Treat a click inside an
// overlay STACKED ABOVE this popover (a Select / Popover / Dialog opened from
// within it) as still "inside", but let a click on an ANCESTOR surface - the
// host dialog that contains the trigger, its backdrop, or a parent menu - close
// the popover as a normal outside click.
//
// Stacking is read from document order: Radix appends each overlay's portal to
// the end of <body> as it opens, so an overlay opened later (a true nested
// child) appears AFTER this popover's content, while a surface that was already
// open when the popover opened (an ancestor) appears BEFORE it. Comparing
// against this popover's own content node tells the two apart - which a bare
// selector match cannot, since the ancestor dialog and a stacked child dialog
// both match `[role="dialog"]`.
const NESTED_OVERLAY_SELECTORS: ReadonlyArray<string> = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="listbox"]',
  '[data-slot="select-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="dialog-overlay"]',
  '[data-slot="popover-content"]',
];

const NESTED_OVERLAY_SELECTOR = NESTED_OVERLAY_SELECTORS.join(",");

/** Whether an outside destination belongs to an overlay stacked above this surface. */
export function isNestedOverlayTarget(
  target: EventTarget | null,
  contentEl: HTMLElement | null,
): boolean {
  if (!(target instanceof Element)) return false;
  const overlay = target.closest(NESTED_OVERLAY_SELECTOR);
  if (overlay === null) return false;
  return (
    contentEl === null ||
    (contentEl.compareDocumentPosition(overlay) &
      Node.DOCUMENT_POSITION_FOLLOWING) !==
      0
  );
}
