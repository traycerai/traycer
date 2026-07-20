import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostListItem,
  HostListResponse,
} from "@traycer/protocol/host/host-status";
import {
  createRemoteHostFetcher,
  fetchRegisteredHostsViaHttp,
  hostListItemToDirectoryEntry,
  type HostListFetchResult,
} from "../remote-fetcher";

const AUTHN = "https://authn.example.test";

function onlineItem(): HostListItem {
  return {
    hostId: "host-1",
    displayName: "prod-devbox",
    platform: "Ubuntu",
    kind: "personal",
    publicKey: "pk-1",
    createdAt: "2026-07-01T12:00:00.000Z",
    status: {
      presenceLease: "fresh",
      hostRelayAttached: false,
      viewerReachability: "unknown",
      clientCloud: "ok",
      busy: true,
      busySessionCount: 1,
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
    presenceHealth: { status: "healthy", reason: null },
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
      expect(result.response.presenceHealth.status).toBe("healthy");
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
    // `presenceLease` is not a valid enum member — the mirror's schema rejects.
    const bad = {
      hosts: [
        {
          ...onlineItem(),
          status: { ...onlineItem().status, presenceLease: "nope" },
        },
      ],
      presenceHealth: { status: "healthy", reason: null },
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
    expect(entry.status).toBe("available");
    expect(entry.version).toBe("1.4.2");
    expect(entry.label).toBe("prod-devbox");
    expect(entry.remoteStatus.presenceLease).toBe("fresh");
    expect(entry.remoteStatus.busy).toBe(true);
  });

  it("reads unavailable from an expired presence lease", () => {
    const item: HostListItem = {
      ...onlineItem(),
      status: { ...onlineItem().status, presenceLease: "expired" },
    };
    const entry = hostListItemToDirectoryEntry(item, RELAY_BASE_URL);
    expect(entry.status).toBe("unavailable");
    // Still connectable — the reachability probe at tab-open time is the real
    // gate, not this coarse directory snapshot.
    expect(entry.websocketUrl).toBe(RELAY_BASE_URL);
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
    expect(await fetcher()).toEqual({ kind: "signed-out" });
  });

  it("maps the envelope to directory entries when ok", async () => {
    const fetcher = createRemoteHostFetcher({
      listHosts: async () => ({ kind: "ok", response: envelope() }),
      getBearerToken: () => "jwt",
      relayBaseUrl: RELAY_BASE_URL,
    });
    const outcome = await fetcher();
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
    expect(await fetcher()).toEqual({ kind: "signed-out" });
  });

  it("maps a network-error to failed so a transient blip is distinguishable from signed-out", async () => {
    const result: HostListFetchResult = { kind: "network-error" };
    const fetcher = createRemoteHostFetcher({
      listHosts: async () => result,
      getBearerToken: () => "jwt",
      relayBaseUrl: RELAY_BASE_URL,
    });
    expect(await fetcher()).toEqual({ kind: "failed" });
  });
});
