import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";

// `hostTransportKey`/`dialableHostEndpoint` ask this for live-session
// evidence. Stubbed at the module boundary - the single rule under test is
// "a ready live session keeps the transport alive under ANY verdict", and
// only a real module swap can prove the gate actually consults it, rather
// than merely having a `hostId` that happens to answer false.
const readySessionHosts = vi.hoisted(() => ({ value: new Set<string>() }));
vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      hasReadyRemoteSession: (hostId: string) =>
        readySessionHosts.value.has(hostId),
    };
  },
);

import {
  hostTransportKey,
  dialableHostEndpoint,
  remoteAwareOwnerIdentityKey,
} from "@/lib/host/transport-key";

/**
 * The account axis the wire no longer carries: `hostListItemToDirectoryEntry`
 * stamps it onto every entry at projection time. These fixtures describe an
 * entitled account unless a case says otherwise.
 */
const PLAN_ALLOWS_REMOTE = true;

afterEach(() => {
  readySessionHosts.value = new Set();
});

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
    relayFuseGrace: false,
    recentHostCheckIn: false,
    planAllowsRemote: true,
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
  connectivity: "connectable" | "unknown" | "offline",
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

/**
 * The same fixture for an account whose plan has no remote hosts.
 *
 * The wire says nothing about the plan any more — it carries pure liveness —
 * so the account fact is stamped on the entry at projection time and the mapper
 * derives dialability from BOTH. Nothing is dialable on this plan, whatever the
 * host is doing.
 */
function planGatedRemote(
  connectivity: "connectable" | "unknown" | "offline",
): RemoteHostDirectoryEntry {
  return remoteEntry({
    transportDialability: "not-dialable",
    planAllowsRemote: false,
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

  it("refuses a plan-restricted host — the attach grant would 403 the dial", () => {
    // Correct to refuse, and NOT the same as offline: the machine is running
    // (`connectable` on the wire). Saying so is `useHostReachability`'s reason
    // field, not this layer's job.
    const planGated = planGatedRemote("connectable");
    expect(hostTransportKey(planGated)).toBeNull();
    expect(dialableHostEndpoint(planGated)).toBeNull();
  });

  it("refuses a plan-restricted host whose liveness read came back blind, unlike the paid one", () => {
    // The one asymmetry the split introduces at this layer: `unknown` is dialed
    // for an entitled account (a blind read is not a refusal) and refused for a
    // gated one (the refusal is deterministic — the grant 403s whatever the
    // read would have said).
    const gatedBlind = planGatedRemote("unknown");
    expect(hostTransportKey(gatedBlind)).toBeNull();
    expect(dialableHostEndpoint(gatedBlind)).toBeNull();
    expect(hostTransportKey(remoteWithConnectivity("unknown"))).not.toBeNull();
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

  it("a ready live session outranks a confirmed-offline verdict — key and endpoint stay non-null", () => {
    const dead = remoteWithConnectivity("offline");
    readySessionHosts.value = new Set([dead.hostId]);
    expect(hostTransportKey(dead)).not.toBeNull();
    expect(dialableHostEndpoint(dead)).not.toBeNull();
  });

  it("a ready live session outranks plan-restricted too — same rule, deliberately no exception for the downgrade", () => {
    const planGated = planGatedRemote("connectable");
    readySessionHosts.value = new Set([planGated.hostId]);
    expect(hostTransportKey(planGated)).not.toBeNull();
    expect(dialableHostEndpoint(planGated)).not.toBeNull();
  });

  it("without a ready session, both confirmed verdicts still refuse — key and endpoint stay null", () => {
    const dead = remoteWithConnectivity("offline");
    const planGated = planGatedRemote("connectable");
    expect(hostTransportKey(dead)).toBeNull();
    expect(dialableHostEndpoint(dead)).toBeNull();
    expect(hostTransportKey(planGated)).toBeNull();
    expect(dialableHostEndpoint(planGated)).toBeNull();
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

// F7 fuse-vs-lease reconciliation: a recovery dial must still be ATTEMPTED for
// an `offline` entry the relay's host-leg fuse is still plausibly holding
// (recent `lastSeenAt`), and refused only once the fuse cap has passed.
// Built through the real `hostListItemToDirectoryEntry` constructor rather
// than a synthetic literal, matching the "real mapped connectivity" style
// elsewhere in this suite (see `host-directory-service.test.ts`).
function offlineHostListItem(lastSeenAt: string): HostListItem {
  return {
    hostId: "fuse-host",
    displayName: "Fuse Host",
    platform: "Ubuntu",
    kind: "personal",
    publicKey: "pk-fuse-host",
    createdAt: "2026-07-01T12:00:00.000Z",
    status: {
      connectivity: "offline",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt,
    },
    updatePolicy: "manual",
  };
}

describe("F7 relay fuse grace - recovery dial on a lease-lapse offline entry", () => {
  it("attempts the dial (non-null key and endpoint) for an offline entry still within the relay fuse grace", () => {
    const recentLastSeen = new Date(Date.now() - 60_000).toISOString();
    const fuseGraceEntry = hostListItemToDirectoryEntry(
      offlineHostListItem(recentLastSeen),
      "wss://relay.example.test/attach",
      PLAN_ALLOWS_REMOTE,
    );
    expect(hostTransportKey(fuseGraceEntry)).not.toBeNull();
    expect(dialableHostEndpoint(fuseGraceEntry)).not.toBeNull();
  });

  it("refuses the dial (null key and endpoint) for a genuinely offline entry past the fuse cap", () => {
    const oldLastSeen = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const genuineOfflineEntry = hostListItemToDirectoryEntry(
      offlineHostListItem(oldLastSeen),
      "wss://relay.example.test/attach",
      PLAN_ALLOWS_REMOTE,
    );
    expect(hostTransportKey(genuineOfflineEntry)).toBeNull();
    expect(dialableHostEndpoint(genuineOfflineEntry)).toBeNull();
  });
});
