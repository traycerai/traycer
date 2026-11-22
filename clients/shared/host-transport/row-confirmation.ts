/**
 * How long a remote attach that would carry the sign-in waits for the host's
 * row to be read again (`RemoteReleasedSignOn.confirmRow`).
 */
export const ROW_CONFIRM_CEILING_MS = 5_000;

/** Resolves once `read` settles, or once `ceilingMs` passes first; never rejects. */
export async function settledWithin(
  read: Promise<unknown>,
  ceilingMs: number,
): Promise<void> {
  let clearCeiling = (): void => undefined;
  const ceiling = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ceilingMs);
    clearCeiling = () => clearTimeout(timer);
  });
  try {
    await Promise.race([
      read.then(
        () => undefined,
        () => undefined,
      ),
      ceiling,
    ]);
  } finally {
    clearCeiling();
  }
}
