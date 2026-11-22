/**
 * How long a remote attach that would carry the sign-in waits for the host's
 * row to be read again (`RemoteReleasedSignOn.confirmRow`).
 */
export const ROW_CONFIRM_CEILING_MS = 5_000;

/** `confirmed`, or `null` (no answer) once `ceilingMs` passes first. */
export async function answeredWithin(
  confirmed: Promise<boolean | null>,
  ceilingMs: number,
): Promise<boolean | null> {
  let clearCeiling = (): void => undefined;
  const ceiling = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ceilingMs);
    clearCeiling = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([confirmed, ceiling]);
  } finally {
    clearCeiling();
  }
}
