import { describe, expect, it } from "vitest";
import type {
  HostConnectivity,
  HostListItem,
  HostStatusDTO,
  HostUpdateState,
} from "@traycer/protocol/host/host-status";
import {
  deriveHostPresence,
  deriveUpdateAffordance,
  deriveUpdatePill,
  formatHostMeta,
  formatLastSeen,
  isValidHostVersion,
  liveBusySessionCount,
  settledBusySessionCount,
  type HostPresenceView,
  type LiveBusySessionCountOptions,
  type ViewerReachabilityCheckLike,
} from "@/components/settings/panels/my-hosts-model";

const NOW = Date.parse("2026-07-03T12:00:00.000Z");

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

/**
 * Wraps `deriveHostPresence` for the "core DTO-driven logic, host identity
 * irrelevant" tests below — always the LOCAL branch (no relay sub-states, no
 * live-session override, no viewer check).
 */
function deriveLocal(status: HostStatusDTO): HostPresenceView {
  return deriveHostPresence({
    status,
    isViewerLocalHost: true,
    hasLiveSession: false,
    viewerCheck: null,
    nowMs: NOW,
  });
}

describe("deriveHostPresence", () => {
  it("renders Online with a live dot for connectable", () => {
    const view = deriveLocal(statusDto({ connectivity: "connectable" }));
    expect(view.tone).toBe("online");
    expect(view.label).toBe("Online");
    expect(view.showLiveDot).toBe(true);
  });

  it("renders Offline (no dot) for offline connectivity", () => {
    const view = deriveLocal(statusDto({ connectivity: "offline" }));
    expect(view.tone).toBe("offline");
    expect(view.label).toBe("Offline");
    expect(view.showLiveDot).toBe(false);
  });

  it("renders You're offline when the client itself is offline", () => {
    const view = deriveLocal(
      statusDto({ connectivity: "connectable", clientCloud: "down" }),
    );
    expect(view.tone).toBe("client-offline");
    expect(view.showLiveDot).toBe(false);
  });

  describe("connectivity → tone mapping, and the never-false-Offline invariant", () => {
    it("never shows a live dot without live evidence, across every connectivity value", () => {
      const values: HostConnectivity[] = [
        "connectable",
        "offline",
        "local-only",
        "unknown",
      ];
      for (const connectivity of values) {
        const view = deriveLocal(statusDto({ connectivity }));
        expect(view.showLiveDot).toBe(connectivity === "connectable");
      }
    });

    it("renders local-only as its own tone, labelled Local only, and NEVER Offline", () => {
      const view = deriveLocal(statusDto({ connectivity: "local-only" }));
      expect(view.tone).toBe("local-only");
      expect(view.label).toBe("Local only");
      expect(view.tone).not.toBe("offline");
    });

    it("NEVER renders a false Offline when coordination is blind (moved from the envelope's presenceHealth to connectivity: 'unknown')", () => {
      // This invariant used to live on the response envelope: an expired
      // lease under `presenceHealth: degraded` rendered "Status unknown", not
      // Offline. The envelope flag is gone; the same rule now lives PER HOST
      // as `connectivity: "unknown"`. Pinning it under its new name, and
      // asserting the negative explicitly, is what keeps the invariant from
      // quietly disappearing when its carrier moved.
      const view = deriveLocal(statusDto({ connectivity: "unknown" }));
      expect(view.tone).toBe("unknown");
      expect(view.label).toBe("Status unknown");
      expect(view.tone).not.toBe("offline");
    });
  });

  describe("remote-host connection-issue sub-state (R4-B5)", () => {
    it("renders connection-issue with a timestamped provenance when the viewer's own check failed", () => {
      const check: ViewerReachabilityCheckLike = {
        result: "failing",
        checkedAtMs: NOW - 2 * 60_000,
      };
      const view = deriveHostPresence({
        status: statusDto({ connectivity: "connectable" }),
        isViewerLocalHost: false,
        hasLiveSession: false,
        viewerCheck: check,
        nowMs: NOW,
      });
      expect(view.tone).toBe("connection-issue");
      expect(view.label).toBe("Reachable, connection issue (checked 2m ago)");
      // Still a live signal — the host itself is reachable, only this
      // viewer's path is degraded.
      expect(view.showLiveDot).toBe(true);
    });

    it("ignores a stale-ok viewer check and renders plain Online", () => {
      const check: ViewerReachabilityCheckLike = {
        result: "ok",
        checkedAtMs: NOW - 60_000,
      };
      const view = deriveHostPresence({
        status: statusDto({ connectivity: "connectable" }),
        isViewerLocalHost: false,
        hasLiveSession: false,
        viewerCheck: check,
        nowMs: NOW,
      });
      expect(view.tone).toBe("online");
    });

    it("never applies the connection-issue sub-state to a local host, even with a failing viewer check", () => {
      const check: ViewerReachabilityCheckLike = {
        result: "failing",
        checkedAtMs: NOW,
      };
      const view = deriveHostPresence({
        status: statusDto({ connectivity: "connectable" }),
        isViewerLocalHost: true,
        hasLiveSession: false,
        viewerCheck: check,
        nowMs: NOW,
      });
      expect(view.tone).toBe("online");
    });
  });

  describe("live-session-evidence override (R4-B5)", () => {
    it("renders Online regardless of an offline connectivity or a failing viewer check", () => {
      const check: ViewerReachabilityCheckLike = {
        result: "failing",
        checkedAtMs: NOW,
      };
      const view = deriveHostPresence({
        status: statusDto({ connectivity: "offline" }),
        isViewerLocalHost: false,
        hasLiveSession: true,
        viewerCheck: check,
        nowMs: NOW,
      });
      expect(view.tone).toBe("online");
      expect(view.label).toBe("Online");
      expect(view.showLiveDot).toBe(true);
    });

    it("beats local-only and unknown too — firsthand proof outranks every cloud read", () => {
      for (const connectivity of ["local-only", "unknown"] as const) {
        const view = deriveHostPresence({
          status: statusDto({ connectivity }),
          isViewerLocalHost: false,
          hasLiveSession: true,
          viewerCheck: null,
          nowMs: NOW,
        });
        expect(view.tone).toBe("online");
      }
    });

    it("does not override You're offline (the client itself has no path to claim anything)", () => {
      const view = deriveHostPresence({
        status: statusDto({ connectivity: "connectable", clientCloud: "down" }),
        isViewerLocalHost: false,
        hasLiveSession: true,
        viewerCheck: null,
        nowMs: NOW,
      });
      expect(view.tone).toBe("client-offline");
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

describe("formatHostMeta", () => {
  const now = Date.parse("2026-07-03T12:00:00.000Z");

  function listItem(
    status: HostStatusDTO,
    platform: string | null,
  ): HostListItem {
    return {
      hostId: "host-1",
      displayName: "prod-devbox",
      platform,
      kind: "personal",
      publicKey: "pk",
      createdAt: "2026-07-01T12:00:00.000Z",
      status,
      updatePolicy: "manual",
    };
  }

  it("joins platform and version for a live host", () => {
    const status = statusDto({
      connectivity: "connectable",
      appVersion: "1.4.2",
    });
    const item = listItem(status, "Ubuntu");
    expect(formatHostMeta(item, deriveLocal(status), now)).toBe(
      "Ubuntu · v1.4.2",
    );
  });

  it("prefers the last-seen hint for an offline host", () => {
    const status = statusDto({
      connectivity: "offline",
      appVersion: "1.1.0",
      lastSeenAt: "2026-07-03T10:00:00.000Z",
    });
    const item = listItem(status, "Ubuntu");
    expect(formatHostMeta(item, deriveLocal(status), now)).toBe(
      "last seen 2h ago",
    );
  });

  it("prefers the last-seen hint for unknown too — a blind read leaves last-seen the only true fact", () => {
    const status = statusDto({
      connectivity: "unknown",
      appVersion: "1.1.0",
      lastSeenAt: "2026-07-03T10:00:00.000Z",
    });
    const item = listItem(status, "Ubuntu");
    expect(formatHostMeta(item, deriveLocal(status), now)).toBe(
      "last seen 2h ago",
    );
  });

  it("does NOT show last-seen for local-only — nothing there is stale or missing", () => {
    const status = statusDto({
      connectivity: "local-only",
      appVersion: "1.1.0",
      lastSeenAt: "2026-07-03T10:00:00.000Z",
    });
    const item = listItem(status, "Ubuntu");
    expect(formatHostMeta(item, deriveLocal(status), now)).toBe(
      "Ubuntu · v1.1.0",
    );
  });
});

describe("isValidHostVersion", () => {
  it("accepts dotted-numeric versions with 1-3 segments", () => {
    expect(isValidHostVersion("1")).toBe(true);
    expect(isValidHostVersion("1.4")).toBe(true);
    expect(isValidHostVersion("1.4.2")).toBe(true);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(isValidHostVersion("  1.4.2  ")).toBe(true);
  });

  it("rejects non-dotted-numeric or malformed input", () => {
    expect(isValidHostVersion("")).toBe(false);
    expect(isValidHostVersion("v1.4.2")).toBe(false);
    expect(isValidHostVersion("1.4.2.1")).toBe(false);
    expect(isValidHostVersion("1..4")).toBe(false);
    expect(isValidHostVersion("latest")).toBe(false);
    expect(isValidHostVersion("1.4.2-beta")).toBe(false);
  });
});

describe("deriveUpdateAffordance", () => {
  it("shows the Update now input for current/available/required/failed, hides it for pending/updating", () => {
    const shown: HostUpdateState[] = [
      "current",
      "available",
      "required",
      "failed",
    ];
    const hidden: HostUpdateState[] = ["pending", "updating"];
    for (const updateState of shown) {
      expect(
        deriveUpdateAffordance({ updateState, liveBusySessionCount: null })
          .showUpdateNowInput,
      ).toBe(true);
    }
    for (const updateState of hidden) {
      expect(
        deriveUpdateAffordance({ updateState, liveBusySessionCount: null })
          .showUpdateNowInput,
      ).toBe(false);
    }
  });

  it("shows no drain-gate copy when not pending, even with a live count above zero", () => {
    const view = deriveUpdateAffordance({
      updateState: "current",
      liveBusySessionCount: 3,
    });
    expect(view.waitingForSessionsLabel).toBeNull();
    expect(view.showApplyNowForce).toBe(false);
    expect(view.applyNowLabel).toBeNull();
  });

  it("shows no drain-gate copy when pending but not yet waiting on sessions (live count 0)", () => {
    const view = deriveUpdateAffordance({
      updateState: "pending",
      liveBusySessionCount: 0,
    });
    expect(view.waitingForSessionsLabel).toBeNull();
    expect(view.showApplyNowForce).toBe(false);
    expect(view.applyNowLabel).toBeNull();
  });

  it("shows singular copy for exactly one blocking session", () => {
    const view = deriveUpdateAffordance({
      updateState: "pending",
      liveBusySessionCount: 1,
    });
    expect(view.waitingForSessionsLabel).toBe("Waiting for 1 session");
    expect(view.showApplyNowForce).toBe(true);
    expect(view.applyNowLabel).toBe("Apply now — ends 1 session");
  });

  it("shows plural copy and the drain-gate force for multiple blocking sessions", () => {
    const view = deriveUpdateAffordance({
      updateState: "pending",
      liveBusySessionCount: 3,
    });
    expect(view.waitingForSessionsLabel).toBe("Waiting for 3 sessions");
    expect(view.showApplyNowForce).toBe(true);
    expect(view.applyNowLabel).toBe("Apply now — ends 3 sessions");
  });

  describe("null vs zero — absence is not zero (safety-critical)", () => {
    it("shows no drain-gate copy, and withholds the destructive force, when there is no live source at all", () => {
      // `pending` with a live count of `null` must NOT read as "0 sessions
      // blocking" — that would either silently drop the drain notice from a
      // host genuinely waiting on sessions, or (worse) offer to end "0
      // sessions" on click while ending however many are actually open.
      const view = deriveUpdateAffordance({
        updateState: "pending",
        liveBusySessionCount: null,
      });
      expect(view.waitingForSessionsLabel).toBeNull();
      expect(view.showApplyNowForce).toBe(false);
      expect(view.applyNowLabel).toBeNull();
    });

    it('distinguishes null from 0 — both withhold the force, but only 0 is a positive statement of "no sessions"', () => {
      const nullView = deriveUpdateAffordance({
        updateState: "pending",
        liveBusySessionCount: null,
      });
      const zeroView = deriveUpdateAffordance({
        updateState: "pending",
        liveBusySessionCount: 0,
      });
      // Both currently render identically (neither shows a force) — the
      // distinction that matters is that neither treats `null` as if it were
      // a confirmed zero from a live source. Pinning both cases separately
      // (rather than asserting equality) keeps a future divergence between
      // them from going unnoticed.
      expect(nullView.showApplyNowForce).toBe(false);
      expect(zeroView.showApplyNowForce).toBe(false);
      expect(nullView.waitingForSessionsLabel).toBeNull();
      expect(zeroView.waitingForSessionsLabel).toBeNull();
    });

    it("still hides the Update now input while pending with no live session source", () => {
      // `showUpdateNowInput` is registry-backed and gates purely on
      // `updateState` (hidden for `pending`/`updating`), independent of the
      // live-count question — a missing live source does not reopen it.
      const view = deriveUpdateAffordance({
        updateState: "pending",
        liveBusySessionCount: null,
      });
      expect(view.showUpdateNowInput).toBe(false);
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
    // The disabled-query hazard: losing the route disables the query rather
    // than failing it, and TanStack retains the last success as idle,
    // non-error and (until staleTime) non-stale - every OTHER field reads
    // "settled". Without this gate the Updates card could keep offering
    // "Apply now - ends N sessions" for the whole staleTime window with no
    // live source behind the number.
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
    // The TanStack-retains-data hazard this function exists to close: a
    // refetch error does not clear `data`, so a caller reading only
    // `reportedCount` would keep showing (and destroying) a stale number.
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
    // Deliberately paired with the `settledBusySessionCount` test of the same
    // inputs below. This function used to be the only answer, and pinning this
    // case here alone read as "the retained number is trustworthy again",
    // which is what let the drain force re-arm from it. It is not that claim:
    // it is a display decision, and the destructive path reads the other
    // function.
    expect(
      liveBusySessionCount(
        options({ reportedCount: 1, isStale: true, fetchStatus: "fetching" }),
      ),
    ).toBe(1);
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

/**
 * The destructive read, and specifically where it DIVERGES from the display
 * one. Same options object in both suites on purpose: the pair is the
 * assertion.
 */
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
    // THE split. `liveBusySessionCount` returns 1 for these exact inputs (see
    // the suite above). Arming a force from that number is what let a panel
    // promise "ends 2 sessions" and end five: the confirm-time equality guard
    // compares the retained value against the armed value, which is the same
    // retained value, so it agrees with itself and permits the force.
    const refetching = options({
      reportedCount: 1,
      isStale: true,
      fetchStatus: "fetching",
    });
    expect(liveBusySessionCount(refetching)).toBe(1);
    expect(settledBusySessionCount(refetching)).toBeNull();
  });

  it("refuses a fresh value while a background refetch is in flight", () => {
    // Not stale, but not settled either. The window is one host RPC over an
    // already-open connection; refusing to arm inside it costs a moment, and
    // arming inside it costs sessions.
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
