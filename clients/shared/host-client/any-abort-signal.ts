/**
 * `AbortSignal.any` for the shared host-RPC authority path, on runtimes that
 * predate the API (Chromium 116, iOS 17.4). Older WebViews still in the field
 * - Android WebView 114 among them - throw `AbortSignal.any is not a
 * function` out of `captureAuthority`, failing every host RPC before dispatch
 * instead of degrading. `auth/request-abort.ts` documents the same failure
 * mode for the sign-in path.
 *
 * The fallback deliberately does not borrow the usual compose-and-dispose
 * shape: the authority signal is captured per request but consumed at job
 * settle, which only the coordinator observes - and a caller's waiter can
 * settle while the job still runs. Disposing on the returned promise would
 * strip cancellation from in-flight work. Instead one source pair shares a
 * single composed signal per binding/context generation, so a session pays
 * two listeners per generation rather than per request; the listeners
 * self-detach on the first source abort, which is also when the generation
 * ends.
 */
const composedBySourcePair = new WeakMap<
  AbortSignal,
  WeakMap<AbortSignal, AbortSignal>
>();

/**
 * `AbortSignal.any([first, second])`: an `AbortSignal` that aborts - with the
 * firing source's reason - when either input does. Falls back to an
 * equivalent composed controller where the runtime has no `AbortSignal.any`.
 */
export function anyAbortSignal(
  first: AbortSignal,
  second: AbortSignal,
): AbortSignal {
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([first, second]);
  }
  const bySecond = composedBySourcePair.get(first);
  const cached = bySecond?.get(second);
  if (cached !== undefined) {
    return cached;
  }
  const composed = composeSignalPair(first, second);
  if (bySecond === undefined) {
    composedBySourcePair.set(first, new WeakMap([[second, composed]]));
  } else {
    bySecond.set(second, composed);
  }
  return composed;
}

function composeSignalPair(
  first: AbortSignal,
  second: AbortSignal,
): AbortSignal {
  const controller = new AbortController();
  // An ALREADY-aborted source fires no event, so its state has to be read
  // first - the same point `composeRequestAbort` makes. The result mirrors
  // the native composition: aborted, carrying the source's reason.
  if (first.aborted || second.aborted) {
    controller.abort(first.aborted ? first.reason : second.reason);
    return controller.signal;
  }
  const detach = (): void => {
    first.removeEventListener("abort", onFirstAbort);
    second.removeEventListener("abort", onSecondAbort);
  };
  const onFirstAbort = (): void => {
    detach();
    controller.abort(first.reason);
  };
  const onSecondAbort = (): void => {
    detach();
    controller.abort(second.reason);
  };
  first.addEventListener("abort", onFirstAbort);
  second.addEventListener("abort", onSecondAbort);
  return controller.signal;
}
