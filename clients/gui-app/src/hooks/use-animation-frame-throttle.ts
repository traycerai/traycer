import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Returns a stable `schedule(arg)` that runs `callback` at most once per
 * animation frame, always with the most recently scheduled `arg` and the
 * latest `callback` identity. A pending frame is cancelled on unmount.
 *
 * Use this to coalesce layout reads (e.g. `getBoundingClientRect`) driven by
 * high-frequency events (scroll, rendered-data changes) into one read per
 * frame, without the scheduler's identity churning when `callback` closes over
 * changing values - so the returned function is safe in otherwise-stable event
 * handler dependency arrays.
 */
export function useAnimationFrameThrottle<TArg>(
  callback: (arg: TArg) => void,
): (arg: TArg) => void {
  const callbackRef = useRef(callback);
  const frameRef = useRef<number | null>(null);
  // Boxed so a `TArg` that legitimately includes `null` stays distinguishable
  // from "nothing scheduled".
  const pendingRef = useRef<{ readonly arg: TArg } | null>(null);

  useLayoutEffect(() => {
    callbackRef.current = callback;
  });

  useLayoutEffect(
    () => () => {
      if (frameRef.current === null) return;
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      pendingRef.current = null;
    },
    [],
  );

  return useCallback((arg: TArg): void => {
    pendingRef.current = { arg };
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending === null) return;
      callbackRef.current(pending.arg);
    });
  }, []);
}
