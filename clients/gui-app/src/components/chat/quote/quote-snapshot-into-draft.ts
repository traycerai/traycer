import {
  appendQuoteToDraft,
  buildQuoteBlockquote,
} from "./append-quote-to-draft";
import type { QuoteSelectionSnapshot } from "./use-quote-selection";

/**
 * Puts a validated selection snapshot into a chat tab's draft and clears the
 * browser selection it came from. The one quote action behind every trigger:
 * the floating popover's button and a native shell's edit-menu item
 * (`use-native-quote-request.ts`) both land here, so they cannot drift in
 * what a quote becomes. Consumes the SNAPSHOT, never the live `Selection` -
 * the popover's click can arrive after Chromium retargets the selection.
 */
export function quoteSnapshotIntoDraft(
  taskId: string,
  snapshot: QuoteSelectionSnapshot,
): void {
  appendQuoteToDraft(
    taskId,
    buildQuoteBlockquote({
      text: snapshot.text,
      fenceLanguage: snapshot.fenceLanguage,
    }),
  );
  clearBrowserSelection();
}

/** Collapses the page's selection once what it selected has been quoted. */
export function clearBrowserSelection(): void {
  const selection = window.getSelection();
  if (selection === null) return;
  selection.removeAllRanges();
}
