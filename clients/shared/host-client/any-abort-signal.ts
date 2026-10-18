/**
 * `AbortSignal.any([first, second])` for the host-RPC authority path, on
 * runtimes that lack the API (Chromium < 116, iOS < 17.4).
 *
 * There the native call is a `TypeError` thrown out of `captureAuthority`, and
 * every host request fails before it reaches the coordinator - an Android
 * WebView 114 cannot read a single host record. `auth/request-abort.ts` is the
 * same lesson for the sign-in path.
 *
 * The fallback cannot be compose-then-`clear()`: the authority is captured per
 * request but only the coordinator knows when its job settles, and a caller's
 * waiter can settle while the job still runs. So one composed signal is shared
 * per source pair. A session issues many requests under one binding and one
 * request context, and pays two listeners for that pair rather than two per
 * request. Both listeners detach as soon as either source aborts, which is
 * also when the authority contract ends the pair (`HostRequestAuthority`:
 * replacing the context or host aborts the signal).
 */
const composedByPair = new WeakMap<
  AbortSignal,
  WeakMap<AbortSignal, AbortSignal>
>();

export function anyAbortSignal(
  first: AbortSignal,
  second: AbortSignal,
): AbortSignal {
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([first, second]);
  }
  let bySecond = composedByPair.get(first);
  if (bySecond === undefined) {
    bySecond = new WeakMap();
    composedByPair.set(first, bySecond);
  }
  let composed = bySecond.get(second);
  if (composed === undefined) {
    composed = composePair(first, second);
    bySecond.set(second, composed);
  }
  return composed;
}

function composePair(first: AbortSignal, second: AbortSignal): AbortSignal {
  const controller = new AbortController();
  // An already-aborted source fires no event, so its state is read first.
  if (first.aborted) {
    controller.abort(first.reason);
    return controller.signal;
  }
  if (second.aborted) {
    controller.abort(second.reason);
    return controller.signal;
  }
  const onFirstAbort = (): void => {
    detach();
    controller.abort(first.reason);
  };
  const onSecondAbort = (): void => {
    detach();
    controller.abort(second.reason);
  };
  const detach = (): void => {
    first.removeEventListener("abort", onFirstAbort);
    second.removeEventListener("abort", onSecondAbort);
  };
  first.addEventListener("abort", onFirstAbort);
  second.addEventListener("abort", onSecondAbort);
  return controller.signal;
}
