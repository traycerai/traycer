/**
 * `AbortSignal.timeout(ms)` for the shared fetch helpers, on runtimes that
 * lack the API (Safari/iOS < 16).
 *
 * There the native call is a `TypeError` thrown out of the request helper, and
 * the helper's own `catch` folds it into `network-error`: an iOS 15.5 shell
 * (the Xcode deployment target) could never sign in or list its hosts, and
 * nothing would say why. `auth/request-abort.ts` is the same lesson for the
 * caller-signal paths.
 *
 * The fallback aborts with a `DOMException` named `TimeoutError`, which is
 * what the native signal's `reason` is and what callers map
 * (`isAbortOrTimeout` in `auth/auth-validation.ts`, `describeFetchFailure` in
 * `host-transport/remote/grant-client.ts`). Nothing else can abort it, so the
 * only timer is the one that fires it; it is unref'd where the runtime has
 * that, so a Node-hosted caller on a runtime without the native API is never
 * held open for the window.
 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
  }, ms);
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
  return controller.signal;
}
