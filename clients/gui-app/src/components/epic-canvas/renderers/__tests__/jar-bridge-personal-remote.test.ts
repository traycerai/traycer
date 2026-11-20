import { expect, it } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { isPersonalRemoteHost } from "@traycer-clients/shared/host-client/personal-remote-host";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { jarBridgeForHost } from "../use-browser-sessions";

it("keeps the desktop cookie-jar bridge on a person's own remote computer", () => {
  const item: HostListItem = {
    hostId: "personal-computer",
    displayName: "Personal computer",
    platform: "linux",
    kind: "personal",
    publicKey: "public-key",
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
  };
  const host = hostListItemToDirectoryEntry(item, "wss://relay.test/attach");
  const bridge = new FakeBrowserViewBridge({});

  expect(isPersonalRemoteHost(host)).toBe(true);
  expect(jarBridgeForHost(bridge, host)).toBe(bridge);
});
