/**
 * Ticket 23 (D20 port): the marker-scoped panel-resize freeze's imperative
 * visible-row snapshot. Pure DOM, no React and no LegendList API surface -
 * `chat-timeline.tsx` calls these from a `registerPanelResizeParticipant`
 * capture/clear pair (see `lib/layout/panel-resizing-class.ts`), once per
 * drag. `ChatTimelineRow`'s own freeze selector targets everything WITHOUT
 * this attribute, so marking is exact: only rows marked here stay live.
 */
export const PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE = "data-panel-resize-visible";

const MESSAGE_ROW_SELECTOR = "[data-message-id]";

/**
 * One-shot, bounded geometry walk over `scrollableNode`'s OWN mounted rows -
 * never the whole document, so each mounted `ChatTimeline` only ever marks
 * its own rows. A row is marked "visible" when its rect vertically
 * intersects the scrollable node's own viewport rect, boundary-inclusive (a
 * row straddling the edge counts as visible, so a reader never sees a hidden
 * sliver mid-drag). Rows are always full-width within the scroller, so only
 * the vertical axis matters.
 *
 * Self-healing: every row is explicitly set OR unset on every call, so this
 * fully replaces the marker set relative to the currently mounted rows -
 * regardless of what markers were left over from an earlier call. This
 * matters because the registry (`lib/layout/panel-resizing-class.ts`)
 * isolates a participant's `clear` failure rather than letting it block the
 * drag lifecycle; without the explicit unset branch, a marker surviving a
 * failed clear would persist through every later capture too, silently
 * keeping an offscreen row live.
 */
export function captureChatTimelineVisibleRows(
  scrollableNode: HTMLElement,
): void {
  const viewport = scrollableNode.getBoundingClientRect();
  const rows =
    scrollableNode.querySelectorAll<HTMLElement>(MESSAGE_ROW_SELECTOR);
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom >= viewport.top && rect.top <= viewport.bottom) {
      row.setAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE, "true");
    } else {
      row.removeAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE);
    }
  }
}

/** Clears only markers this same scrollable node's capture could have set. */
export function clearChatTimelineVisibleRows(
  scrollableNode: HTMLElement,
): void {
  const marked = scrollableNode.querySelectorAll<HTMLElement>(
    `[${PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE}]`,
  );
  for (const row of marked) {
    row.removeAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE);
  }
}
