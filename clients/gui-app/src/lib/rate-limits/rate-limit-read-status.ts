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
 * `fatalDetails` excludes a THIRD pre-dispatch case the two subclasses miss.
 * The transport has three states but only two classes for them: never
 * dispatched and retryable is a `RetryableTransportError`; dispatched but
 * unheard is the plain class; and never dispatched but TERMINAL is ALSO the
 * plain class, precisely because it must not be retried.
 * `RemoteSession.notReadyRejection` returns exactly that for a closed session,
 * carrying the terminal `fatalDetails` verbatim - a revoked credential, a plan
 * restriction, an incompatible protocol. Reading those as "still running" would
 * suppress a failure nothing can ever resolve and arm a follow-up with nothing
 * to collect, leaving a stale reading on screen looking healthy. `fatalDetails`
 * is non-null only when the failure arrived via a fatal-error frame, so it
 * names that case and nothing else.
 *
 * A leaf module (no local imports) so both the queue - which schedules the
 * follow-up read - and the surfaces that decide whether to show a failure share
 * one definition instead of drifting apart.
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
 * Whether a rate-limit pull's error state should be PRESENTED as a failure.
 *
 * A read we stopped waiting for is not one: the probe is still running, the
 * queue has scheduled a follow-up to collect it, and the surface keeps showing
 * its last-known-good reading meanwhile. Reporting "couldn't fetch usage" there
 * would be the visible-failure-then-silent-success behaviour this layer is
 * meant to stop.
 *
 * `queueOwned` is what makes that reasoning true rather than assumed. The whole
 * justification for hiding the failure is that SOMETHING will come back for the
 * answer, and the only thing that does is the `ephemeralProcess` queue's
 * follow-up. An `httpFetch` provider (openrouter, kilocode, cursor) never
 * enters that queue - it refetches its own query directly - so nothing is
 * scheduled, nothing collects, and suppressing there just hides a dropped
 * connection behind cached usage that looks healthy, or an empty Settings card
 * with no error, until some later poll happens along. Callers pass the lane
 * rather than the provider id so this stays a leaf module.
 *
 * `followUpExhausted` is the same requirement applied to the queue-owned lane
 * itself, which owns a BUDGET rather than an open-ended promise. The queue
 * allows one delayed collection per target
 * (`RATE_LIMIT_READ_FOLLOW_UP_LIMIT`); when that collection also comes back
 * unheard, `scheduleReadFollowUp` declines another and the guarantee is spent.
 * Suppressing past that point is the `httpFetch` mistake one level deeper -
 * lane membership was never the real premise, a pending collection was - so the
 * exhausted target reports its failure and stops vouching for a reading nothing
 * is coming to refresh. Callers read it from the queue registry
 * (`useIsRateLimitReadFollowUpExhausted`), keeping this a leaf module.
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
