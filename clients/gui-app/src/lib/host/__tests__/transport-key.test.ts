import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  hostTransportKey,
  dialableHostEndpoint,
  remoteAwareOwnerIdentityKey,
} from "@/lib/host/transport-key";

function entry(overrides: Partial<HostDirectoryEntry>): HostDirectoryEntry {
  return {
    hostId: "host-a",
    label: "Host A",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:9/stream",
    version: "1.2.3",
    status: "available",
    ...overrides,
  };
}

function remoteEntry(
  overrides: Partial<RemoteHostDirectoryEntry>,
): RemoteHostDirectoryEntry {
  return {
    hostId: "host-a",
    label: "Host A",
    kind: "remote",
    websocketUrl: "wss://relay.test/attach",
    version: "1.2.3",
    status: "available",
    publicKey: "pubkey-a",
    remoteStatus: {
      presenceLease: "fresh",
      hostRelayAttached: true,
      viewerReachability: "ok",
      clientCloud: "ok",
      busy: false,
      busySessionCount: 0,
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    ...overrides,
  };
}

describe("dialableHostEndpoint", () => {
  it("returns the endpoint for an available, dialable entry", () => {
    expect(dialableHostEndpoint(entry({}))).toEqual({
      hostId: "host-a",
      websocketUrl: "ws://127.0.0.1:9/stream",
    });
  });

  it("returns null when not dialable or not available", () => {
    expect(dialableHostEndpoint(null)).toBeNull();
    expect(dialableHostEndpoint(entry({ websocketUrl: null }))).toBeNull();
    expect(dialableHostEndpoint(entry({ status: "unavailable" }))).toBeNull();
  });

  it("agrees with hostTransportKey on dialability", () => {
    // A non-null transport key must imply a dialable endpoint (the durable
    // streams gate on the key but dial the endpoint), and vice-versa.
    const dialable = entry({});
    const undialable = entry({ websocketUrl: null });
    expect(hostTransportKey(dialable)).not.toBeNull();
    expect(dialableHostEndpoint(dialable)).not.toBeNull();
    expect(hostTransportKey(undialable)).toBeNull();
    expect(dialableHostEndpoint(undialable)).toBeNull();
  });
});

describe("remoteAwareOwnerIdentityKey", () => {
  it("returns null without a target or a signed-in user", () => {
    expect(remoteAwareOwnerIdentityKey(null, "user-1")).toBeNull();
    expect(remoteAwareOwnerIdentityKey(entry({}), null)).toBeNull();
  });

  it("(the R-1 discriminator) treats a remote host's public-key rotation as a distinct identity, isolated from every other field", () => {
    // hostId / websocketUrl / version / status all held stable - the case
    // `hostTransportKey` cannot distinguish, since every remote host shares
    // one fixed relay attach URL.
    const keyA = remoteAwareOwnerIdentityKey(
      remoteEntry({ publicKey: "pubkey-a" }),
      "user-1",
    );
    const keyB = remoteAwareOwnerIdentityKey(
      remoteEntry({ publicKey: "pubkey-b" }),
      "user-1",
    );
    expect(keyA).not.toBeNull();
    expect(keyB).not.toBeNull();
    expect(keyA).not.toBe(keyB);

    // `hostTransportKey` is blind to the same rotation - the exact gap R-1
    // closes at the owner-identity layer.
    expect(hostTransportKey(remoteEntry({ publicKey: "pubkey-a" }))).toBe(
      hostTransportKey(remoteEntry({ publicKey: "pubkey-b" })),
    );
  });

  it("is mode-aware: a local host's identity ignores a websocket URL move (self-healed live by the owned transport, not by owner rebuild)", () => {
    const before = remoteAwareOwnerIdentityKey(
      entry({ websocketUrl: "ws://127.0.0.1:9/stream" }),
      "user-1",
    );
    const after = remoteAwareOwnerIdentityKey(
      entry({ websocketUrl: "ws://127.0.0.1:60001/stream" }),
      "user-1",
    );
    expect(before).not.toBeNull();
    expect(before).toBe(after);
  });

  it("differs across users and hosts", () => {
    const target = remoteEntry({});
    expect(remoteAwareOwnerIdentityKey(target, "user-1")).not.toBe(
      remoteAwareOwnerIdentityKey(target, "user-2"),
    );
    expect(remoteAwareOwnerIdentityKey(target, "user-1")).not.toBe(
      remoteAwareOwnerIdentityKey(remoteEntry({ hostId: "host-b" }), "user-1"),
    );
  });
});
