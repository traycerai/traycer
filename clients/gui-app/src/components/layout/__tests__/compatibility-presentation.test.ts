import { describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { compatibilityPresentation } from "@/components/layout/host-compatibility-presentation";
import type { HostCompatibility } from "@/lib/host/compatibility-state";

/** The lane added the demanded pin, re-fired, and it survived a second time - because the pin asserted on
 * `describeCompatHealth`, one layer downstream, while the probe mutated this function. */

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

  /** `degraded` is the whole reason the compatible arm is not a constant. */
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

  /** The `unreachable` bit is kept apart from the verdict for a specific historical reason recorded at the field. */
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

  /** So `unreachable` must be false, and this is the arm where getting that backwards is most costly: it is the
   * one verdict that routes a user to "update the host" rather than "check the connection". */
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

  /** This is the assertion was aimed at, stated as its own case rather than left implicit in the four above. */
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

  /** `hostStatus` exists only on a compatible verdict, because only a compatible verdict ever heard one. A
   * non-null answer on any other arm would be a fabricated reading of a host that never replied. */
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
