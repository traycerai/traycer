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
    transportDialability: "dialable",
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
    transportDialability: "dialable",
    publicKey: "pubkey-a",
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    ...overrides,
  };
}

/**
 * A remote entry whose relay verdict is the only thing that varies.
 *
 * `transportDialability` is derived exactly as the mapper derives it, so these
 * fixtures are the shapes production actually produces rather than shapes that
 * merely satisfy the type.
 */
function remoteWithConnectivity(
  connectivity: "connectable" | "unknown" | "offline" | "local-only",
): RemoteHostDirectoryEntry {
  return remoteEntry({
    transportDialability:
      connectivity === "connectable" ? "dialable" : "not-dialable",
    remoteStatus: {
      connectivity,
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
  });
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
    expect(
      dialableHostEndpoint(entry({ transportDialability: "not-dialable" })),
    ).toBeNull();
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

/**
 * The gate both halves of the transport share: WHICH not-dialable reasons
 * actually refuse a dial.
 *
 * This is the layer the round-2 repair got wrong. Refusing everything the
 * directory did not call `available` folded in `indeterminate` — a failed
 * liveness read on the cloud side — and the null key made the session
 * registries release a live handle, so one degraded Redis read replaced an
 * active chat with a tile that loads forever.
 */
describe("the transport's refusal gate", () => {
  it("dials a host whose liveness read came back blind (`unknown` ⇒ indeterminate)", () => {
    const blind = remoteWithConnectivity("unknown");
    expect(hostTransportKey(blind)).not.toBeNull();
    expect(dialableHostEndpoint(blind)).not.toBeNull();
  });

  it("refuses a confirmed-offline host", () => {
    const dead = remoteWithConnectivity("offline");
    expect(hostTransportKey(dead)).toBeNull();
    expect(dialableHostEndpoint(dead)).toBeNull();
  });

  it("refuses a plan-restricted host — there is no relay attach to dial", () => {
    // Correct to refuse, and NOT the same as offline: the machine is running.
    // Saying so is `useHostReachability`'s reason field, not this layer's job.
    const localOnly = remoteWithConnectivity("local-only");
    expect(hostTransportKey(localOnly)).toBeNull();
    expect(dialableHostEndpoint(localOnly)).toBeNull();
  });

  it("keeps the key UNCHANGED across a dialable → indeterminate flip", () => {
    // The anti-churn property, and the one without which the P0 survives the
    // rest of this suite: every caller memoizes its client on this key, so a
    // key that merely CHANGES tears the socket down just as surely as a key
    // that goes null. The verdict is a gate, not an identity — the host's
    // address did not move.
    const before = hostTransportKey(remoteWithConnectivity("connectable"));
    const after = hostTransportKey(remoteWithConnectivity("unknown"));
    expect(before).not.toBeNull();
    expect(after).toBe(before);
  });

  it("keeps the endpoint unchanged across the same flip", () => {
    expect(dialableHostEndpoint(remoteWithConnectivity("unknown"))).toEqual(
      dialableHostEndpoint(remoteWithConnectivity("connectable")),
    );
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
