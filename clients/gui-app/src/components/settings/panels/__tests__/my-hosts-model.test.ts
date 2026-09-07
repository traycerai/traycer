import { describe, expect, it } from "vitest";
import type {
  HostConnectivity,
  HostStatusDTO,
  HostUpdateState,
} from "@traycer/protocol/host/host-status";
import {
  busyBreakdownFromAwareness,
  deriveHostPresence,
  deriveUpdateAffordance,
  deriveUpdatePill,
  formatLastSeen,
  liveBusySessionCount,
  settledBusySessionCount,
  type DtoPresenceView,
  type LiveBusySessionCountOptions,
} from "@/components/settings/panels/my-hosts-model";
import { HOST_RUNTIME_STATUS_AWARENESS_FIELD } from "@traycer/protocol/host/notifications/index";

function statusDto(overrides: Partial<HostStatusDTO>): HostStatusDTO {
  return {
    connectivity: "offline",
    viewerReachability: "unknown",
    clientCloud: "ok",
    updateState: "current",
    appVersion: null,
    lastSeenAt: null,
    ...overrides,
  };
}

/** Wraps `deriveHostPresence` for the "core DTO-driven logic" tests below - no live session, so every answer
 * comes from the DTO itself. */
const PLAN_ALLOWS_REMOTE = true;
const PLAN_GATED = false;
const NOW_MS = Date.parse("2026-07-03T12:00:00.000Z");

function deriveLocal(status: HostStatusDTO): DtoPresenceView {
  return deriveHostPresence({
    status,
    hasLiveSession: false,
    planAllowsRemote: PLAN_ALLOWS_REMOTE,
    nowMs: NOW_MS,
  });
}

function derivePlanGated(status: HostStatusDTO): DtoPresenceView {
  return deriveHostPresence({
    status,
    hasLiveSession: false,
    planAllowsRemote: PLAN_GATED,
    nowMs: NOW_MS,
  });
}

describe("deriveHostPresence", () => {
  /** , at the exact line that produced the overclaim. Nothing about a never-dialled host has changed except our
   * honesty about it. */
  it("renders Reported reachable, with NO dot, for a connectable lease nothing has dialled", () => {
    const view = deriveLocal(statusDto({ connectivity: "connectable" }));
    expect(view.reading).toBe("reported-reachable");
    expect(view.label).toBe("Reported reachable");
    expect(view.label).not.toBe("Online");
    expect(view.showLiveDot).toBe(false);
  });

  it("renders Offline (no dot) for offline connectivity", () => {
    const view = deriveLocal(statusDto({ connectivity: "offline" }));
    expect(view.reading).toBe("offline");
    expect(view.label).toBe("Offline");
    expect(view.showLiveDot).toBe(false);
  });

  it("renders You're offline when the client itself is offline", () => {
    const view = deriveLocal(
      statusDto({ connectivity: "connectable", clientCloud: "down" }),
    );
    expect(view.reading).toBe("client-offline");
    expect(view.showLiveDot).toBe(false);
  });

  describe("connectivity → reading mapping, and the never-false-Offline invariant", () => {
    /** The invariant, stated the way it was always meant and never was. The `hasLiveSession` override below is the
     * only thing that can, which is what makes the sentence true. */
    it("never shows a live dot without live evidence, across every connectivity value", () => {
      const values: HostConnectivity[] = [
        "connectable",
        "offline",
        "unknown",
        "local-only",
      ];
      for (const connectivity of values) {
        const view = deriveLocal(statusDto({ connectivity }));
        expect(view.showLiveDot).toBe(false);
      }
    });

    it("renders Local only for a plan-gated host the cloud reports connectable, and NEVER Offline", () => {
      const view = derivePlanGated(statusDto({ connectivity: "connectable" }));
      expect(view.reading).toBe("local-only");
      expect(view.label).toBe("Local only");
      expect(view.reading).not.toBe("offline");
    });

    it("renders Local only for a plan-gated host the cloud cannot read (unknown)", () => {
      const view = derivePlanGated(statusDto({ connectivity: "unknown" }));
      expect(view.reading).toBe("local-only");
    });

    it("renders Local only for a plan-gated offline host with a recent credential check-in", () => {
      const view = derivePlanGated(
        statusDto({
          connectivity: "offline",
          lastSeenAt: "2026-07-03T11:40:00.000Z",
        }),
      );
      expect(view.reading).toBe("local-only");
      expect(view.label).toBe("Local only");
    });

    it("renders Offline for a plan-gated offline host whose credential check-in is stale", () => {
      const view = derivePlanGated(
        statusDto({
          connectivity: "offline",
          lastSeenAt: "2026-07-03T11:29:59.999Z",
        }),
      );
      expect(view.reading).toBe("offline");
      expect(view.label).toBe("Offline");
    });

    it("keeps accepting the transitional local-only wire value", () => {
      const view = deriveLocal(statusDto({ connectivity: "local-only" }));
      expect(view.reading).toBe("local-only");
    });

    it("NEVER renders a false Offline when coordination is blind (moved from the envelope's presenceHealth to connectivity: 'unknown')", () => {
      // The envelope flag is gone; the same rule now lives per host as `connectivity: "unknown"`.
      const view = deriveLocal(statusDto({ connectivity: "unknown" }));
      expect(view.reading).toBe("unknown");
      expect(view.label).toBe("Status unknown");
      expect(view.reading).not.toBe("offline");
    });
  });

  // Deleted with its subject in - the probe that would have written that verdict was never built, so the arm was
  // unreachable and these three tests only ever proved that a hand-supplied input produced a hand-written label.

  describe("live-session-evidence override (R4-B5)", () => {
    it("renders Online regardless of an offline connectivity", () => {
      const view = deriveHostPresence({
        status: statusDto({ connectivity: "offline" }),
        hasLiveSession: true,
        planAllowsRemote: PLAN_ALLOWS_REMOTE,
        nowMs: NOW_MS,
      });
      expect(view.reading).toBe("online");
      expect(view.label).toBe("Online");
      expect(view.showLiveDot).toBe(true);
    });

    it("beats unknown and a plan-gated connectable too — firsthand proof outranks every cloud read", () => {
      const viewUnknown = deriveHostPresence({
        status: statusDto({ connectivity: "unknown" }),
        hasLiveSession: true,
        planAllowsRemote: PLAN_ALLOWS_REMOTE,
        nowMs: NOW_MS,
      });
      expect(viewUnknown.reading).toBe("online");
      const viewGated = deriveHostPresence({
        status: statusDto({ connectivity: "connectable" }),
        hasLiveSession: true,
        planAllowsRemote: PLAN_GATED,
        nowMs: NOW_MS,
      });
      expect(viewGated.reading).toBe("online");
    });

    it("does not override You're offline (the client itself has no path to claim anything)", () => {
      const view = deriveHostPresence({
        status: statusDto({ connectivity: "connectable", clientCloud: "down" }),
        hasLiveSession: true,
        planAllowsRemote: PLAN_ALLOWS_REMOTE,
        nowMs: NOW_MS,
      });
      expect(view.reading).toBe("client-offline");
    });
  });
});

describe("deriveUpdatePill", () => {
  it("shows nothing when current", () => {
    expect(deriveUpdatePill("current")).toBeNull();
  });

  it("maps each update state to a pill", () => {
    const cases: Array<[HostUpdateState, string]> = [
      ["available", "Update available"],
      ["pending", "Update pending"],
      ["updating", "Updating…"],
      ["failed", "Update failed"],
      ["required", "Update required"],
    ];
    for (const [state, label] of cases) {
      expect(deriveUpdatePill(state)?.label).toBe(label);
    }
  });
});

describe("formatLastSeen", () => {
  const now = Date.parse("2026-07-03T12:00:00.000Z");

  it("returns null when never seen", () => {
    expect(formatLastSeen(null, now)).toBeNull();
  });

  it("formats recent as just now, then minutes/hours/days", () => {
    expect(formatLastSeen("2026-07-03T11:59:50.000Z", now)).toBe(
      "last seen just now",
    );
    expect(formatLastSeen("2026-07-03T11:55:00.000Z", now)).toBe(
      "last seen 5m ago",
    );
    expect(formatLastSeen("2026-07-03T10:00:00.000Z", now)).toBe(
      "last seen 2h ago",
    );
    expect(formatLastSeen("2026-07-01T12:00:00.000Z", now)).toBe(
      "last seen 2d ago",
    );
  });
});

// The `formatHostMeta` block that sat here is gone with the function. They are recorded as a coverage
// deletion, not a port: nothing else asserts that mapping, because nothing else runs it.

describe("deriveUpdateAffordance", () => {
  // The `showUpdateNowInput` cases that sat here are gone with the free-text
  // version pin they gated - see the note above `HostUpdateAffordanceView`.
  it("shows no drain-gate copy when not pending, even with a live count above zero", () => {
    const view = deriveUpdateAffordance({
      updateState: "current",
      liveBusySessionCount: 3,
      liveBusyBreakdown: null,
    });
    expect(view.waitingForSessionsLabel).toBeNull();
    expect(view.showApplyNowForce).toBe(false);
    expect(view.applyNowLabel).toBeNull();
  });

  it("shows no drain-gate copy when pending but not yet waiting on sessions (live count 0)", () => {
    const view = deriveUpdateAffordance({
      updateState: "pending",
      liveBusySessionCount: 0,
      liveBusyBreakdown: null,
    });
    expect(view.waitingForSessionsLabel).toBeNull();
    expect(view.showApplyNowForce).toBe(false);
    expect(view.applyNowLabel).toBeNull();
  });

  it("shows singular copy for exactly one blocking session", () => {
    const view = deriveUpdateAffordance({
      updateState: "pending",
      liveBusySessionCount: 1,
      liveBusyBreakdown: null,
    });
    expect(view.waitingForSessionsLabel).toBe("Waiting for 1 session");
    expect(view.showApplyNowForce).toBe(true);
    expect(view.applyNowLabel).toBe("Apply now — ends 1 session");
  });

  it("shows plural copy and the drain-gate force for multiple blocking sessions", () => {
    const view = deriveUpdateAffordance({
      updateState: "pending",
      liveBusySessionCount: 3,
      liveBusyBreakdown: null,
    });
    expect(view.waitingForSessionsLabel).toBe("Waiting for 3 sessions");
    expect(view.showApplyNowForce).toBe(true);
    expect(view.applyNowLabel).toBe("Apply now — ends 3 sessions");
  });

  it("names the breakdown on the force when a typed split is present", () => {
    const view = deriveUpdateAffordance({
      updateState: "pending",
      liveBusySessionCount: 3,
      liveBusyBreakdown: {
        workingAgents: 2,
        activeTerminalAgents: 0,
        busyTerminals: 1,
      },
    });
    expect(view.waitingForSessionsLabel).toBe(
      "Waiting for 2 agents and 1 terminal",
    );
    expect(view.showApplyNowForce).toBe(true);
    expect(view.applyNowLabel).toBe("Apply now — ends 2 agents and 1 terminal");
    expect(view.applyNowLabel).not.toMatch(/session/i);
  });

  it("keeps the count copy when the breakdown is a zero object (no nameable work)", () => {
    const view = deriveUpdateAffordance({
      updateState: "pending",
      liveBusySessionCount: 2,
      liveBusyBreakdown: {
        workingAgents: 0,
        activeTerminalAgents: 0,
        busyTerminals: 0,
      },
    });
    expect(view.applyNowLabel).toBe("Apply now — ends 2 sessions");
  });

  describe("null vs zero — absence is not zero (safety-critical)", () => {
    it("shows no drain-gate copy, and withholds the destructive force, when there is no live source at all", () => {
      // `pending` with a live count of `null` must not read as "0 sessions blocking".
      const view = deriveUpdateAffordance({
        updateState: "pending",
        liveBusySessionCount: null,
        liveBusyBreakdown: null,
      });
      expect(view.waitingForSessionsLabel).toBeNull();
      expect(view.showApplyNowForce).toBe(false);
      expect(view.applyNowLabel).toBeNull();
    });

    it('distinguishes null from 0 — both withhold the force, but only 0 is a positive statement of "no sessions"', () => {
      const nullView = deriveUpdateAffordance({
        updateState: "pending",
        liveBusySessionCount: null,
        liveBusyBreakdown: null,
      });
      const zeroView = deriveUpdateAffordance({
        updateState: "pending",
        liveBusySessionCount: 0,
        liveBusyBreakdown: null,
      });
      // Pinning both cases separately (rather than asserting equality) keeps a future divergence between them from
      // going unnoticed.
      expect(nullView.showApplyNowForce).toBe(false);
      expect(zeroView.showApplyNowForce).toBe(false);
      expect(nullView.waitingForSessionsLabel).toBeNull();
      expect(zeroView.waitingForSessionsLabel).toBeNull();
    });
  });
});

describe("liveBusySessionCount", () => {
  function options(
    overrides: Partial<LiveBusySessionCountOptions>,
  ): LiveBusySessionCountOptions {
    return {
      reportedCount: 2,
      isError: false,
      fetchStatus: "idle",
      isStale: false,
      hasLiveSource: true,
      ...overrides,
    };
  }

  it("demotes to null the moment the live RPC is disabled - a retained idle/non-error/fresh cache is not a source", () => {
    // Without this gate the Updates card could keep offering "Apply now - ends N sessions" for the whole staleTime
    // window with no live source behind the number.
    expect(liveBusySessionCount(options({ hasLiveSource: false }))).toBeNull();
    expect(
      settledBusySessionCount(options({ hasLiveSource: false })),
    ).toBeNull();
  });

  it("passes the reported count through on a healthy, fresh read", () => {
    expect(liveBusySessionCount(options({ reportedCount: 4 }))).toBe(4);
  });

  it("passes a reported zero through unchanged — a positive statement of 'no sessions'", () => {
    expect(liveBusySessionCount(options({ reportedCount: 0 }))).toBe(0);
  });

  it("demotes to null when the last read errored, even with a count still cached", () => {
    // The TanStack-retains-data hazard this function exists to close: a refetch error does not clear `data`, so a
    // caller reading only `reportedCount` would keep showing (and destroying) a stale number.
    expect(
      liveBusySessionCount(options({ reportedCount: 5, isError: true })),
    ).toBeNull();
  });

  it("demotes to null while fetching is paused (offline; nothing will correct it)", () => {
    expect(
      liveBusySessionCount(
        options({ reportedCount: 3, fetchStatus: "paused" }),
      ),
    ).toBeNull();
  });

  it("demotes to null once the value has gone stale and is not actively refetching", () => {
    expect(
      liveBusySessionCount(
        options({ reportedCount: 1, isStale: true, fetchStatus: "idle" }),
      ),
    ).toBeNull();
  });

  it("keeps RENDERING a stale value that is actively refetching — a panel does not blank for a round trip", () => {
    // It is not that claim: it is a display decision, and the destructive path reads the other function.
    expect(
      liveBusySessionCount(
        options({ reportedCount: 1, isStale: true, fetchStatus: "fetching" }),
      ),
    ).toBe(1);
  });

  it("keeps RENDERING a retained count while an errored read is refetching", () => {
    // Display keeps it; settled still refuses to arm.
    const refetchingAfterError = options({
      reportedCount: 2,
      isError: true,
      fetchStatus: "fetching",
    });
    expect(liveBusySessionCount(refetchingAfterError)).toBe(2);
    expect(settledBusySessionCount(refetchingAfterError)).toBeNull();
  });

  it("an errored AND stale read still demotes to null (error takes precedence, not that it matters here)", () => {
    expect(
      liveBusySessionCount(
        options({
          reportedCount: 2,
          isError: true,
          isStale: true,
          fetchStatus: "idle",
        }),
      ),
    ).toBeNull();
  });
});

/** The destructive read, and specifically where it diverges from the display one. */
describe("settledBusySessionCount", () => {
  function options(
    overrides: Partial<LiveBusySessionCountOptions>,
  ): LiveBusySessionCountOptions {
    return {
      reportedCount: 2,
      isError: false,
      fetchStatus: "idle",
      isStale: false,
      hasLiveSource: true,
      ...overrides,
    };
  }

  it("passes the reported count through on a settled, fresh read", () => {
    expect(settledBusySessionCount(options({ reportedCount: 4 }))).toBe(4);
  });

  it("passes a reported zero through unchanged", () => {
    expect(settledBusySessionCount(options({ reportedCount: 0 }))).toBe(0);
  });

  it("refuses the stale-while-refetching value the display read still shows", () => {
    // Arming a force from that number is what let a panel promise "ends 2 sessions" and end five.
    const refetching = options({
      reportedCount: 1,
      isStale: true,
      fetchStatus: "fetching",
    });
    expect(liveBusySessionCount(refetching)).toBe(1);
    expect(settledBusySessionCount(refetching)).toBeNull();
  });

  it("refuses a fresh value while a background refetch is in flight", () => {
    // Not stale, but not settled either.
    expect(
      settledBusySessionCount(
        options({ reportedCount: 3, isStale: false, fetchStatus: "fetching" }),
      ),
    ).toBeNull();
  });

  it("refuses everything the display read refuses", () => {
    for (const overrides of [
      { isError: true },
      { fetchStatus: "paused" } as const,
      { isStale: true, fetchStatus: "idle" } as const,
    ]) {
      expect(settledBusySessionCount(options(overrides))).toBeNull();
    }
  });
});

describe("busyBreakdownFromAwareness", () => {
  it("reads a populated split off the room field", () => {
    const breakdown = {
      workingAgents: 2,
      activeTerminalAgents: 0,
      busyTerminals: 1,
    };
    expect(
      busyBreakdownFromAwareness({
        [HOST_RUNTIME_STATUS_AWARENESS_FIELD]: {
          busy: true,
          busySessionCount: 3,
          updateProgress: null,
          busyBreakdown: breakdown,
        },
      }),
    ).toEqual(breakdown);
  });

  it("returns null when the host omitted the key or sent null", () => {
    expect(
      busyBreakdownFromAwareness({
        [HOST_RUNTIME_STATUS_AWARENESS_FIELD]: {
          busy: true,
          busySessionCount: 2,
          updateProgress: null,
        },
      }),
    ).toBeNull();
    expect(
      busyBreakdownFromAwareness({
        [HOST_RUNTIME_STATUS_AWARENESS_FIELD]: {
          busy: true,
          busySessionCount: 2,
          updateProgress: null,
          busyBreakdown: null,
        },
      }),
    ).toBeNull();
    expect(busyBreakdownFromAwareness({})).toBeNull();
  });
});
