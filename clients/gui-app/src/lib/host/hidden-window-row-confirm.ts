import {
  ROW_CONFIRM_CEILING_MS,
  settledWithin,
} from "@traycer-clients/shared/host-transport/row-confirmation";
import { isDocumentVisible } from "@/lib/dom/document-visibility";

/** The one directory call a confirmation makes. */
interface RefreshableDirectory {
  refresh(): Promise<unknown>;
}

/**
 * A remote attach's row confirmation in this window
 * (`confirmRowBeforeSignIn`), a wait. A visible window applies each registry
 * change as it lands, so its row stands at once. A hidden one skips them, so
 * it reads the registry again first and waits at most the row re-read's
 * ceiling. Then the row the directory holds decides: a read that committed has
 * moved it, and one that failed or ran past the ceiling leaves the row last
 * read, as every attach before had.
 */
export function confirmRowWhenHidden(
  directory: () => RefreshableDirectory | null,
): () => Promise<void> {
  return async () => {
    const current = directory();
    if (current === null || isDocumentVisible()) return;
    await settledWithin(current.refresh(), ROW_CONFIRM_CEILING_MS);
  };
}
