import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostListItem,
  HostListResponse,
  HostStatusDTO,
} from "@traycer/protocol/host/host-status";
import type { AuthEra } from "../../auth/request-context-provider";
import {
  createRemoteHostFetcher,
  fetchRegisteredHostsViaHttp,
  hostListItemToDirectoryEntry,
  hostUnavailability,
  isConfirmedHostDeath,
  isConfirmedTransportRefusal,
  isWithinRelayFuseGrace,
  RELAY_FUSE_MAX_ATTACH_MS,
  RELAY_FUSE_MAX_CLOCK_SKEW_MS,
  type HostListFetchResult,
} from "../remote-fetcher";

const AUTHN = "https://authn.example.test";

/**
 * The era an ambient caller passes. This fetcher holds no era of its own to
 * compare against (see `createRemoteHostFetcher` — the desktop composition
 * checks the era inside `AuthService`, where the bearer lives), so the value
 * only has to be well-formed.
 */
const AMBIENT_ERA: AuthEra = { identity: "user-1", credentialGeneration: 1 };

function onlineItem(): HostListItem {
  return {
    hostId: "host-1",
    displayName: "prod-devbox",
    platform: "Ubuntu",
    kind: "personal",
    publicKey: "pk-1",
    createdAt: "2026-07-01T12:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: "2026-07-03T11:59:50.000Z",
    },
    updatePolicy: "manual",
  };
}

function envelope(): HostListResponse {
  return {
    hosts: [onlineItem()],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRegisteredHostsViaHttp", () => {
  it("GETs /api/v3/hosts with the user bearer and returns the parsed envelope", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, envelope()),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRegisteredHostsViaHttp(AUTHN, "jwt-abc");

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.response.hosts).toHaveLength(1);
      expect(result.response.hosts[0].hostId).toBe("host-1");
    }
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://authn.example.test/api/v3/hosts");
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-abc",
    );
  });

  it("maps 401 to unauthorized (never destructive)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(401, {})),
    );
    expect((await fetchRegisteredHostsViaHttp(AUTHN, "x")).kind).toBe(
      "unauthorized",
    );
  });

  it("maps a 5xx to network-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(503, {})),
    );
    expect((await fetchRegisteredHostsViaHttp(AUTHN, "x")).kind).toBe(
      "network-error",
    );
  });

  it("maps a thrown fetch (transport/timeout) to network-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("boom");
      }),
    );
    expect((await fetchRegisteredHostsViaHttp(AUTHN, "x")).kind).toBe(
      "network-error",
    );
  });

  it("fails closed on a contract-violating 2xx body", async () => {
    // `connectivity` is not a valid enum member — the mirror's schema rejects.
    const bad = {
      hosts: [
        {
          ...onlineItem(),
          status: { ...onlineItem().status, connectivity: "nope" },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(200, bad)),
    );
    expect((await fetchRegisteredHostsViaHttp(AUTHN, "x")).kind).toBe(
      "network-error",
    );
  });
});

const RELAY_BASE_URL = "wss://relay.example.test/attach";

describe("hostListItemToDirectoryEntry", () => {
  it("enriches a remote entry with the status DTO, connectable via the shared relay endpoint (S2/T14)", () => {
    const entry = hostListItemToDirectoryEntry(onlineItem(), RELAY_BASE_URL);
    expect(entry.kind).toBe("remote");
    expect(entry.websocketUrl).toBe(RELAY_BASE_URL);
    expect(entry.transportDialability).toBe("dialable");
    expect(entry.version).toBe("1.4.2");
    expect(entry.label).toBe("prod-devbox");
    expect(entry.remoteStatus.connectivity).toBe("connectable");
  });

  it("reads not-dialable when the host is not connectable", () => {
    const item: HostListItem = {
      ...onlineItem(),
      status: { ...onlineItem().status, connectivity: "offline" },
    };
    const entry = hostListItemToDirectoryEntry(item, RELAY_BASE_URL);
    expect(entry.transportDialability).toBe("not-dialable");
    // `websocketUrl` is the relay's fixed attach endpoint, carried through
    // regardless of dialability — production rejects this entry as
    // unconnectable via `hostUnavailability`, not via the URL.
    expect(entry.websocketUrl).toBe(RELAY_BASE_URL);
  });

  it("reads not-dialable for local-only and unknown connectivity alike", () => {
    for (const connectivity of ["local-only", "unknown"] as const) {
      const item: HostListItem = {
        ...onlineItem(),
        status: { ...onlineItem().status, connectivity },
      };
      expect(
        hostListItemToDirectoryEntry(item, RELAY_BASE_URL).transportDialability,
      ).toBe("not-dialable");
    }
  });

  it("falls back to the hostId when the host has no display name", () => {
    const item: HostListItem = { ...onlineItem(), displayName: null };
    expect(hostListItemToDirectoryEntry(item, RELAY_BASE_URL).label).toBe(
      "host-1",
    );
  });
});

describe("createRemoteHostFetcher", () => {
  it("returns signed-out when there is no bearer", async () => {
    const fetcher = createRemoteHostFetcher({
      listHosts: async () => ({ kind: "ok", response: envelope() }),
      getBearerToken: () => null,
      relayBaseUrl: RELAY_BASE_URL,
    });
    expect(await fetcher(AMBIENT_ERA)).toEqual({ kind: "signed-out" });
  });

  it("maps the envelope to directory entries when ok", async () => {
    const fetcher = createRemoteHostFetcher({
      listHosts: async () => ({ kind: "ok", response: envelope() }),
      getBearerToken: () => "jwt",
      relayBaseUrl: RELAY_BASE_URL,
    });
    const outcome = await fetcher(AMBIENT_ERA);
    expect(outcome.kind).toBe("hosts");
    if (outcome.kind === "hosts") {
      expect(outcome.entries).toHaveLength(1);
      expect(outcome.entries[0].kind).toBe("remote");
      expect(outcome.entries[0].websocketUrl).toBe(RELAY_BASE_URL);
    }
  });

  it("maps a rejected bearer (unauthorized) to signed-out (never a forced sign-out from a poll)", async () => {
    const fetcher = createRemoteHostFetcher({
      listHosts: async () => ({ kind: "unauthorized" }),
      getBearerToken: () => "jwt",
      relayBaseUrl: RELAY_BASE_URL,
    });
    expect(await fetcher(AMBIENT_ERA)).toEqual({ kind: "signed-out" });
  });

  it("maps a network-error to failed so a transient blip is distinguishable from signed-out", async () => {
    const result: HostListFetchResult = { kind: "network-error" };
    const fetcher = createRemoteHostFetcher({
      listHosts: async () => result,
      getBearerToken: () => "jwt",
      relayBaseUrl: RELAY_BASE_URL,
    });
    expect(await fetcher(AMBIENT_ERA)).toEqual({ kind: "failed" });
  });

  it("maps a REJECTED listHosts call to failed - the injected IPC seam is not throw-free, and a throw must not escape the fetcher contract", async () => {
    const fetcher = createRemoteHostFetcher({
      listHosts: () => Promise.reject(new Error("ipc bridge torn down")),
      getBearerToken: () => "jwt",
      relayBaseUrl: RELAY_BASE_URL,
    });
    expect(await fetcher(AMBIENT_ERA)).toEqual({ kind: "failed" });
  });
});

// F7 fuse-vs-lease reconciliation, corrected by the cold review's P1: a recent
// `lastSeenAt` on an `offline` verdict is NOT evidence the relay leg is still
// attached - a host that cleanly detached or crashed one minute ago has exactly
// the same recent timestamp. Recency therefore buys exactly one thing, the
// recovery DIAL (`isConfirmedTransportRefusal` stays false inside the fuse
// window), while the death semantic (`hostUnavailability` /
// `isConfirmedHostDeath`) stays authoritative `offline` unless the dial
// actually succeeds (a ready live session).
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function offlineStatus(lastSeenAt: string | null): HostStatusDTO {
  return {
    connectivity: "offline",
    viewerReachability: "unknown",
    clientCloud: "ok",
    updateState: "current",
    appVersion: null,
    lastSeenAt,
  };
}

function isoBefore(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("isWithinRelayFuseGrace", () => {
  it("is true for offline + lastSeenAt 1 minute before now", () => {
    expect(isWithinRelayFuseGrace(offlineStatus(isoBefore(60_000)), NOW)).toBe(
      true,
    );
  });

  it("is true for offline + lastSeenAt just under the 4h fuse cap", () => {
    expect(
      isWithinRelayFuseGrace(
        offlineStatus(isoBefore(RELAY_FUSE_MAX_ATTACH_MS - 1)),
        NOW,
      ),
    ).toBe(true);
  });

  it("is false for offline + lastSeenAt just over the 4h fuse cap", () => {
    expect(
      isWithinRelayFuseGrace(
        offlineStatus(isoBefore(RELAY_FUSE_MAX_ATTACH_MS + 1)),
        NOW,
      ),
    ).toBe(false);
  });

  it("is true for offline + lastSeenAt slightly AHEAD of now (client clock lagging the cloud stamp)", () => {
    // `lastSeenAt` is cloud-stamped, so a client clock a few seconds behind
    // the server legitimately reads a just-seen host as "seen in the future".
    // Refusing that outright would deny the recovery dial to exactly the
    // freshest candidates.
    expect(
      isWithinRelayFuseGrace(
        offlineStatus(new Date(NOW + 60_000).toISOString()),
        NOW,
      ),
    ).toBe(true);
  });

  it("is false for offline + lastSeenAt implausibly far in the future (corrupt anchor, not skew)", () => {
    // Beyond plausible clock skew a future timestamp is corrupt data, and a
    // negative age would otherwise hold the dial window open for as long as
    // it takes the clock to catch up to it.
    expect(
      isWithinRelayFuseGrace(
        offlineStatus(
          new Date(NOW + RELAY_FUSE_MAX_CLOCK_SKEW_MS + 1).toISOString(),
        ),
        NOW,
      ),
    ).toBe(false);
  });

  it("is false when lastSeenAt is null (nothing anchors the window)", () => {
    expect(isWithinRelayFuseGrace(offlineStatus(null), NOW)).toBe(false);
  });

  it("is false when lastSeenAt is unparseable", () => {
    expect(isWithinRelayFuseGrace(offlineStatus("not-a-date"), NOW)).toBe(
      false,
    );
  });

  it("is false for any non-offline connectivity, regardless of lastSeenAt", () => {
    for (const connectivity of [
      "unknown",
      "connectable",
      "local-only",
    ] as const) {
      const status: HostStatusDTO = {
        ...offlineStatus(isoBefore(60_000)),
        connectivity,
      };
      expect(isWithinRelayFuseGrace(status, NOW)).toBe(false);
    }
  });
});

// The rest of this block builds entries through the real
// `hostListItemToDirectoryEntry` constructor (matching the "real mapped
// connectivity" style above), controlling grace via `lastSeenAt` relative to
// the real clock rather than a fixed `NOW` (the projection reads `Date.now()`
// internally).
const FUSE_GRACE_LAST_SEEN = new Date(Date.now() - 60_000).toISOString();
const GENUINE_OFFLINE_LAST_SEEN = new Date(
  Date.now() - 5 * 60 * 60 * 1000,
).toISOString();

function offlineItem(lastSeenAt: string): HostListItem {
  return {
    ...onlineItem(),
    status: { ...onlineItem().status, connectivity: "offline", lastSeenAt },
  };
}

describe("hostListItemToDirectoryEntry - relayFuseGrace (F7)", () => {
  it("is true for an offline host seen recently (within the fuse cap)", () => {
    const entry = hostListItemToDirectoryEntry(
      offlineItem(FUSE_GRACE_LAST_SEEN),
      RELAY_BASE_URL,
    );
    expect(entry.relayFuseGrace).toBe(true);
  });

  it("is false for an offline host last seen past the fuse cap", () => {
    const entry = hostListItemToDirectoryEntry(
      offlineItem(GENUINE_OFFLINE_LAST_SEEN),
      RELAY_BASE_URL,
    );
    expect(entry.relayFuseGrace).toBe(false);
  });

  it("is false for a connectable host", () => {
    const entry = hostListItemToDirectoryEntry(onlineItem(), RELAY_BASE_URL);
    expect(entry.relayFuseGrace).toBe(false);
  });
});

describe("hostUnavailability - offline stays authoritative under fuse grace (P1)", () => {
  it("reports offline for an offline entry even inside the fuse window - recency is not attachment", () => {
    const entry = hostListItemToDirectoryEntry(
      offlineItem(FUSE_GRACE_LAST_SEEN),
      RELAY_BASE_URL,
    );
    expect(hostUnavailability(entry)).toBe("offline");
  });

  it("reports offline for a genuinely offline entry past the fuse cap", () => {
    const entry = hostListItemToDirectoryEntry(
      offlineItem(GENUINE_OFFLINE_LAST_SEEN),
      RELAY_BASE_URL,
    );
    expect(hostUnavailability(entry)).toBe("offline");
  });
});

describe("isConfirmedHostDeath - fuse grace never exempts; only dial success does (P1)", () => {
  it("PAIRED (a): same recent lastSeenAt, recovery dial SUCCEEDED (ready live session) - not death", () => {
    const entry = hostListItemToDirectoryEntry(
      offlineItem(FUSE_GRACE_LAST_SEEN),
      RELAY_BASE_URL,
    );
    expect(isConfirmedHostDeath(entry, true)).toBe(false);
  });

  it("PAIRED (b): same recent lastSeenAt, no leg / dial not succeeded - confirmed death", () => {
    // A host that cleanly detached or crashed one minute ago is
    // observationally identical to a lease lapse at this layer. With no
    // session evidence the death gate must fire, or failover, the dead
    // surface, and the notification-action refusal are all suppressed for up
    // to four hours on a genuinely dead host.
    const entry = hostListItemToDirectoryEntry(
      offlineItem(FUSE_GRACE_LAST_SEEN),
      RELAY_BASE_URL,
    );
    expect(isConfirmedHostDeath(entry, false)).toBe(true);
  });

  it("is true for a genuine offline entry past the fuse cap with no session", () => {
    const entry = hostListItemToDirectoryEntry(
      offlineItem(GENUINE_OFFLINE_LAST_SEEN),
      RELAY_BASE_URL,
    );
    expect(isConfirmedHostDeath(entry, false)).toBe(true);
  });
});

describe("isConfirmedTransportRefusal - F7 (recovery dial attempted during fuse grace)", () => {
  it("is false for a fuse-grace offline entry - the ONE thing recency buys is the dial attempt", () => {
    const entry = hostListItemToDirectoryEntry(
      offlineItem(FUSE_GRACE_LAST_SEEN),
      RELAY_BASE_URL,
    );
    expect(isConfirmedTransportRefusal(entry, false)).toBe(false);
  });

  it("is true for a genuine offline entry", () => {
    const entry = hostListItemToDirectoryEntry(
      offlineItem(GENUINE_OFFLINE_LAST_SEEN),
      RELAY_BASE_URL,
    );
    expect(isConfirmedTransportRefusal(entry, false)).toBe(true);
  });

  it("dial permission and death verdict DIVERGE for the same fuse-grace entry: dial attempted, death confirmed", () => {
    // The split the P1 fix rests on: the same entry, with no session
    // evidence, may be dialed (cheap, recoverable) while every destructive
    // consumer still reads it as dead (honest). Recency must never leak from
    // the first question into the second.
    const entry = hostListItemToDirectoryEntry(
      offlineItem(FUSE_GRACE_LAST_SEEN),
      RELAY_BASE_URL,
    );
    expect(isConfirmedTransportRefusal(entry, false)).toBe(false);
    expect(isConfirmedHostDeath(entry, false)).toBe(true);
  });
});
