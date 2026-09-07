import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Stable `schedule(arg)`: at most one callback per frame, latest arg and callback. Identity does not churn with the callback closure.
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
