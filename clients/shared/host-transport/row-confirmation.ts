/**
 * How long a remote attach that would carry the sign-in waits for the host's
 * row to be read again (`RemoteReleasedSignOn.confirmRow`).
 */
export const ROW_CONFIRM_CEILING_MS = 5_000;

/** The attach a row confirmation is waited on for. */
export interface RowConfirmationAttach {
  /** False once that attach has ended: retired, or its session closed. */
  readonly current: () => boolean;
}

/**
 * Runs one row confirmation for `attach`, bounded by the one ceiling measured
 * from its start; resolves when `confirm` settles or the ceiling passes, and
 * never rejects.
 *
 * The confirmation's loop lives no longer than the confirmation: it is handed
 * `stillWaiting`, which turns false at the ceiling (in the timer's own
 * callback, so no read can start past it), once the attach ends, and once
 * `confirm` has settled. It checks that before starting any read; a read it
 * already started finishes and commits as any read does.
 */
export async function confirmRowWithin(
  confirm: (stillWaiting: () => boolean) => Promise<unknown>,
  attach: RowConfirmationAttach,
): Promise<void> {
  let over = false;
  let clearCeiling = (): void => undefined;
  const ceiling = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      over = true;
      resolve();
    }, ROW_CONFIRM_CEILING_MS);
    clearCeiling = () => clearTimeout(timer);
  });
  try {
    await Promise.race([
      confirm(() => !over && attach.current()).then(
        () => undefined,
        () => undefined,
      ),
      ceiling,
    ]);
  } finally {
    over = true;
    clearCeiling();
  }
}
