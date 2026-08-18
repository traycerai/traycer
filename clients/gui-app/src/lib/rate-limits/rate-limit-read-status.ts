import {
  HostRequestAbortedError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * Whether we stopped waiting on a rate-limit read the host may still be
 * running.
 *
 * A plain `HostTransportFailureError` means the request WAS dispatched and no
 * answer arrived inside our budget - which for `host.getRateLimitUsage` is the
 * expected shape of a slow-but-healthy probe, not a broken one. A same-profile
 * custodian can hold the per-config-dir gate for roughly two minutes before the
 * probe's own 150s of phases even begin, so a legitimate read can outrun the
 * response budget (see `RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS`, which is sized
 * for the probe phases and deliberately not for that gate). The host finishes
 * regardless and captures the reading in its gauge cache.
 *
 * Both subclasses are excluded deliberately. `RetryableTransportError` carries
 * the "host never dispatched it" guarantee, so no work is in flight to collect
 * and the retrying messenger already owns that case. `HostRequestAbortedError`
 * means the authority was disposed, so nothing is waiting for the answer.
 *
 * A leaf module (no local imports) so both the queue - which schedules the
 * follow-up read - and the surfaces that decide whether to show a failure share
 * one definition instead of drifting apart.
 */
export function isRateLimitReadStillRunningOnHost(error: unknown): boolean {
  return (
    error instanceof HostTransportFailureError &&
    !(error instanceof RetryableTransportError) &&
    !(error instanceof HostRequestAbortedError)
  );
}

/**
 * Whether a rate-limit pull's error state should be PRESENTED as a failure.
 *
 * A read we stopped waiting for is not one: the probe is still running, the
 * queue has scheduled a follow-up to collect it, and the surface keeps showing
 * its last-known-good reading meanwhile. Reporting "couldn't fetch usage" there
 * would be the visible-failure-then-silent-success behaviour this layer is
 * meant to stop.
 */
export function isRateLimitQueryFailure(query: {
  readonly isError: boolean;
  readonly error: unknown;
}): boolean {
  return query.isError && !isRateLimitReadStillRunningOnHost(query.error);
}
