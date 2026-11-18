import { describe, expect, it } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { LOCAL_OWNER_JAR_CASES } from "@traycer-clients/shared/test-fixtures/local-owner-jar-cases";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { jarBridgeForHost } from "../use-browser-sessions";

function remoteEntry(
  kind: "personal" | "sandbox" | "team",
): HostDirectoryEntry {
  const item: HostListItem = {
    hostId: "host-r",
    displayName: "Remote",
    platform: "linux",
    kind: kind === "sandbox" ? "sandbox" : "personal",
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
    ...(kind === "team"
      ? { owner: { kind: "team", id: "team-a", name: "Alpha" } }
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

  it.each(LOCAL_OWNER_JAR_CASES)(
    "uses the local owner's jar lane when $name",
    ({ owner, omitOwner, previousOwner, admitted }) => {
      const entryFor = (currentOwner: typeof owner): HostDirectoryEntry =>
        omitOwner ? LOCAL : { ...LOCAL, owner: currentOwner };

      if (previousOwner !== undefined) {
        expect(
          jarBridgeForHost(bridge, { ...LOCAL, owner: previousOwner }),
        ).toBe(bridge);
      }

      expect(jarBridgeForHost(bridge, entryFor(owner))).toBe(
        admitted ? bridge : null,
      );
    },
  );

  it("withholds the jar bridge from a sandbox host", () => {
    expect(jarBridgeForHost(bridge, remoteEntry("sandbox"))).toBeNull();
  });

  it("hands the bridge on for a personal remote host", () => {
    expect(jarBridgeForHost(bridge, remoteEntry("personal"))).toBe(bridge);
  });

  it("withholds the jar bridge from a remote team host", () => {
    expect(remoteEntry("team")).toMatchObject({ sandbox: null });
    expect(jarBridgeForHost(bridge, remoteEntry("team"))).toBeNull();
  });

  it("keeps the bridge available when the directory has no entry", () => {
    expect(jarBridgeForHost(bridge, null)).toBe(bridge);
  });

  it("stays null when there is no bridge at all", () => {
    expect(jarBridgeForHost(null, remoteEntry("personal"))).toBeNull();
    expect(jarBridgeForHost(null, null)).toBeNull();
  });
});
