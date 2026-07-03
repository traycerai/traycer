import { describe, expect, it } from "vitest";
import type {
  HostListItem,
  HostPresenceHealth,
  HostPresenceLeaseState,
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
  type HostPresenceView,
  type ViewerReachabilityCheckLike,
} from "@/components/settings/panels/my-hosts-model";

const HEALTHY: HostPresenceHealth = { status: "healthy", reason: null };
const DEGRADED: HostPresenceHealth = {
  status: "degraded",
  reason: "presence-store-unavailable",
};
const NOW = Date.parse("2026-07-03T12:00:00.000Z");

function statusDto(overrides: Partial<HostStatusDTO>): HostStatusDTO {
  return {
    presenceLease: "expired",
    hostRelayAttached: false,
    viewerReachability: "unknown",
    clientCloud: "ok",
    busy: false,
    busySessionCount: 0,
    updateState: "current",
    appVersion: null,
    lastSeenAt: null,
    ...overrides,
  };
}

/**
 * Wraps `deriveHostPresence` for the "core DTO-driven logic, host identity
 * irrelevant" tests below — always the LOCAL branch (no relay sub-states, no
 * live-session override, no viewer check), matching what these tests
 * originally exercised before the relay-derived states existed.
 */
function deriveLocal(
  status: HostStatusDTO,
  presenceHealth: HostPresenceHealth,
): HostPresenceView {
  return deriveHostPresence({
    status,
    presenceHealth,
    isViewerLocalHost: true,
    hasLiveSession: false,
    viewerCheck: null,
    nowMs: NOW,
  });
}

describe("deriveHostPresence", () => {
  it("renders Online with a live dot for a fresh lease", () => {
    const view = deriveLocal(statusDto({ presenceLease: "fresh" }), HEALTHY);
    expect(view.tone).toBe("online");
    expect(view.label).toBe("Online");
    expect(view.showLiveDot).toBe(true);
  });

  it("renders Online with a live dot for a stale lease (still live)", () => {
    const view = deriveLocal(statusDto({ presenceLease: "stale" }), HEALTHY);
    expect(view.tone).toBe("online");
    expect(view.showLiveDot).toBe(true);
  });

  it("surfaces busy only when Online", () => {
    const online = deriveLocal(
      statusDto({ presenceLease: "fresh", busy: true }),
      HEALTHY,
    );
    expect(online.busy).toBe(true);
    // A busy flag on an expired lease must not leak into an offline row.
    const offline = deriveLocal(
      statusDto({ presenceLease: "expired", busy: true }),
      HEALTHY,
    );
    expect(offline.busy).toBe(false);
  });

  it("renders Offline (no dot) for an expired lease when ingestion is healthy", () => {
    const view = deriveLocal(statusDto({ presenceLease: "expired" }), HEALTHY);
    expect(view.tone).toBe("offline");
    expect(view.label).toBe("Offline");
    expect(view.showLiveDot).toBe(false);
  });

  it("NEVER renders a false Offline when presence is degraded", () => {
    const view = deriveLocal(statusDto({ presenceLease: "expired" }), DEGRADED);
    expect(view.tone).toBe("unknown");
    expect(view.label).toBe("Status unknown");
    expect(view.showLiveDot).toBe(false);
  });

  it("renders You're offline when the client itself is offline", () => {
    const view = deriveLocal(
      statusDto({ presenceLease: "fresh", clientCloud: "down" }),
      HEALTHY,
    );
    expect(view.tone).toBe("client-offline");
    expect(view.showLiveDot).toBe(false);
  });

  it("never shows a live dot without a live lease across every lease state", () => {
    const leaseStates: HostPresenceLeaseState[] = ["fresh", "stale", "expired"];
    for (const lease of leaseStates) {
      for (const health of [HEALTHY, DEGRADED]) {
        const view = deriveLocal(statusDto({ presenceLease: lease }), health);
        const live = lease === "fresh" || lease === "stale";
        expect(view.showLiveDot).toBe(live);
      }
    }
  });

  describe("remote-host relay sub-states (R4-B5)", () => {
    it("never applies the relay tunnel-down state to a local host, even with hostRelayAttached false", () => {
      const view = deriveLocal(
        statusDto({ presenceLease: "fresh", hostRelayAttached: false }),
        HEALTHY,
      );
      expect(view.tone).toBe("online");
    });

    it("renders tunnel-down for a remote host with a fresh lease but no relay attach", () => {
      const view = deriveHostPresence({
        status: statusDto({ presenceLease: "fresh", hostRelayAttached: false }),
        presenceHealth: HEALTHY,
        isViewerLocalHost: false,
        hasLiveSession: false,
        viewerCheck: null,
        nowMs: NOW,
      });
      expect(view.tone).toBe("tunnel-down");
      expect(view.label).toBe("Up, re-establishing its tunnel");
      expect(view.showLiveDot).toBe(false);
    });

    it("renders likely-reachable for an expired lease when the relay still reports attached", () => {
      const view = deriveHostPresence({
        status: statusDto({
          presenceLease: "expired",
          hostRelayAttached: true,
        }),
        presenceHealth: HEALTHY,
        isViewerLocalHost: false,
        hasLiveSession: false,
        viewerCheck: null,
        nowMs: NOW,
      });
      expect(view.tone).toBe("likely-reachable");
      expect(view.label).toBe("Not reporting — likely reachable");
    });

    it("renders a genuine Offline for an expired lease with no relay evidence", () => {
      const view = deriveHostPresence({
        status: statusDto({
          presenceLease: "expired",
          hostRelayAttached: false,
        }),
        presenceHealth: HEALTHY,
        isViewerLocalHost: false,
        hasLiveSession: false,
        viewerCheck: null,
        nowMs: NOW,
      });
      expect(view.tone).toBe("offline");
    });

    it("renders connection-issue with a timestamped provenance when the viewer's own check failed", () => {
      const check: ViewerReachabilityCheckLike = {
        result: "failing",
        checkedAtMs: NOW - 2 * 60_000,
      };
      const view = deriveHostPresence({
        status: statusDto({ presenceLease: "fresh", hostRelayAttached: true }),
        presenceHealth: HEALTHY,
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
        status: statusDto({ presenceLease: "fresh", hostRelayAttached: true }),
        presenceHealth: HEALTHY,
        isViewerLocalHost: false,
        hasLiveSession: false,
        viewerCheck: check,
        nowMs: NOW,
      });
      expect(view.tone).toBe("online");
    });
  });

  describe("live-session-evidence override (R4-B5)", () => {
    it("renders Online regardless of an expired lease, degraded health, or a failing viewer check", () => {
      const check: ViewerReachabilityCheckLike = {
        result: "failing",
        checkedAtMs: NOW,
      };
      const view = deriveHostPresence({
        status: statusDto({
          presenceLease: "expired",
          hostRelayAttached: false,
        }),
        presenceHealth: DEGRADED,
        isViewerLocalHost: false,
        hasLiveSession: true,
        viewerCheck: check,
        nowMs: NOW,
      });
      expect(view.tone).toBe("online");
      expect(view.label).toBe("Online");
      expect(view.showLiveDot).toBe(true);
    });

    it("still reports busy from the DTO under the live-session override", () => {
      const view = deriveHostPresence({
        status: statusDto({ presenceLease: "expired", busy: true }),
        presenceHealth: HEALTHY,
        isViewerLocalHost: false,
        hasLiveSession: true,
        viewerCheck: null,
        nowMs: NOW,
      });
      expect(view.busy).toBe(true);
    });

    it("does not override You're offline (the client itself has no path to claim anything)", () => {
      const view = deriveHostPresence({
        status: statusDto({ presenceLease: "fresh", clientCloud: "down" }),
        presenceHealth: HEALTHY,
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
    const status = statusDto({ presenceLease: "fresh", appVersion: "1.4.2" });
    const item = listItem(status, "Ubuntu");
    expect(formatHostMeta(item, deriveLocal(status, HEALTHY), now)).toBe(
      "Ubuntu · v1.4.2",
    );
  });

  it("prefers the last-seen hint for an offline host", () => {
    const status = statusDto({
      presenceLease: "expired",
      appVersion: "1.1.0",
      lastSeenAt: "2026-07-03T10:00:00.000Z",
    });
    const item = listItem(status, "Ubuntu");
    expect(formatHostMeta(item, deriveLocal(status, HEALTHY), now)).toBe(
      "last seen 2h ago",
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
        deriveUpdateAffordance(statusDto({ updateState })).showUpdateNowInput,
      ).toBe(true);
    }
    for (const updateState of hidden) {
      expect(
        deriveUpdateAffordance(statusDto({ updateState })).showUpdateNowInput,
      ).toBe(false);
    }
  });

  it("shows no drain-gate copy when not pending", () => {
    const view = deriveUpdateAffordance(
      statusDto({ updateState: "current", busySessionCount: 0 }),
    );
    expect(view.waitingForSessionsLabel).toBeNull();
    expect(view.showApplyNowForce).toBe(false);
    expect(view.applyNowLabel).toBeNull();
  });

  it("shows no drain-gate copy when pending but not yet waiting on sessions", () => {
    const view = deriveUpdateAffordance(
      statusDto({ updateState: "pending", busySessionCount: 0 }),
    );
    expect(view.waitingForSessionsLabel).toBeNull();
    expect(view.showApplyNowForce).toBe(false);
    expect(view.applyNowLabel).toBeNull();
  });

  it("shows singular copy for exactly one blocking session", () => {
    const view = deriveUpdateAffordance(
      statusDto({ updateState: "pending", busySessionCount: 1 }),
    );
    expect(view.waitingForSessionsLabel).toBe("Waiting for 1 session");
    expect(view.showApplyNowForce).toBe(true);
    expect(view.applyNowLabel).toBe("Apply now — ends 1 session");
  });

  it("shows plural copy and the drain-gate force for multiple blocking sessions", () => {
    const view = deriveUpdateAffordance(
      statusDto({ updateState: "pending", busySessionCount: 3 }),
    );
    expect(view.waitingForSessionsLabel).toBe("Waiting for 3 sessions");
    expect(view.showApplyNowForce).toBe(true);
    expect(view.applyNowLabel).toBe("Apply now — ends 3 sessions");
  });
});
