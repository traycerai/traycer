export function cliConfigLockAbortError(): DOMException {
  return new DOMException("Settings lock admission aborted.", "AbortError");
}

export function throwIfCliConfigLockAborted(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted === true) throw cliConfigLockAbortError();
}

/** Serializes this process's settings operations and drops aborted waiters. */
export class CliConfigQueue {
  private running = false;
  private readonly waiting = new Set<() => void>();

  get idle(): boolean {
    return !this.running;
  }

  run<T>(
    operation: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (signal?.aborted === true)
      return Promise.reject(cliConfigLockAbortError());
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        this.waiting.delete(admit);
        reject(cliConfigLockAbortError());
      };
      const admit = (): void => {
        signal?.removeEventListener("abort", abort);
        this.running = true;
        resolve();
      };
      if (this.running) {
        this.waiting.add(admit);
        signal?.addEventListener("abort", abort, { once: true });
      } else {
        admit();
      }
    }).then(async () => {
      // Register the continuation from the caller so a previous operation
      // cannot pass its AsyncLocalStorage context to this one.
      try {
        throwIfCliConfigLockAborted(signal);
        return await operation();
      } finally {
        const [next] = this.waiting;
        if (next === undefined) {
          this.running = false;
        } else {
          this.waiting.delete(next);
          next();
        }
      }
    });
  }
}
