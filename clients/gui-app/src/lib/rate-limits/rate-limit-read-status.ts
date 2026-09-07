import {
  HostRequestAbortedError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * True when a dispatched `host.getRateLimitUsage` timed out and the host may still be running it.
 * Exclude `RetryableTransportError`, abort, and non-null `fatalDetails` (terminal never-dispatched, not still running).
 */
export function isRateLimitReadStillRunningOnHost(error: unknown): boolean {
  return (
    error instanceof HostTransportFailureError &&
    !(error instanceof RetryableTransportError) &&
    !(error instanceof HostRequestAbortedError) &&
    error.fatalDetails === null
  );
}

/**
 * Present a rate-limit pull error only when nothing will collect the answer.
 * Hide only for `queueOwned` while a follow-up is still owed; `httpFetch` and exhausted follow-up must show the failure.
 */
export function isRateLimitQueryFailure(query: {
  readonly isError: boolean;
  readonly error: unknown;
  readonly queueOwned: boolean;
  readonly followUpExhausted: boolean;
}): boolean {
  if (!query.isError) return false;
  if (!query.queueOwned) return true;
  if (query.followUpExhausted) return true;
  return !isRateLimitReadStillRunningOnHost(query.error);
}
