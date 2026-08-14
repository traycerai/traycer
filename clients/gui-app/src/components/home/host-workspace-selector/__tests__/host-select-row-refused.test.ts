import { describe, expect, it } from "vitest";
import {
  hostListItemToDirectoryEntry,
  RELAY_FUSE_MAX_ATTACH_MS,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  HostConnectivity,
  HostListItem,
} from "@traycer/protocol/host/host-status";
import { hostSelectRowRefused } from "../host-select-row-refused";

const HOST_ID = "remote-host-1";
const RELAY_URL = "wss://relay.example/attach";

// Real mapped entries, not hand-built fixtures: a registry-`offline` remote
// host carries the shared relay `websocketUrl`, and whether it may be dialed
// is decided by the refusal predicate - a hand-built `websocketUrl: null`
// fixture is exactly the shape that let the picker's second gate go untested.
function mappedEntry(connectivity: HostConnectivity, lastSeenAt: string) {
  const item: HostListItem = {
    hostId: HOST_ID,
    displayName: HOST_ID,
    platform: "Ubuntu",
    kind: "personal",
    publicKey: "pubkey-a",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatePolicy: "manual",
    status: {
      connectivity,
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.0.0",
      lastSeenAt,
    },
  };
  return hostListItemToDirectoryEntry(item, RELAY_URL);
}

function recentLastSeen(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

function staleLastSeen(): string {
  return new Date(Date.now() - RELAY_FUSE_MAX_ATTACH_MS - 60_000).toISOString();
}

describe("hostSelectRowRefused", () => {
  it("keeps an offline host inside the relay-fuse window selectable (the recovery dial the transport would attempt)", () => {
    expect(
      hostSelectRowRefused(
        mappedEntry("offline", recentLastSeen()),
        false,
        false,
      ),
    ).toBe(false);
  });

  it("keeps a cloud-offline host with a READY live session in this client selectable", () => {
    expect(
      hostSelectRowRefused(
        mappedEntry("offline", staleLastSeen()),
        false,
        true,
      ),
    ).toBe(false);
  });

  it("still refuses a genuinely offline host - past the fuse window, no session", () => {
    expect(
      hostSelectRowRefused(
        mappedEntry("offline", staleLastSeen()),
        false,
        false,
      ),
    ).toBe(true);
  });

  it("refuses a plan-restricted (local-only) host", () => {
    expect(
      hostSelectRowRefused(
        mappedEntry("local-only", recentLastSeen()),
        false,
        false,
      ),
    ).toBe(true);
  });

  it("keeps an indeterminate (unknown liveness) host selectable - a failed read is not a fact about the host", () => {
    expect(
      hostSelectRowRefused(
        mappedEntry("unknown", recentLastSeen()),
        false,
        false,
      ),
    ).toBe(false);
  });

  it("keeps a connectable host selectable", () => {
    expect(
      hostSelectRowRefused(
        mappedEntry("connectable", recentLastSeen()),
        false,
        false,
      ),
    ).toBe(false);
  });

  it("refuses a remote row under the account-level plan gate when this client holds no live session, even a connectable one", () => {
    expect(
      hostSelectRowRefused(
        mappedEntry("connectable", recentLastSeen()),
        true,
        false,
      ),
    ).toBe(true);
  });

  it("keeps a plan-restricted row selectable while a READY session survives - the same override the Settings route applies", () => {
    expect(
      hostSelectRowRefused(
        mappedEntry("connectable", recentLastSeen()),
        true,
        true,
      ),
    ).toBe(false);
  });
});
