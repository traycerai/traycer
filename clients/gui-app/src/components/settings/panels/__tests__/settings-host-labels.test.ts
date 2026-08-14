/**
 * Composition coverage: `settingsHostOptionLabel` fed REAL entries from
 * `hostListItemToDirectoryEntry` — not synthetic `HostDirectoryEntry`
 * literals asserting the coarse bit directly. The mapper collapses every
 * non-connectable `connectivity` into `transportDialability: "not-dialable"`;
 * this pins that the label's per-reason branching (`hostUnavailability`)
 * actually survives that collapse for each connectivity value the mapper
 * produces.
 */
import { describe, expect, it } from "vitest";
import type {
  HostConnectivity,
  HostListItem,
} from "@traycer/protocol/host/host-status";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { settingsHostOptionLabel } from "@/components/settings/panels/settings-host-labels";

const RELAY_BASE_URL = "wss://relay.example.test/attach";

function listItem(connectivity: HostConnectivity): HostListItem {
  return {
    hostId: "host-1",
    displayName: "prod-devbox",
    platform: "Ubuntu",
    kind: "personal",
    publicKey: "pk-1",
    createdAt: "2026-07-01T12:00:00.000Z",
    status: {
      connectivity,
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: "2026-07-03T11:59:50.000Z",
    },
    updatePolicy: "manual",
  };
}

describe("settingsHostOptionLabel — composed against real hostListItemToDirectoryEntry output", () => {
  it("adds no suffix for a degraded ('unknown') liveness read", () => {
    const entry = hostListItemToDirectoryEntry(
      listItem("unknown"),
      RELAY_BASE_URL,
    );
    // Sanity: this is exactly the collapsed shape the mapper produces —
    // the coarse bit the six consumers used to read directly, which is why it
    // is now named for what it answers rather than for what it looked like.
    expect(entry.transportDialability).toBe("not-dialable");
    expect(settingsHostOptionLabel(entry)).toBe("prod-devbox");
  });

  it("labels a local-only (free-tier) host '(local only)', never '(offline)'", () => {
    const entry = hostListItemToDirectoryEntry(
      listItem("local-only"),
      RELAY_BASE_URL,
    );
    expect(entry.transportDialability).toBe("not-dialable");
    expect(settingsHostOptionLabel(entry)).toBe("prod-devbox (local only)");
  });

  it("labels a genuinely offline host '(offline)'", () => {
    const entry = hostListItemToDirectoryEntry(
      listItem("offline"),
      RELAY_BASE_URL,
    );
    expect(entry.transportDialability).toBe("not-dialable");
    expect(settingsHostOptionLabel(entry)).toBe("prod-devbox (offline)");
  });

  it("adds no suffix for a connectable host", () => {
    const entry = hostListItemToDirectoryEntry(
      listItem("connectable"),
      RELAY_BASE_URL,
    );
    expect(entry.transportDialability).toBe("dialable");
    expect(settingsHostOptionLabel(entry)).toBe("prod-devbox");
  });
});
