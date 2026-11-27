/**
 * Resolves after `delayMs`, or rejects as soon as `signal` aborts: with the
 * signal's reason when that is an `Error`, otherwise with an `AbortError`
 * carrying `abortedMessage`. Throws at once if `signal` has already aborted.
 */
export function waitUnlessAborted(
  delayMs: number,
  signal: AbortSignal,
  abortedMessage: string,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new DOMException(abortedMessage, "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}
