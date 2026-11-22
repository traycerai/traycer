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
 * `stillWaiting`, which is false once the clock has reached the deadline, the
 * attach has ended, or `confirm` has settled. It checks that before starting
 * any read; a read it already started finishes and commits as any read does.
 *
 * The deadline is a time, compared with `Date.now()` (the clock the timer
 * runs on) at each check. The timer only releases the wait and decides
 * nothing: a stalled runtime can run a read's continuation after the
 * deadline but before the timer's callback.
 */
export async function confirmRowWithin(
  confirm: (stillWaiting: () => boolean) => Promise<unknown>,
  attach: RowConfirmationAttach,
): Promise<void> {
  const deadline = Date.now() + ROW_CONFIRM_CEILING_MS;
  let settled = false;
  let clearCeiling = (): void => undefined;
  const ceiling = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ROW_CONFIRM_CEILING_MS);
    clearCeiling = () => clearTimeout(timer);
  });
  try {
    await Promise.race([
      confirm(
        () => !settled && Date.now() < deadline && attach.current(),
      ).then(
        () => undefined,
        () => undefined,
      ),
      ceiling,
    ]);
  } finally {
    settled = true;
    clearCeiling();
  }
}
