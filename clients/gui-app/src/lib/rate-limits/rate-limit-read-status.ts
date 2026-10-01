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
 * `fetchProviderRateLimits` uses it to decide whether a failed read gets its
 * one delayed collection from the host's gauge instead of surfacing as an
 * error; the collection's own outcome is what the surfaces then see.
 */
export function isRateLimitReadStillRunningOnHost(error: unknown): boolean {
  return (
    error instanceof HostTransportFailureError &&
    !(error instanceof RetryableTransportError) &&
    !(error instanceof HostRequestAbortedError) &&
    error.fatalDetails === null
  );
}
