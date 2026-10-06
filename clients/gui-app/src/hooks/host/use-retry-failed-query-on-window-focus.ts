import { useEffect, useEffectEvent } from "react";

/**
 * Re-asks a FAILED query when the window gains focus. For a query whose
 * failure disables an action behind a hint that says returning to the app
 * retries: without this the hint promises a retry nothing performs.
 *
 * The window's own `focus` event, not TanStack's focus manager: that one
 * follows `visibilitychange`, which the desktop shell never fires (every
 * window runs with `backgroundThrottling: false`, so `visibilityState` stays
 * `"visible"`), and which no browser fires when focus moves between two
 * visible windows. `refetchOnWindowFocus` alone therefore retries nothing on a
 * plain return to the app.
 *
 * A settled query is left alone, so this adds no request on the success path.
 * `cancelRefetch: false` joins a fetch already in flight: several observers of
 * one cache entry, or the focus manager firing for the same return, send one
 * request.
 */
export function useRetryFailedQueryOnWindowFocus(args: {
  readonly enabled: boolean;
  readonly isError: boolean;
  readonly refetch: (options: {
    readonly cancelRefetch: boolean;
  }) => Promise<unknown>;
}): void {
  const onFocus = useEffectEvent(() => {
    if (!args.enabled || !args.isError) return;
    void args.refetch({ cancelRefetch: false });
  });
  useEffect(() => {
    const listener = (): void => {
      onFocus();
    };
    window.addEventListener("focus", listener);
    return () => {
      window.removeEventListener("focus", listener);
    };
  }, []);
}
