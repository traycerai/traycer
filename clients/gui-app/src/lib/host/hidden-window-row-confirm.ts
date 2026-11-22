import {
  answeredWithin,
  ROW_CONFIRM_CEILING_MS,
} from "@traycer-clients/shared/host-transport/row-confirmation";
import { isDocumentVisible } from "@/lib/dom/document-visibility";

/** The one directory call a confirmation makes. */
interface RefreshableDirectory {
  refresh(): Promise<unknown>;
}

/**
 * A remote attach's row confirmation in this window
 * (`confirmRowBeforeSignIn`). A visible window applies each registry change as
 * it lands, so its row stands at once. A hidden one skips them, so it reads
 * the registry again first and waits at most the row re-read's ceiling. Then
 * the row the directory holds decides: a read that committed has moved it,
 * and one that failed or ran past the ceiling leaves the row last read, as
 * every attach before had. The answer is always `true`, since the row itself
 * is what the session reads.
 */
export function confirmRowWhenHidden(
  directory: () => RefreshableDirectory | null,
): () => Promise<boolean> {
  return async () => {
    const current = directory();
    if (current === null || isDocumentVisible()) return true;
    await answeredWithin(
      current.refresh().then(
        () => true,
        () => false,
      ),
      ROW_CONFIRM_CEILING_MS,
    );
    return true;
  };
}
