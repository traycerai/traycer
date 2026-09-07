/**
 * Per-request cancellation + timeout, built from primitives every WebView this app runs in already has.
 * An `AbortController` with a `setTimeout` and a forwarded `abort` listener has been available since long before that floor and behaves identically.
 */
export interface ComposedRequestAbort {
  readonly signal: AbortSignal;
  /** Call once the request settles, on every path including failure. */
  readonly clear: () => void;
}

export function composeRequestAbort(
  callerSignal: AbortSignal | null,
  timeoutMs: number,
): ComposedRequestAbort {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  if (callerSignal === null) {
    return {
      signal: controller.signal,
      clear: () => {
        clearTimeout(timer);
      },
    };
  }
  // An already-aborted caller signal fires no event, so forwarding has to start by reading its current state - otherwise a request handed a dead signal would run to its full timeout instead of never starting.
  if (callerSignal.aborted) {
    controller.abort();
    return {
      signal: controller.signal,
      clear: () => {
        clearTimeout(timer);
      },
    };
  }
  const forwardAbort = (): void => {
    controller.abort();
  };
  callerSignal.addEventListener("abort", forwardAbort, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", forwardAbort);
    },
  };
}
