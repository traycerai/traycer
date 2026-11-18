import { describe, expect, it } from "vitest";
import { deriveWedgeVerdict } from "../macos/wedge";
import type { LaunchctlPrintProbe, LaunchdRunState } from "../macos/types";

const HEALTHY_RUN_STATE: LaunchdRunState = {
  jobState: { kind: "observed", value: "running" },
  lastExitCode: { kind: "absent" },
  lastExitReason: { kind: "absent" },
  pid: { kind: "observed", value: 42 },
  runs: { kind: "observed", value: 1 },
  lwcr: { kind: "absent" },
};

function observedProbe(runState: LaunchdRunState): LaunchctlPrintProbe {
  return {
    kind: "observed",
    raw: "",
    fields: new Map(),
    ownership: {
      kind: "indeterminate",
      cause: "unrecognized-format",
      path: null,
    },
    runState,
  };
}

const NO_PROGRESS = {
  loginItemEnabled: null,
  hasPidMetadata: false,
  hasAttemptProgress: false,
};

describe("deriveWedgeVerdict", () => {
  it("passes through an indeterminate print probe as indeterminate", () => {
    const result = deriveWedgeVerdict(
      { kind: "indeterminate", cause: "timeout" },
      NO_PROGRESS,
    );
    expect(result).toEqual({ kind: "indeterminate", cause: "timeout" });
  });

  it("is healthy-or-unknown when the label is not loaded at all", () => {
    const result = deriveWedgeVerdict({ kind: "absent" }, NO_PROGRESS);
    expect(result.kind).toBe("healthy-or-unknown");
  });

  it("flags job-state-spawn-failed", () => {
    const result = deriveWedgeVerdict(
      observedProbe({
        ...HEALTHY_RUN_STATE,
        jobState: { kind: "observed", value: "spawn failed" },
      }),
      NO_PROGRESS,
    );
    expect(result).toEqual({
      kind: "wedged",
      reasons: ["job-state-spawn-failed"],
    });
  });

  it("flags last-exit-ex-config-78 via the numeric exit code", () => {
    const result = deriveWedgeVerdict(
      observedProbe({
        ...HEALTHY_RUN_STATE,
        lastExitCode: { kind: "observed", value: 78 },
      }),
      NO_PROGRESS,
    );
    expect(result).toEqual({
      kind: "wedged",
      reasons: ["last-exit-ex-config-78"],
    });
  });

  // Finding 15 — the predicate was `includes("ex_config") || includes("config")`,
  // whose first term is subsumed by the second, and whose second term is far
  // too loose for a signal that routes to a destructive transition. Sampling
  // every live job on a healthy Mac, the real `last exit reason` values are
  // JETSAM_REASON_MEMORY_IDLE_EXIT / JETSAM_REASON_MEMORY_PERPROCESSLIMIT.
  it.each([
    "JETSAM_REASON_MEMORY_IDLE_EXIT",
    "JETSAM_REASON_MEMORY_PERPROCESSLIMIT",
    "configuration daemon exited",
    "reconfigured by user",
    "/Library/Application Support/config/agent",
  ])("does NOT wedge on the exit reason %s", (reason) => {
    const verdict = deriveWedgeVerdict(
      observedProbe({
        ...HEALTHY_RUN_STATE,
        lastExitReason: { kind: "observed", value: reason },
      }),
      NO_PROGRESS,
    );
    expect(verdict.kind).toBe("healthy-or-unknown");
  });

  it("flags last-exit-ex-config-78 via the exit reason text", () => {
    const result = deriveWedgeVerdict(
      observedProbe({
        ...HEALTHY_RUN_STATE,
        lastExitReason: { kind: "observed", value: "EX_CONFIG" },
      }),
      NO_PROGRESS,
    );
    expect(result).toEqual({
      kind: "wedged",
      reasons: ["last-exit-ex-config-78"],
    });
  });

  it("flags lwcr-mismatch-markers when LWCR markers are observed", () => {
    const result = deriveWedgeVerdict(
      observedProbe({
        ...HEALTHY_RUN_STATE,
        lwcr: { kind: "observed", markers: ["has LWCR"] },
      }),
      NO_PROGRESS,
    );
    expect(result).toEqual({
      kind: "wedged",
      reasons: ["lwcr-mismatch-markers"],
    });
  });

  it("flags loaded-but-no-live-pid-and-no-attempt-progress when login item is enabled but nothing shows progress", () => {
    const result = deriveWedgeVerdict(
      observedProbe({
        ...HEALTHY_RUN_STATE,
        pid: { kind: "absent" },
      }),
      {
        loginItemEnabled: true,
        hasPidMetadata: false,
        hasAttemptProgress: false,
      },
    );
    expect(result).toEqual({
      kind: "wedged",
      reasons: ["loaded-but-no-live-pid-and-no-attempt-progress"],
    });
  });

  it("does not flag the no-live-pid reason when a live pid is present", () => {
    const result = deriveWedgeVerdict(observedProbe(HEALTHY_RUN_STATE), {
      loginItemEnabled: true,
      hasPidMetadata: false,
      hasAttemptProgress: false,
    });
    expect(result.kind).toBe("healthy-or-unknown");
  });

  it("does not flag the no-live-pid reason when attempt progress exists", () => {
    const result = deriveWedgeVerdict(
      observedProbe({ ...HEALTHY_RUN_STATE, pid: { kind: "absent" } }),
      {
        loginItemEnabled: true,
        hasPidMetadata: false,
        hasAttemptProgress: true,
      },
    );
    expect(result.kind).toBe("healthy-or-unknown");
  });

  it("collects multiple simultaneous wedge reasons", () => {
    const result = deriveWedgeVerdict(
      observedProbe({
        ...HEALTHY_RUN_STATE,
        jobState: { kind: "observed", value: "spawn failed" },
        lastExitCode: { kind: "observed", value: 78 },
      }),
      NO_PROGRESS,
    );
    expect(result.kind).toBe("wedged");
    if (result.kind === "wedged") {
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          "job-state-spawn-failed",
          "last-exit-ex-config-78",
        ]),
      );
    }
  });

  it("is healthy-or-unknown when loaded with no positive wedge markers", () => {
    const result = deriveWedgeVerdict(
      observedProbe(HEALTHY_RUN_STATE),
      NO_PROGRESS,
    );
    expect(result).toEqual({
      kind: "healthy-or-unknown",
      note: "loaded with no positive wedge markers",
    });
  });
});
