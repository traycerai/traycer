import { describe, expect, it } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { jarBridgeForHost } from "../use-browser-sessions";

/**
 * The desktop bridge routes a host's `browser.sessions` stream through main,
 * which carries the desktop's whole cookie jar on it. A sandbox must never
 * receive that, so its stream takes the jar-free path (`null` bridge).
 */

function remoteEntry(kind: "personal" | "sandbox"): HostDirectoryEntry {
  const item: HostListItem = {
    hostId: "host-r",
    displayName: "Remote",
    platform: "linux",
    kind,
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: null,
    },
    ...(kind === "sandbox"
      ? { sandboxState: "awake", sandboxFrozen: false, profile: "agent" }
      : {}),
  };
  return hostListItemToDirectoryEntry(item, "wss://relay.example.test");
}

const LOCAL: HostDirectoryEntry = {
  hostId: "host-local",
  label: "This machine",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:9/stream",
  version: "1.5.0",
  transportDialability: "dialable",
};

describe("jarBridgeForHost", () => {
  const bridge = new FakeBrowserViewBridge({});

  it("withholds the jar bridge from a sandbox host", () => {
    expect(jarBridgeForHost(bridge, remoteEntry("sandbox"))).toBeNull();
  });

  it("hands the bridge on for a personal remote host, this machine's host, and a host the directory has not answered for", () => {
    expect(jarBridgeForHost(bridge, remoteEntry("personal"))).toBe(bridge);
    expect(jarBridgeForHost(bridge, LOCAL)).toBe(bridge);
    expect(jarBridgeForHost(bridge, null)).toBe(bridge);
  });

  it("stays null when there is no bridge at all", () => {
    expect(jarBridgeForHost(null, remoteEntry("personal"))).toBeNull();
    expect(jarBridgeForHost(null, null)).toBeNull();
  });
});
