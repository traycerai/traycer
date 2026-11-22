/**
 * How long a remote attach that would carry the sign-in waits for the host's
 * row to be read again (`RemoteReleasedSignOn.confirmRow`).
 */
export const ROW_CONFIRM_CEILING_MS = 5_000;

/** `confirmed`, or `false` once `ceilingMs` passes first. */
export async function answeredWithin(
  confirmed: Promise<boolean>,
  ceilingMs: number,
): Promise<boolean> {
  let clearCeiling = (): void => undefined;
  const ceiling = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ceilingMs);
    clearCeiling = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([confirmed, ceiling]);
  } finally {
    clearCeiling();
  }
}
