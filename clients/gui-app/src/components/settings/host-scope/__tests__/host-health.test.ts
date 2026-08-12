import { describe, expect, it } from "vitest";
import type {
  HostConnectivity,
  HostListItem,
} from "@traycer/protocol/host/host-status";
import { deriveHostHealth } from "@/components/settings/host-scope/host-health";

/**
 * `stopped` and `not-installed` are the only two health states a person can
 * ACT on — Start, or Install — and for a long time nothing could produce
 * them: `useHostScope` passed `undefined` for the installed record, so
 * `deriveStatus` could only answer `running` or nothing, and a stopped local
 * host fell through to its registry connectivity and read "Offline · last
 * seen 3h ago". True about the cloud's answer, useless to someone whose host
 * is sitting right there with a Start button one click away.
 *
 * Nothing covered `deriveHostHealth` at all, which is how that shipped.
 */

const NOW_MS = 3 * 60 * 60 * 1000;

function registryItem(connectivity: HostConnectivity): HostListItem {
  return {
    hostId: "host-a",
    displayName: "host-a",
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: new Date(0).toISOString(),
    updatePolicy: "manual",
    status: {
      connectivity,
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: new Date(0).toISOString(),
    },
  };
}

const BASE = {
  item: registryItem("offline"),
  hasLiveSession: false,
  viewerCheck: null,
  nowMs: NOW_MS,
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
    // The distinction that matters: an offline registry row would have said
    // "Offline" and left the reader with nothing to do about it.
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

  it("lets the local service snapshot outrank a registry saying offline", () => {
    // Firsthand read of the process on this box beats the cloud's connectivity
    // read, even when the cloud thinks the host is offline.
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

  it("never claims a local-only-machine state for a remote host", () => {
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

describe("deriveHostHealth — connectivity mapping for a remote row", () => {
  it("maps connectable to Online, live", () => {
    const health = deriveHostHealth({
      ...BASE,
      item: registryItem("connectable"),
      isLocalMachine: false,
      service: undefined,
    });

    expect(health.state).toBe("online");
    expect(health.label).toBe("Online");
    expect(health.live).toBe(true);
  });

  it("maps local-only to its own state, labelled Local only, and never Offline", () => {
    const health = deriveHostHealth({
      ...BASE,
      item: registryItem("local-only"),
      isLocalMachine: false,
      service: undefined,
    });

    expect(health.state).toBe("local-only");
    expect(health.label).toBe("Local only");
    expect(health.label).not.toBe("Offline");
    expect(health.live).toBe(false);
    // Not a fault: idle tone, not warn.
    expect(health.tone).toBe("idle");
  });

  it("maps unknown to Status unknown, and never Offline", () => {
    const health = deriveHostHealth({
      ...BASE,
      item: registryItem("unknown"),
      isLocalMachine: false,
      service: undefined,
    });

    expect(health.state).toBe("unknown");
    expect(health.label).toBe("Status unknown");
    expect(health.label).not.toBe("Offline");
  });

  it("maps offline to Offline, with last-seen in the detail", () => {
    const health = deriveHostHealth({
      ...BASE,
      item: registryItem("offline"),
      isLocalMachine: false,
      service: undefined,
    });

    expect(health.state).toBe("offline");
    expect(health.label).toBe("Offline");
    expect(health.live).toBe(false);
  });

  it("lets live-session evidence outrank a connectivity of offline", () => {
    const health = deriveHostHealth({
      ...BASE,
      item: registryItem("offline"),
      isLocalMachine: false,
      hasLiveSession: true,
      service: undefined,
    });

    expect(health.state).toBe("online");
    expect(health.live).toBe(true);
  });
});
