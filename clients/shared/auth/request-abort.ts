/**
 * Per-request cancellation + timeout, built from primitives every WebView this
 * app runs in already has.
 *
 * `AbortSignal.timeout` (iOS 16) and `AbortSignal.any` (iOS 17.4) would each
 * express this in one line, and on the phone each is a `TypeError` thrown out
 * of the call rather than a feature that degrades: the shell declares
 * `IPHONEOS_DEPLOYMENT_TARGET = 15.5`, so a WKWebView below those versions
 * takes down the sign-in request that used it. An `AbortController` with a
 * `setTimeout` and a forwarded `abort` listener has been available since long
 * before that floor and behaves identically.
 *
 * `clear()` is not optional bookkeeping. Without it the pending timer keeps a
 * settled request's controller alive for the rest of the timeout, and the
 * listener keeps this composed signal attached to a caller signal that may
 * outlive it by many requests - a poll loop would accumulate one listener per
 * poll on the attempt's signal.
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
  // An ALREADY-aborted caller signal fires no event, so forwarding has to
  // start by reading its current state - otherwise a request handed a dead
  // signal would run to its full timeout instead of never starting.
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
