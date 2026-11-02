import { createContext } from "react";

import { quoteSnapshotIntoDraft } from "./quote-snapshot-into-draft";
import type { QuoteSelectionSnapshot } from "./use-quote-selection";

/**
 * Where a quoted selection of the chat `chatId` goes, for both triggers: the
 * floating popover's button and a native shell's edit-menu item. Clears the
 * browser selection it came from.
 */
export type QuoteSink = (
  chatId: string,
  snapshot: QuoteSelectionSnapshot,
) => void;

/**
 * The quote sink of the transcripts below. A task chat's draft by default; a
 * bot's channel puts the quote in its box that is open
 * (`bot-channel-view.tsx`), and `null` offers no quote at all, for a view
 * with no box to put it in (a bot's session).
 */
export const QuoteSinkContext = createContext<QuoteSink | null>(
  quoteSnapshotIntoDraft,
);
