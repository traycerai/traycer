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
  // A `TimeoutError`, as `AbortSignal.timeout` aborts with, so a caller that
  // tells a timeout from a cancellation still can.
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException("The request timed out.", "TimeoutError"),
    );
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

/**
 * Keeps each composed controller alive exactly as long as its signal, so the
 * sources hold only a weak reference to it and a long-lived source never pins
 * the requests it once fed.
 */
const controllerOfSignal = new WeakMap<AbortSignal, AbortController>();

/** Detaches a composed signal's source listeners once it is collected. */
const detachOnCollect = new FinalizationRegistry<() => void>((detach) => {
  detach();
});

/**
 * `AbortSignal.any` for the WebView floor, which predates it (iOS 17.4) and
 * throws rather than degrading; see the module comment above.
 *
 * Unlike {@link composeRequestAbort} it needs no `clear()`, because callers
 * hand the signal on to code whose lifetime they do not own. As the native
 * one does, it aborts with the first source's reason. The sources reach the
 * controller only through a weak reference, and their listeners are removed
 * once any source fires or the composed signal is collected. So a source
 * that outlives many composed signals, such as a host binding's, does not
 * accumulate them.
 */
export function anyAbortSignal(sources: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const aborted = sources.find((source) => source.aborted);
  if (aborted !== undefined) {
    controller.abort(aborted.reason);
    return controller.signal;
  }
  controllerOfSignal.set(controller.signal, controller);
  const reference = new WeakRef(controller);
  const listeners = sources.map((source) => {
    const listener = (): void => {
      reference.deref()?.abort(source.reason);
      detach();
    };
    return { source, listener };
  });
  function detach(): void {
    for (const { source, listener } of listeners) {
      source.removeEventListener("abort", listener);
    }
  }
  for (const { source, listener } of listeners) {
    source.addEventListener("abort", listener);
  }
  detachOnCollect.register(controller.signal, detach);
  return controller.signal;
}
