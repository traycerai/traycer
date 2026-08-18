import { describe, expect, it } from "vitest";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  isRateLimitQueryFailure,
  isRateLimitReadStillRunningOnHost,
} from "@/lib/rate-limits/rate-limit-read-status";

const BASE = {
  code: "RPC_ERROR" as const,
  message: "no response inside the budget",
  requestId: "req-1",
  method: "host.getRateLimitUsage",
};

/**
 * The DISPATCHED-but-unheard case: a slow-but-healthy `ephemeralProcess` probe
 * that outran our response budget. The host finishes regardless and banks the
 * reading in its gauge cache, which is what the queue's follow-up collects.
 */
function stillRunning(): HostTransportFailureError {
  return new HostTransportFailureError({ ...BASE, fatalDetails: null });
}

/**
 * The TERMINAL pre-dispatch case: `RemoteSession.notReadyRejection` on a closed
 * session. Also a plain `HostTransportFailureError` - it must not be retried,
 * so it cannot be a `RetryableTransportError` - but nothing was ever sent.
 */
function terminalPreDispatch(reason: string): HostTransportFailureError {
  return new HostTransportFailureError({
    ...BASE,
    message: "Remote session is closed",
    fatalDetails: {
      code: "E_SESSION_FATAL",
      reason,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

describe("isRateLimitReadStillRunningOnHost", () => {
  it("is true only for a dispatched read we stopped waiting for", () => {
    expect(isRateLimitReadStillRunningOnHost(stillRunning())).toBe(true);
  });

  it("is false for a request the transport never dispatched", () => {
    expect(
      isRateLimitReadStillRunningOnHost(
        new RetryableTransportError({ ...BASE, fatalDetails: null }),
      ),
    ).toBe(false);
  });

  it("is false once the authority was disposed", () => {
    expect(
      isRateLimitReadStillRunningOnHost(new HostRequestAbortedError(BASE)),
    ).toBe(false);
  });

  // The gap the two subclass exclusions miss. A closed remote session rejects
  // pre-dispatch with the BASE class, because a terminal failure must not be
  // retried - so class alone cannot separate it from a slow probe. Treating it
  // as "still running" suppresses a failure nothing can resolve and arms a
  // follow-up with nothing to collect, leaving stale usage looking healthy.
  it.each([
    ["a revoked credential", "credentials revoked"],
    ["a plan restriction", "plan does not permit remote hosts"],
    ["an incompatible protocol", "protocol incompatible"],
  ])(
    "is false for %s that closed the session before dispatch",
    (_l, reason) => {
      expect(
        isRateLimitReadStillRunningOnHost(terminalPreDispatch(reason)),
      ).toBe(false);
    },
  );

  it("is false for an ordinary RPC error, which is an answer", () => {
    expect(
      isRateLimitReadStillRunningOnHost(
        new HostRpcError({ ...BASE, fatalDetails: null }),
      ),
    ).toBe(false);
  });
});

describe("isRateLimitQueryFailure", () => {
  it("reports nothing while the query has not errored", () => {
    expect(
      isRateLimitQueryFailure({
        isError: false,
        error: null,
        queueOwned: true,
        followUpExhausted: false,
      }),
    ).toBe(false);
  });

  it("suppresses a queue-owned read that is still running on the host", () => {
    expect(
      isRateLimitQueryFailure({
        isError: true,
        error: stillRunning(),
        queueOwned: true,
        followUpExhausted: false,
      }),
    ).toBe(false);
  });

  // The queue allows ONE delayed collection per target. When that follow-up
  // also comes back unheard, `scheduleReadFollowUp` declines another and
  // nothing is left to collect the answer - so the lane being queue-owned stops
  // justifying the suppression. Without this arm the row keeps showing a stale
  // reading as healthy with no failure and no collector.
  it("reports a still-running read once the follow-up budget is spent", () => {
    expect(
      isRateLimitQueryFailure({
        isError: true,
        error: stillRunning(),
        queueOwned: true,
        followUpExhausted: true,
      }),
    ).toBe(true);
  });

  // `httpFetch` providers refetch their own query and never enter the serial
  // queue, so no follow-up is ever scheduled for them. Suppressing there would
  // hide a dropped connection behind cached usage that looks healthy, with
  // nothing coming back to correct it.
  it("does NOT suppress the same error for a lane the queue does not own", () => {
    expect(
      isRateLimitQueryFailure({
        isError: true,
        error: stillRunning(),
        queueOwned: false,
        followUpExhausted: false,
      }),
    ).toBe(true);
  });

  it("reports a terminal pre-dispatch failure even on the queue-owned lane", () => {
    expect(
      isRateLimitQueryFailure({
        isError: true,
        error: terminalPreDispatch("credentials revoked"),
        queueOwned: true,
        followUpExhausted: false,
      }),
    ).toBe(true);
  });
});
