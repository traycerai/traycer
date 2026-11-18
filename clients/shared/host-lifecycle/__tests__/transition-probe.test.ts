import { describe, expect, it } from "vitest";
import {
  interpretProbeMarker,
  mapLayer0FrameToProbeOutcome,
  type Layer0Frame,
  type ProbeMarker,
} from "../transition/probe";

// T6 spawn-probe verification: frame->marker mapping exhaustiveness (incl.
// os-error) and marker correlation/attestation/indeterminate, against the
// real `transition/probe.ts` (landed after this suite's first draft — see
// the T6 test-authoring report for the earlier proposal these superseded).

const ALL_LAYER0_FRAMES: readonly Layer0Frame[] = [
  { attemptId: "attempt-acquired", layer0: "acquired" },
  {
    attemptId: "attempt-declined-pid",
    layer0: "declined",
    incumbentEvidence: {
      kind: "pid-metadata",
      pid: 4242,
      hostId: "host-abc",
      startedAt: "2026-07-27T00:00:00.000Z",
    },
  },
  {
    attemptId: "attempt-declined-retry-window",
    layer0: "declined",
    incumbentEvidence: {
      kind: "held-retry-window",
      lockPath: "/tmp/scoped/lifecycle.lock",
      observedForMs: 750,
    },
  },
  {
    attemptId: "attempt-degraded-fs",
    layer0: "degraded",
    cause: "fs-unsupported",
    evidence: "known-network filesystem 'nfs'; lock is best-effort",
  },
  // Every cause the host can attach to a degraded start. There is no
  // `layer0: "unavailable"` arm here because the host has none: the union is
  // imported from `@traycer/protocol` now, so writing one would not compile
  // rather than sitting in a fixture list pretending to be covered.
  {
    attemptId: "attempt-degraded-addon",
    layer0: "degraded",
    cause: "addon-load-failed",
    evidence: "native addon dlopen refused: bad ABI",
  },
  {
    attemptId: "attempt-degraded-fs-network",
    layer0: "degraded",
    cause: "fs-unsupported",
    evidence: "lifecycle lock path is on known-network filesystem 'nfs'",
  },
  {
    attemptId: "attempt-degraded-lock-path",
    layer0: "degraded",
    cause: "lock-path-invalid",
    evidence: "lifecycle lock inode changed during all 4 acquisition attempts",
  },
  {
    attemptId: "attempt-degraded-sharing-violation",
    layer0: "degraded",
    cause: "sharing-violation-unattested",
    evidence:
      "windows: lock file is open by another process and no live pid.json corroborates a host",
  },
  {
    attemptId: "attempt-degraded-os-error",
    layer0: "degraded",
    cause: {
      kind: "os-error",
      syscall: "flock",
      code: "ENOLCK",
      fsType: "apfs",
    },
    evidence: "kernel lifecycle lock acquisition was not determinable",
  },
];

describe("mapLayer0FrameToProbeOutcome — exhaustiveness over the Layer0Frame union", () => {
  it("covers every fixture without throwing (exhaustiveFrame would throw on an unhandled arm)", () => {
    for (const frame of ALL_LAYER0_FRAMES) {
      expect(() => mapLayer0FrameToProbeOutcome(frame)).not.toThrow();
    }
  });

  it("maps 'acquired' to awaiting-readiness, never a terminal/self-reported success", () => {
    const outcome = mapLayer0FrameToProbeOutcome({
      attemptId: "a1",
      layer0: "acquired",
    });
    expect(outcome).toEqual({
      kind: "awaiting-readiness",
      attemptId: "a1",
      degradation: null,
    });
  });

  it("maps every 'declined' frame to lock-declined, carrying the incumbent evidence through unchanged", () => {
    for (const frame of ALL_LAYER0_FRAMES) {
      if (frame.layer0 !== "declined") continue;
      const outcome = mapLayer0FrameToProbeOutcome(frame);
      expect(outcome).toEqual({
        kind: "lock-declined",
        attemptId: frame.attemptId,
        incumbentEvidence: frame.incumbentEvidence,
      });
    }
  });

  it("maps every 'degraded' cause to awaiting-readiness with durable degradation evidence - a degraded lock still starts", () => {
    const degradedFrames = ALL_LAYER0_FRAMES.filter(
      (f): f is Extract<Layer0Frame, { layer0: "degraded" }> =>
        f.layer0 === "degraded",
    );
    expect(degradedFrames.length).toBeGreaterThanOrEqual(5);
    for (const frame of degradedFrames) {
      const outcome = mapLayer0FrameToProbeOutcome(frame);
      expect(outcome.kind).toBe("awaiting-readiness");
      if (outcome.kind === "awaiting-readiness") {
        expect(outcome.degradation).toEqual({
          cause: frame.cause,
          evidence: frame.evidence,
        });
      }
    }
  });

  it("the os-error cause survives the availability-preserving mapping with its nested fields intact", () => {
    const osErrorFrame = ALL_LAYER0_FRAMES.find(
      (f) => f.layer0 === "degraded" && typeof f.cause === "object",
    );
    expect(osErrorFrame).toBeDefined();
    if (osErrorFrame === undefined) return;
    const outcome = mapLayer0FrameToProbeOutcome(osErrorFrame);
    expect(outcome).toEqual({
      kind: "awaiting-readiness",
      attemptId: osErrorFrame.attemptId,
      degradation: {
        cause: {
          kind: "os-error",
          syscall: "flock",
          code: "ENOLCK",
          fsType: "apfs",
        },
        evidence:
          osErrorFrame.layer0 === "degraded" ? osErrorFrame.evidence : "",
      },
    });
  });

  it("maps degraded network locking to awaiting-readiness without dropping the diagnosis", () => {
    const outcome = mapLayer0FrameToProbeOutcome({
      attemptId: "network-home",
      layer0: "degraded",
      cause: "fs-unsupported",
      evidence: "known-network filesystem 'nfs'; lock is best-effort",
    });
    expect(outcome).toEqual({
      kind: "awaiting-readiness",
      attemptId: "network-home",
      degradation: {
        cause: "fs-unsupported",
        evidence: "known-network filesystem 'nfs'; lock is best-effort",
      },
    });
  });
});

function marker(overrides: Partial<ProbeMarker>): ProbeMarker {
  return {
    v: 1,
    transitionId: "t-1",
    probeNonce: "nonce-1",
    serviceLabel: "ai.traycer.host.fallback",
    supervisorPid: 5001,
    attestation: {
      serviceLabel: "ai.traycer.host.fallback",
      supervisorPid: 5001,
      capturedAt: "2026-07-27T00:00:01.000Z",
    },
    outcome: {
      kind: "lock-declined",
      attemptId: "a1",
      incumbentEvidence: {
        kind: "pid-metadata",
        pid: 4242,
        hostId: "host-abc",
        startedAt: "2026-07-27T00:00:00.000Z",
      },
    },
    ...overrides,
  };
}

const NOT_READY_READINESS = { kind: "not-ready" as const, attemptId: null };

describe("interpretProbeMarker — correlation, attestation, and never-evict indeterminate arms", () => {
  it("marker absent entirely => indeterminate marker-absent, never evict", () => {
    const verdict = interpretProbeMarker({
      marker: null,
      transitionId: "t-1",
      probeNonce: "nonce-1",
      expectedServiceLabel: "ai.traycer.host.fallback",
      readiness: NOT_READY_READINESS,
    });
    expect(verdict).toEqual({ kind: "indeterminate", reason: "marker-absent" });
  });

  it("a stale marker from a previous transitionId is rejected as uncorrelated, never evict", () => {
    const verdict = interpretProbeMarker({
      marker: marker({ transitionId: "t-previous" }),
      transitionId: "t-current",
      probeNonce: "nonce-1",
      expectedServiceLabel: "ai.traycer.host.fallback",
      readiness: NOT_READY_READINESS,
    });
    expect(verdict).toEqual({
      kind: "indeterminate",
      reason: "marker-uncorrelated",
    });
  });

  it("a mismatched probeNonce is rejected as uncorrelated", () => {
    const verdict = interpretProbeMarker({
      marker: marker({ probeNonce: "wrong-nonce" }),
      transitionId: "t-1",
      probeNonce: "nonce-1",
      expectedServiceLabel: "ai.traycer.host.fallback",
      readiness: NOT_READY_READINESS,
    });
    expect(verdict).toEqual({
      kind: "indeterminate",
      reason: "marker-uncorrelated",
    });
  });

  it("a marker written under the wrong serviceLabel (e.g. the agent's journal seeing a fallback-produced marker) is rejected", () => {
    const verdict = interpretProbeMarker({
      marker: marker({ serviceLabel: "ai.traycer.host.fallback" }),
      transitionId: "t-1",
      probeNonce: "nonce-1",
      expectedServiceLabel: "ai.traycer.host.agent",
      readiness: NOT_READY_READINESS,
    });
    expect(verdict).toEqual({
      kind: "indeterminate",
      reason: "marker-uncorrelated",
    });
  });

  it("a correlated marker whose embedded attestation does not match its own serviceLabel/pid is indeterminate — the reconciler never trusts a mismatched attestation", () => {
    const verdict = interpretProbeMarker({
      marker: marker({
        attestation: {
          serviceLabel: "ai.traycer.host.fallback",
          supervisorPid: 9999, // does not match marker.supervisorPid (5001)
          capturedAt: "2026-07-27T00:00:01.000Z",
        },
      }),
      transitionId: "t-1",
      probeNonce: "nonce-1",
      expectedServiceLabel: "ai.traycer.host.fallback",
      readiness: NOT_READY_READINESS,
    });
    expect(verdict).toEqual({
      kind: "indeterminate",
      reason: "marker-attestation-invalid",
    });
  });

  it("an empty capturedAt on an otherwise-matching attestation is indeterminate", () => {
    const verdict = interpretProbeMarker({
      marker: marker({
        attestation: {
          serviceLabel: "ai.traycer.host.fallback",
          supervisorPid: 5001,
          capturedAt: "",
        },
      }),
      transitionId: "t-1",
      probeNonce: "nonce-1",
      expectedServiceLabel: "ai.traycer.host.fallback",
      readiness: NOT_READY_READINESS,
    });
    expect(verdict).toEqual({
      kind: "indeterminate",
      reason: "marker-attestation-invalid",
    });
  });

  it("a correlated + attested lock-declined marker is accepted as positive success", () => {
    const verdict = interpretProbeMarker({
      marker: marker({}),
      transitionId: "t-1",
      probeNonce: "nonce-1",
      expectedServiceLabel: "ai.traycer.host.fallback",
      readiness: NOT_READY_READINESS,
    });
    expect(verdict).toEqual({ kind: "lock-declined" });
  });

  it("fast-decline race (R5-1): readiness is still 'not-ready' by the time the reconciler looks, but the correlated+attested lock-declined marker is accepted regardless — the reconciler never re-samples launchd", () => {
    // The whole point of producer-side attestation is that it must validate
    // even when the reconciler is scheduled long after the short-lived probe
    // supervisor has already exited (readiness never reaches "ready" via
    // this path at all — lock-declined does not go through the readiness
    // rungs).
    const verdict = interpretProbeMarker({
      marker: marker({
        attestation: {
          serviceLabel: "ai.traycer.host.fallback",
          supervisorPid: 5001,
          capturedAt: "2026-07-27T00:00:00.010Z", // captured 10ms after spawn
        },
      }),
      transitionId: "t-1",
      probeNonce: "nonce-1",
      expectedServiceLabel: "ai.traycer.host.fallback",
      readiness: NOT_READY_READINESS,
    });
    expect(verdict).toEqual({ kind: "lock-declined" });
  });

  it("a terminal marker outcome surfaces its reason verbatim", () => {
    const verdict = interpretProbeMarker({
      marker: marker({
        outcome: { kind: "terminal", reason: "probe-spawn-failed" },
      }),
      transitionId: "t-1",
      probeNonce: "nonce-1",
      expectedServiceLabel: "ai.traycer.host.fallback",
      readiness: NOT_READY_READINESS,
    });
    expect(verdict).toEqual({ kind: "terminal", reason: "probe-spawn-failed" });
  });

  it("an unavailable marker outcome (os-error cause) surfaces as unavailable, not indeterminate", () => {
    const verdict = interpretProbeMarker({
      marker: marker({
        outcome: {
          kind: "unavailable",
          attemptId: "a1",
          cause: {
            kind: "os-error",
            syscall: "flock",
            code: "ENOLCK",
            fsType: "apfs",
          },
          evidence: "kernel lifecycle lock acquisition was not determinable",
        },
      }),
      transitionId: "t-1",
      probeNonce: "nonce-1",
      expectedServiceLabel: "ai.traycer.host.fallback",
      readiness: NOT_READY_READINESS,
    });
    expect(verdict).toEqual({
      kind: "unavailable",
      cause: {
        kind: "os-error",
        syscall: "flock",
        code: "ENOLCK",
        fsType: "apfs",
      },
      evidence: "kernel lifecycle lock acquisition was not determinable",
    });
  });

  describe("awaiting-readiness outcome — became-ready must be reconciler-derived, never self-reported", () => {
    it("readiness ready + matching attemptId => became-ready", () => {
      const verdict = interpretProbeMarker({
        marker: marker({
          outcome: {
            kind: "awaiting-readiness",
            attemptId: "attempt-1",
            degradation: null,
          },
        }),
        transitionId: "t-1",
        probeNonce: "nonce-1",
        expectedServiceLabel: "ai.traycer.host.fallback",
        readiness: { kind: "ready", attemptId: "attempt-1" },
      });
      expect(verdict).toEqual({ kind: "became-ready" });
    });

    it("readiness ready but for a DIFFERENT attemptId => not became-ready (stale readiness cannot satisfy a different attempt)", () => {
      const verdict = interpretProbeMarker({
        marker: marker({
          outcome: {
            kind: "awaiting-readiness",
            attemptId: "attempt-1",
            degradation: null,
          },
        }),
        transitionId: "t-1",
        probeNonce: "nonce-1",
        expectedServiceLabel: "ai.traycer.host.fallback",
        readiness: { kind: "ready", attemptId: "attempt-OTHER" },
      });
      expect(verdict).toEqual({
        kind: "indeterminate",
        reason: "readiness-not-yet-observed",
      });
    });

    it("readiness indeterminate => indeterminate readiness-indeterminate, never evict", () => {
      const verdict = interpretProbeMarker({
        marker: marker({
          outcome: {
            kind: "awaiting-readiness",
            attemptId: "attempt-1",
            degradation: null,
          },
        }),
        transitionId: "t-1",
        probeNonce: "nonce-1",
        expectedServiceLabel: "ai.traycer.host.fallback",
        readiness: { kind: "indeterminate", attemptId: null },
      });
      expect(verdict).toEqual({
        kind: "indeterminate",
        reason: "readiness-indeterminate",
      });
    });

    it("readiness not-ready => indeterminate readiness-not-yet-observed", () => {
      const verdict = interpretProbeMarker({
        marker: marker({
          outcome: {
            kind: "awaiting-readiness",
            attemptId: "attempt-1",
            degradation: null,
          },
        }),
        transitionId: "t-1",
        probeNonce: "nonce-1",
        expectedServiceLabel: "ai.traycer.host.fallback",
        readiness: NOT_READY_READINESS,
      });
      expect(verdict).toEqual({
        kind: "indeterminate",
        reason: "readiness-not-yet-observed",
      });
    });
  });

  it("every non-'lock-declined'/'became-ready' verdict this suite exercises is one of the ticket's never-evict arms", () => {
    const neverEvict = new Set(["indeterminate", "terminal", "unavailable"]);
    const nonPositive = [
      interpretProbeMarker({
        marker: null,
        transitionId: "t-1",
        probeNonce: "nonce-1",
        expectedServiceLabel: "l",
        readiness: NOT_READY_READINESS,
      }),
      interpretProbeMarker({
        marker: marker({ transitionId: "other" }),
        transitionId: "t-1",
        probeNonce: "nonce-1",
        expectedServiceLabel: "ai.traycer.host.fallback",
        readiness: NOT_READY_READINESS,
      }),
    ];
    for (const verdict of nonPositive) {
      expect(neverEvict.has(verdict.kind)).toBe(true);
    }
  });
});
