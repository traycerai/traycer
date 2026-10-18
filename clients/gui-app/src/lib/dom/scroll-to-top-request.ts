/**
 * The request a scroll area receives when the user asks for its top - the iOS
 * status-bar tap (`useStatusBarTapScrollToTop`). Dispatched at the scroll area
 * itself and bubbling, so a component can answer for a scroller that remounts
 * by listening on a stable ancestor and checking `target`.
 */
export class ScrollToTopRequestEvent extends Event {
  static readonly type = "traycer:scroll-to-top-request";

  constructor(readonly animated: boolean) {
    super(ScrollToTopRequestEvent.type, { bubbles: true, cancelable: true });
  }
}

/**
 * Scrolls `scroller` to its top, unless something owns that scroll.
 *
 * A plain scroll area needs no code of its own: nobody answers the request
 * and it scrolls here. A scroll area whose position is driven by code - the
 * chat transcript, which keeps following the newest reply - would undo a bare
 * scroll, so it answers with `preventDefault()` and moves itself its own way.
 */
export function requestScrollToTop(
  scroller: HTMLElement,
  animated: boolean,
): void {
  const unanswered = scroller.dispatchEvent(
    new ScrollToTopRequestEvent(animated),
  );
  if (unanswered) {
    scroller.scrollTo({ top: 0, behavior: animated ? "smooth" : "instant" });
  }
}
