import {
  ROW_CONFIRM_CEILING_MS,
  settledWithin,
} from "@traycer-clients/shared/host-transport/row-confirmation";

/** The one directory call a confirmation makes. */
interface CatchingUpDirectory {
  catchUpAfterHidden(stillWaiting: () => boolean): Promise<void>;
}

/**
 * A remote attach's row confirmation in this window
 * (`confirmRowBeforeSignIn`), a wait. A shown window that skipped no registry
 * change has a current row, so it stands at once. A window that is hidden, or
 * possibly stale from having been, waits for the directory's read of what it
 * skipped (`HostDirectoryService.catchUpAfterHidden`), however many reads that
 * takes, within one row re-read ceiling measured from the confirmation's
 * start. Then the row the directory holds decides: a read that committed has
 * moved it, and one that failed or ran past the ceiling leaves the row last
 * read, as every attach before had.
 */
export function confirmRowWhenHidden(
  directory: () => CatchingUpDirectory | null,
): () => Promise<void> {
  return async () => {
    const current = directory();
    if (current === null) return;
    let waiting = true;
    try {
      await settledWithin(
        current.catchUpAfterHidden(() => waiting),
        ROW_CONFIRM_CEILING_MS,
      );
    } finally {
      waiting = false;
    }
  };
}
