import { useCallback, useEffect, useState } from "react";
import { ignoreError } from "@/lib/browser-view/ignore-error";

/**
 * How long a configuration page waits for its first answer before it says
 * the read failed. A read that cannot be sent (no host to send it through)
 * stays pending for ever, which the page would otherwise draw as an endless
 * spinner.
 */
export const READ_BOUND_MS = 15_000;

export interface BoundedRead {
  /** Still waiting, within the bound. */
  readonly pending: boolean;
  /** The read failed, or has not answered within the bound. */
  readonly failed: boolean;
  /** Reads again, and waits the bound again. */
  readonly retry: () => void;
}

/**
 * A configuration page's first read, bounded: `pending` for at most
 * {@link READ_BOUND_MS}, then `failed`, so the page shows `Couldn't read …
 * Retry` instead of a spinner. An answer that lands later still shows.
 */
export function useBoundedRead(query: {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly refetch: () => Promise<unknown>;
}): BoundedRead {
  const { isPending, isError, refetch } = query;
  const [attempt, setAttempt] = useState(0);
  const [expiredAttempt, setExpiredAttempt] = useState<number | null>(null);
  const waiting = isPending && !isError;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setTimeout(() => setExpiredAttempt(attempt), READ_BOUND_MS);
    return () => clearTimeout(timer);
  }, [waiting, attempt]);
  const expired = waiting && expiredAttempt === attempt;
  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
    void refetch().catch(ignoreError);
  }, [refetch]);
  return {
    pending: waiting && !expired,
    failed: isError || expired,
    retry,
  };
}
