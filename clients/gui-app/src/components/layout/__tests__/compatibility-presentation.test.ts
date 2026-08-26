import { describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { compatibilityPresentation } from "@/components/layout/host-compatibility-presentation";
import type { HostCompatibility } from "@/lib/host/compatibility-state";

/**
 * The FIRST coverage `compatibilityPresentation` has ever had.
 *
 * The function lives in its own module (`host-compatibility-presentation.ts`)
 * rather than beside the readiness controller, because a non-component export
 * alongside that file's three components trips
 * `react-refresh/only-export-components`. Testability was the reason to reach
 * for the seam; the lint rule decided its shape.
 *
 * It is here because of how its absence was discovered, and that story is the
 * reason these tests assert what they assert. Sealed probe R6 (redesign P3.2)
 * mutated this function and SURVIVED. The lane added the demanded pin, re-fired,
 * and it survived a SECOND time — because the pin asserted on
 * `describeCompatHealth`, one layer downstream, while the probe mutated this
 * function. Two different functions; the re-fire measured the same hole twice
 * instead of closing it. The residual travelled to P4.3 as a named rider.
 *
 * So the discipline here is: assert THIS function's output, field by field, for
 * every arm of `HostCompatibility`. A test that reaches for the report line
 * would reproduce exactly the mistake being corrected.
 *
 * What the mapping is FOR: a pre-filled failure report (D13, P3.2). The verdict
 * reaches the user through the lease's `incompatible` arm — this shape exists so
 * triage can tell an unreachable probe from a rejected handshake, and a held
 * verdict from a fresh one.
 */

function rpcError(message: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message,
    requestId: "req-1",
    method: "host.status",
    fatalDetails: null,
  });
}

describe("compatibilityPresentation — every arm of the probe verdict", () => {
  it("carries a compatible verdict's held-ness and its host answer", () => {
    const compatibility: HostCompatibility = {
      status: "compatible",
      retry: () => undefined,
      degraded: false,
      hostStatus: {
        busy: true,
        busySessionCount: 3,
        busyBreakdown: null,
        hostVersion: "1.4.2",
      },
    };

    expect(compatibilityPresentation(compatibility)).toEqual({
      status: "compatible",
      degraded: false,
      unreachable: false,
      hostStatus: {
        busy: true,
        busySessionCount: 3,
        busyBreakdown: null,
        hostVersion: "1.4.2",
      },
    });
  });

  /**
   * `degraded` is the whole reason the compatible arm is not a constant: a
   * verdict HELD from an earlier probe whose refetch failed must read
   * "compatible (degraded)" in a report, because triage needs to know the
   * answer was retained rather than freshly given. Collapsing it to `false`
   * would make a host that stopped answering look like one that just did.
   */
  it("preserves a HELD compatible verdict rather than flattening it", () => {
    const compatibility: HostCompatibility = {
      status: "compatible",
      retry: () => undefined,
      degraded: true,
      hostStatus: {
        busy: false,
        busySessionCount: 0,
        busyBreakdown: null,
        hostVersion: "1.4.2",
      },
    };

    const presentation = compatibilityPresentation(compatibility);

    expect(presentation.status).toBe("compatible");
    expect(presentation.degraded).toBe(true);
  });

  /**
   * The `unreachable` bit is kept apart from the verdict for a specific
   * historical reason recorded at the field: calling an unreachable host
   * "incompatible" is what made an offline host (traycer#858) and a
   * load-stalled host (traycer#860) both read as version problems.
   */
  it("keeps a failed probe's unreachable bit — a missed host is not a version fault", () => {
    const compatibility: HostCompatibility = {
      status: "failed",
      retry: () => undefined,
      retrying: false,
      error: rpcError("dial timed out"),
      unreachable: true,
    };

    expect(compatibilityPresentation(compatibility)).toEqual({
      status: "failed",
      degraded: false,
      unreachable: true,
      hostStatus: null,
    });
  });

  it("distinguishes a failure that DID reach the host", () => {
    const compatibility: HostCompatibility = {
      status: "failed",
      retry: () => undefined,
      retrying: true,
      error: rpcError("host rejected the handshake"),
      unreachable: false,
    };

    const presentation = compatibilityPresentation(compatibility);

    expect(presentation.status).toBe("failed");
    expect(presentation.unreachable).toBe(false);
  });

  /**
   * An `incompatible` host answered — it is up, and it disagreed. So
   * `unreachable` must be false, and this is the arm where getting that
   * backwards is most costly: it is the one verdict that routes a user to
   * "update the host" rather than "check the connection".
   */
  it("reports incompatible as reached-and-rejected, never as unreachable", () => {
    const compatibility: HostCompatibility = {
      status: "incompatible",
      retry: () => undefined,
      error: rpcError("protocol major mismatch"),
    };

    expect(compatibilityPresentation(compatibility)).toEqual({
      status: "incompatible",
      degraded: false,
      unreachable: false,
      hostStatus: null,
    });
  });

  it("reports checking with nothing claimed about the host", () => {
    const compatibility: HostCompatibility = {
      status: "checking",
      retry: () => undefined,
    };

    expect(compatibilityPresentation(compatibility)).toEqual({
      status: "checking",
      degraded: false,
      unreachable: false,
      hostStatus: null,
    });
  });

  /**
   * The status word is carried through UNCHANGED for all four arms.
   *
   * This is the assertion R6 was aimed at, stated as its own case rather than
   * left implicit in the four above: the probe's mutation was to the mapping
   * from verdict to presented status, and a suite that only ever checked one
   * arm's other fields could pass with every status collapsed to a constant.
   */
  it.each([
    ["checking"],
    ["compatible"],
    ["failed"],
    ["incompatible"],
  ] as const)("passes the %s verdict through as its own status", (status) => {
    const byStatus: Record<typeof status, HostCompatibility> = {
      checking: { status: "checking", retry: () => undefined },
      compatible: {
        status: "compatible",
        retry: () => undefined,
        degraded: false,
        hostStatus: {
          busy: false,
          busySessionCount: null,
          busyBreakdown: null,
          hostVersion: "1.0.0",
        },
      },
      failed: {
        status: "failed",
        retry: () => undefined,
        retrying: false,
        error: rpcError("nope"),
        unreachable: false,
      },
      incompatible: {
        status: "incompatible",
        retry: () => undefined,
        error: rpcError("nope"),
      },
    };

    expect(compatibilityPresentation(byStatus[status]).status).toBe(status);
  });

  /**
   * `hostStatus` exists ONLY on a compatible verdict, because only a
   * compatible verdict ever heard one. A non-null answer on any other arm
   * would be a fabricated reading of a host that never replied.
   */
  it("never invents a host answer for a verdict that heard none", () => {
    const withoutAnswer: readonly HostCompatibility[] = [
      { status: "checking", retry: () => undefined },
      {
        status: "failed",
        retry: () => undefined,
        retrying: false,
        error: rpcError("nope"),
        unreachable: true,
      },
      {
        status: "incompatible",
        retry: () => undefined,
        error: rpcError("nope"),
      },
    ];

    for (const compatibility of withoutAnswer) {
      expect(compatibilityPresentation(compatibility).hostStatus).toBeNull();
    }
  });
});
