import {
  confirmRowWithin,
  type RowConfirmationAttach,
} from "@traycer-clients/shared/host-transport/row-confirmation";

/** The one directory call a confirmation makes. */
interface CatchingUpDirectory {
  catchUpAfterHidden(
    stillWaiting: () => boolean,
    ended: Promise<void>,
  ): Promise<void>;
}

/**
 * A remote attach's row confirmation in this window
 * (`confirmRowBeforeSignIn`), a wait. A shown window with no mark outstanding
 * has a current row, so it stands at once. A window that is hidden, or has a
 * mark outstanding (a hidden span, a skipped push or an era change since its
 * last qualifying read), waits for the directory's read
 * (`HostDirectoryService.catchUpAfterHidden`), however many reads that takes,
 * within one row re-read ceiling measured on the monotonic clock from the
 * confirmation's start, and starts no read once that ceiling passes or the
 * attach ends (`confirmRowWithin`). Then the row the directory holds decides:
 * a read that committed has moved it, and one that failed or ran past the
 * ceiling leaves the row last read.
 */
export function confirmRowWhenHidden(
  directory: () => CatchingUpDirectory | null,
): (attach: RowConfirmationAttach) => Promise<void> {
  return async (attach) => {
    const current = directory();
    if (current === null) return;
    await confirmRowWithin(
      (stillWaiting, ended) => current.catchUpAfterHidden(stillWaiting, ended),
      attach,
    );
  };
}
