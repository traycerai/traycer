// Comparing against this popover's own content node tells the two apart - which a bare selector match cannot,
// since the ancestor dialog and a stacked child dialog both match `[role="dialog"]`.
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

/** `contentEl` is the popover's own content node (from a ref); when it is `null` the stacking order cannot be
 * read, so it falls back to the prior "any overlay preserves" behaviour. */
export function preserveWhenNestedOverlay(
  event: Event,
  contentEl: HTMLElement | null,
): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const overlay = target.closest(NESTED_OVERLAY_SELECTOR);
  if (overlay === null) return;
  if (contentEl === null) {
    event.preventDefault();
    return;
  }
  // `DOCUMENT_POSITION_FOLLOWING` is set when `overlay` comes after `contentEl` in document order (opened later
  // → stacked above, including descendant overlays portaled into this popover).
  const stackedAbove =
    (contentEl.compareDocumentPosition(overlay) &
      Node.DOCUMENT_POSITION_FOLLOWING) !==
    0;
  if (stackedAbove) event.preventDefault();
}
