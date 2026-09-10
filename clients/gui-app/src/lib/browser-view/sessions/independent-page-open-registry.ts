/**
 * Tabs a PAGE opened on a device's `independent` browser session, waiting for
 * the Start Page panel to adopt them.
 *
 * The handshake exists because the two ends cannot see each other. The
 * coordinator is a module-scope stream owner with no React above it and no
 * canvas beneath it, and the panel learns about a new tab only from the
 * device's next inventory, which says WHAT exists and never who asked for it.
 * A `window.open` and a tab that was already there are the same row by then.
 *
 * So the frame records the identity here and the panel's reconciler consumes
 * it, which is also what keeps the rule narrow: an entry is consumed exactly
 * once, by whichever surface adopts that tab first, so a second window does not
 * also yank its selection onto a popup raised in the first.
 */

/** Bounded so a renderer with no Start Page mounted cannot grow this forever. */
const MAX_PENDING_PAGE_OPENS = 32;

const pendingPageOpens = new Map<string, IndependentPageOpen>();

export interface IndependentPageOpenedTab {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}

/** What the frame said about the open, beyond which tab it produced. */
export interface IndependentPageOpen {
  /**
   * The tab whose page raised it, or `null` when the device could not say.
   * Same session as the popup; the reconciler asks where that tab is on
   * screen to decide whether the popup was this window's reader's doing.
   */
  readonly openerTabId: string | null;
  /**
   * Whether THIS window's document held focus as the frame arrived. The
   * frame follows the reader's gesture by a round trip, and the OS gives
   * focus to one window, so for a popup whose pixels reach every window
   * (headless) it is what separates the window the gesture was made in from
   * another window showing the same row of the same session.
   */
  readonly raisedWhileFocused: boolean;
}

function pageOpenKey(tab: IndependentPageOpenedTab): string {
  return `${tab.hostId} ${tab.sessionId} ${tab.tabId}`;
}

/**
 * Records that the page in an independent session opened this tab itself.
 *
 * Called from the stream, so it must not reach into any store: the panel may
 * not be mounted at all, and a frame that arrives while it is not is answered
 * by the next reconciliation pass rather than dropped.
 */
export function recordIndependentPageOpenedTab(
  tab: IndependentPageOpenedTab & IndependentPageOpen,
): void {
  const key = pageOpenKey(tab);
  // Re-inserting would keep an already-recorded key at its original position,
  // which is the right eviction order anyway - delete first only to keep the
  // map's iteration honest about recency.
  pendingPageOpens.delete(key);
  pendingPageOpens.set(key, {
    openerTabId: tab.openerTabId,
    raisedWhileFocused: tab.raisedWhileFocused,
  });
  while (pendingPageOpens.size > MAX_PENDING_PAGE_OPENS) {
    const oldest = pendingPageOpens.keys().next();
    if (oldest.done === true) return;
    pendingPageOpens.delete(oldest.value);
  }
}

/**
 * What the page said when it opened this tab, consuming the record - or `null`
 * if the page did not open it.
 *
 * Consuming is the point: adopting a tab is a one-time event, and an entry left
 * behind would re-activate the same row on every later inventory push.
 */
export function consumeIndependentPageOpenedTab(
  tab: IndependentPageOpenedTab,
): IndependentPageOpen | null {
  const key = pageOpenKey(tab);
  const open = pendingPageOpens.get(key);
  if (open === undefined) return null;
  pendingPageOpens.delete(key);
  return open;
}

export function resetIndependentPageOpensForTests(): void {
  pendingPageOpens.clear();
}
