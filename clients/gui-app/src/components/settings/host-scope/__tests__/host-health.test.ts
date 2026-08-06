import { describe, expect, it } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { deriveHostHealth } from "@/components/settings/host-scope/host-health";

/**
 * `stopped` and `not-installed` are the only two health states a person can
 * ACT on — Start, or Install — and for a long time nothing could produce
 * them: `useHostScope` passed `undefined` for the installed record, so
 * `deriveStatus` could only answer `running` or nothing, and a stopped local
 * host fell through to its registry lease and read "Offline · last seen 3h
 * ago". True about the lease, useless to someone whose host is sitting right
 * there with a Start button one click away.
 *
 * Nothing covered `deriveHostHealth` at all, which is how that shipped.
 */

const STALE_LEASE_MS = 3 * 60 * 60 * 1000;

function registryItem(overrides: Partial<HostListItem>): HostListItem {
  return {
    hostId: "host-a",
    displayName: "host-a",
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: new Date(0).toISOString(),
    updatePolicy: "manual",
    status: {
      // A long-expired lease: the registry's answer for this host is "Offline,
      // last seen 3h ago", which is what the local snapshot must outrank.
      presenceLease: "expired",
      hostRelayAttached: false,
      viewerReachability: "unknown",
      clientCloud: "ok",
      busy: false,
      busySessionCount: 0,
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: new Date(0).toISOString(),
    },
    ...overrides,
  };
}

const BASE = {
  item: registryItem({}),
  presenceHealth: { status: "healthy", reason: null } as const,
  hasLiveSession: false,
  viewerCheck: null,
  nowMs: STALE_LEASE_MS,
};

describe("deriveHostHealth — the two actionable local states", () => {
  it("says Stopped, not Offline, for an installed local host that is not running", () => {
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      service: {
        state: "stopped",
        version: "1.4.2",
        listenUrl: null,
        pid: null,
      },
    });

    expect(health.state).toBe("stopped");
    expect(health.label).toBe("Stopped");
    // The distinction that matters: an expired lease would have said "Offline"
    // and left the reader with nothing to do about it.
    expect(health.label).not.toBe("Offline");
    expect(health.live).toBe(false);
  });

  it("says Not installed when the local machine has no host at all", () => {
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      service: {
        state: "not-installed",
        version: null,
        listenUrl: null,
        pid: null,
      },
    });

    expect(health.state).toBe("not-installed");
    expect(health.label).toBe("Not installed");
  });

  it("lets the local service snapshot outrank a stale registry lease", () => {
    // Firsthand read of the process on this box beats hearsay about a
    // heartbeat that reached the cloud three hours ago.
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      service: {
        state: "running",
        version: "1.4.2",
        listenUrl: "ws://127.0.0.1:1/rpc",
        pid: 1,
      },
    });

    expect(health.state).toBe("online");
    expect(health.live).toBe(true);
  });

  it("falls back to the registry while the local snapshot is unresolved", () => {
    // `undefined` means "not answered yet", which must not be read as
    // "not installed" — the registry answer is still better than a guess.
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      service: undefined,
    });

    expect(health.state).not.toBe("not-installed");
    expect(health.state).not.toBe("stopped");
  });

  it("never claims a local-only state for a remote host", () => {
    // `stopped` / `not-installed` describe a service on THIS computer. A
    // remote host has none to inspect, so the snapshot must be ignored.
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: false,
      service: {
        state: "stopped",
        version: "1.4.2",
        listenUrl: null,
        pid: null,
      },
    });

    expect(health.state).not.toBe("stopped");
    expect(health.state).not.toBe("not-installed");
  });
});
