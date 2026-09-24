// Pure-function coverage for `restartRequestResultFromOutcome` /
// `serviceRestartResultFromOutcome` (MIX-OLD-SUPERVISOR): the wire-result
// mapping every restart surface (`requestHostRespawn`,
// `traycerHostServiceRestartIfHostIdle`, `traycerHostRestartIfIdle`, the
// Doctor "restart" repair) resolves through. No bridge, no controller - both
// functions take a `GuardedMutationOutcome` and return a plain value or
// throw, so this suite drives them directly.
import { describe, expect, it } from "vitest";
import type {
  ActivateInstalledOk,
  GuardedMutationOutcome,
} from "../../host/host-controller-types";
import {
  restartRequestResultFromOutcome,
  serviceRestartResultFromOutcome,
} from "../host-ipc";

function outcome(
  kind: "ok" | "busy" | "deferred" | "abandoned" | "failed",
  message: string | undefined,
): GuardedMutationOutcome<ActivateInstalledOk> {
  switch (kind) {
    case "ok":
      return { kind: "ok", value: { activated: true } };
    case "busy":
      return {
        kind: "busy",
        continuation: "retry-with-force",
        message: message ?? "",
      };
    case "deferred":
      return { kind: "deferred", message: message ?? "" };
    case "abandoned":
      return { kind: "abandoned", message: message ?? "" };
    case "failed":
      return { kind: "failed", message: message ?? "" };
  }
}

describe("serviceRestartResultFromOutcome", () => {
  it('busy maps to exactly {kind: "host-busy"} - no message key survives', () => {
    const result = serviceRestartResultFromOutcome(
      outcome("busy", "work in progress"),
    );

    expect(result).toEqual({ kind: "host-busy" });
    // Guard the "exactly" claim - a message key silently smuggled onto the
    // result would still satisfy a `.toEqual({kind:"host-busy"})` check that
    // used `expect.objectContaining` but must fail this one.
    expect(Object.keys(result)).toEqual(["kind"]);
  });

  it("ok maps to restarted", () => {
    expect(serviceRestartResultFromOutcome(outcome("ok", undefined))).toEqual({
      kind: "restarted",
    });
  });

  it("deferred maps to declined with the outcome's message", () => {
    expect(
      serviceRestartResultFromOutcome(
        outcome("deferred", "Another Traycer process holds the lock."),
      ),
    ).toEqual({
      kind: "declined",
      message: "Another Traycer process holds the lock.",
    });
  });

  it("abandoned maps to declined with the outcome's message", () => {
    expect(
      serviceRestartResultFromOutcome(outcome("abandoned", "host changed")),
    ).toEqual({
      kind: "declined",
      message: "host changed",
    });
  });

  it("failed throws the outcome's message", () => {
    expect(() =>
      serviceRestartResultFromOutcome(
        outcome("failed", "Traycer needs approval in System Settings."),
      ),
    ).toThrow("Traycer needs approval in System Settings.");
  });
});

// `serviceRestartResultFromOutcome` is documented as differing from
// `restartRequestResultFromOutcome` in exactly one branch (busy). This pins
// that the other four branches are byte-identical between the two, so a
// future edit that special-cases a second branch has to touch this file.
describe("restartRequestResultFromOutcome vs serviceRestartResultFromOutcome parity", () => {
  it("ok maps identically on both functions", () => {
    const value = outcome("ok", undefined);
    expect(serviceRestartResultFromOutcome(value)).toEqual(
      restartRequestResultFromOutcome(value),
    );
  });

  it.each(["deferred", "abandoned"] as const)(
    "%s maps identically on both functions",
    (kind) => {
      const value = outcome(kind, "message");
      expect(serviceRestartResultFromOutcome(value)).toEqual(
        restartRequestResultFromOutcome(value),
      );
    },
  );

  it("failed throws identically on both functions", () => {
    const value = outcome("failed", "boom");
    expect(() => serviceRestartResultFromOutcome(value)).toThrow("boom");
    expect(() => restartRequestResultFromOutcome(value)).toThrow("boom");
  });

  it("busy is the ONE branch that differs: declined (cooperative) vs host-busy (service)", () => {
    const value = outcome("busy", "work in progress");
    expect(restartRequestResultFromOutcome(value)).toEqual({
      kind: "declined",
      message: "work in progress",
    });
    expect(serviceRestartResultFromOutcome(value)).toEqual({
      kind: "host-busy",
    });
  });
});
