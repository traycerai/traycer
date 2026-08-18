/**
 * Rows are located by the same `data-notification-id` attribute the scroll
 * anchor measures with, so traversal order is exactly the rendered feed order
 * (Needs attention, then Recent activity) with no second source of truth to
 * drift.
 */
const ROW_SELECTOR = "[data-notification-id]";

type FeedNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

function navigationKey(key: string): FeedNavigationKey | null {
  if (key === "ArrowDown" || key === "ArrowUp") return key;
  if (key === "Home" || key === "End") return key;
  return null;
}

function nextRowIndex(
  key: FeedNavigationKey,
  currentIndex: number,
  count: number,
): number {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  // Wraps at both ends, so holding one arrow cycles the whole feed rather
  // than dead-ending. `currentIndex === -1` means focus is somewhere in the
  // surface that isn't a row (the heading a keyboard open lands on, a header
  // control): Down enters at the top, Up enters at the bottom.
  if (key === "ArrowDown") {
    return currentIndex === -1 ? 0 : (currentIndex + 1) % count;
  }
  return currentIndex === -1 ? count - 1 : (currentIndex - 1 + count) % count;
}

/**
 * Up/Down/Home/End traversal of the notification feed. Bound to the center's
 * shell (see `useNotificationFeedKeyboardNavigation`) so it works from
 * anywhere inside the surface, including the heading a keyboard open focuses.
 *
 * Focus lands on the row element itself (`tabIndex={-1}`), not on one of its
 * controls, so every row is reachable - a read, non-navigable row has no
 * focusable control at all and would otherwise be skipped straight over. Tab
 * order is untouched: the rows are not tab stops, and their controls still
 * are.
 *
 * Bare keys only. A modified arrow belongs to whatever else claims it (the
 * global keybinding map runs in the capture phase and never reaches here).
 */
export function handleNotificationFeedKeyboardNavigation(
  shell: HTMLElement,
  event: KeyboardEvent,
): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const key = navigationKey(event.key);
  if (key === null) return;
  const rows = Array.from(shell.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  if (rows.length === 0) return;
  const active = document.activeElement;
  const currentIndex = rows.findIndex(
    (row) => row === active || row.contains(active),
  );
  const target = rows[nextRowIndex(key, currentIndex, rows.length)];
  // Claims the key from the scrollport, which would otherwise scroll under
  // the row we just moved focus to.
  event.preventDefault();
  target.focus();
  target.scrollIntoView({ block: "nearest" });
}
