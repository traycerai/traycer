import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return { ...actual, MINIMUM_HOST_VERSION: "2.0.0" };
  },
);

const remoteSocketFactoryHarness = vi.hoisted(() => {
  const harness: { delegate: IStreamWebSocketFactory | null } = {
    delegate: null,
  };
  return harness;
});

vi.mock(
  "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/whatwg-stream-ws-factory")
      >();
    return {
      ...actual,
      createWhatwgStreamWebSocketFactory: () => {
        const original = actual.createWhatwgStreamWebSocketFactory();
        const factory: IStreamWebSocketFactory = {
          create: (url, priority) => {
            const delegate = remoteSocketFactoryHarness.delegate;
            return delegate === null
              ? original.create(url, priority)
              : delegate.create(url, priority);
          },
        };
        return factory;
      },
    };
  },
);

vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      createRemoteHostTransport: vi.fn(actual.createRemoteHostTransport),
    };
  },
);

const wsStreamClientConstructionHarness = vi.hoisted(() => ({
  constructed: 0,
}));
vi.mock(
  "@traycer-clients/shared/host-transport/ws-stream-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/ws-stream-client")
      >();
    class RecordingWsStreamClient<
      Registry extends VersionedStreamRpcRegistry,
    > extends actual.WsStreamClient<Registry> {
      constructor(options: WsStreamClientOptions<Registry>) {
        super(options);
        wsStreamClientConstructionHarness.constructed += 1;
      }
    }
    return { ...actual, WsStreamClient: RecordingWsStreamClient };
  },
);

import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
} from "@traycer-clients/shared/auth/host-token-source";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { MINIMUM_HOST_VERSION } from "@traycer-clients/shared/host-client/minimum-host-version";
import { BrowserSessionsStreamClient } from "@traycer-clients/shared/host-transport/browser-sessions-stream-client";
import { HostInventoryStreamClient } from "@traycer-clients/shared/host-transport/host-inventory-stream-client";
import { LOCAL_OWNER_JAR_CASES } from "@traycer-clients/shared/test-fixtures/local-owner-jar-cases";
import {
  createRemoteHostTransport,
  retireAllRemoteSessions,
} from "@traycer-clients/shared/host-transport/remote/index";
import { RemoteMuxTestPeer } from "@traycer-clients/shared/host-transport/__tests__/remote-mux-test-peer";
import type { IStreamWebSocketFactory } from "@traycer-clients/shared/host-transport/ws-stream-factory";
import type { WsStreamClientOptions } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { DEFAULT_INITIAL_BACKOFF_MS } from "@traycer-clients/shared/host-transport/transport-config";
import {
  FakeNativeWebSocket,
  liveBearer,
  newProvider,
  sentFramesOfKind,
  sentTokens,
  settle,
  signIn,
  USER_A,
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import type { BrowserSessionsHostTransport } from "../../browser-sessions/browser-sessions-transport";
import { openBrowserSessionsTransport } from "../../browser-sessions/browser-sessions-transport";
import { createLocalHostInventoryStreamClient } from "../local-host-inventory-subscription";

const SIGN_IN_TOKEN = "main-sign-in-token";
const HOST_TOKEN = "main-host-token";
const LOCAL_HOST_AT_FLOOR = { ...mockLocalHostEntry, version: "2.0.0" };
const REMOTE_HOST_ID = "remote-personal-host";

function remoteHostEntry(
  appVersion: string,
  publicKey: string,
): RemoteHostDirectoryEntry {
  const item: HostListItem = {
    hostId: REMOTE_HOST_ID,
    displayName: "Remote personal host",
    platform: "linux",
    kind: "personal",
    publicKey,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatePolicy: "auto",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion,
      lastSeenAt: null,
    },
  };
  return hostListItemToDirectoryEntry(item, "wss://relay.test/attach");
}

async function openLocalBrowserTransport(
  target: HostDirectoryEntry,
): Promise<BrowserSessionsHostTransport | null> {
  const provider = newProvider();
  signIn(provider, USER_A, SIGN_IN_TOKEN);
  const hostTokens = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => Promise.resolve({ kind: "no-sign-in" }),
    signIn: null,
    now: () => Date.now(),
  });
  await hostTokens.adopt(
    USER_A,
    target.hostId,
    {
      token: HOST_TOKEN,
      expiresAtMs: Date.now() + 60_000,
    },
    hostTokens.era(USER_A),
  );
  const websocketUrl = target.websocketUrl;
  if (websocketUrl === null)
    throw new Error("the local host has no websocket URL");
  return openBrowserSessionsTransport(target, USER_A, {
    authnBaseUrl: () => "https://authn.test",
    bearer: liveBearer(provider),
    cloudAuthorized: () => true,
    endpoint: () => ({
      hostId: target.hostId,
      websocketUrl,
    }),
    appVersion: "1.0.0-test",
    hostTokens,
  });
}

describe("desktop main local streams open with host tokens", () => {
  beforeEach(() => {
    remoteSocketFactoryHarness.delegate = null;
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
    vi.mocked(createRemoteHostTransport).mockClear();
    wsStreamClientConstructionHarness.constructed = 0;
  });

  afterEach(async () => {
    for (const socket of FakeNativeWebSocket.instances)
      socket.fireClose(1006, "test teardown");
    await settle();
    retireAllRemoteSessions();
    remoteSocketFactoryHarness.delegate = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses the host token on inventory and browser-session opens, never the sign-in token", async () => {
    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN);
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    });
    await hostTokens.adopt(
      USER_A,
      mockLocalHostEntry.hostId,
      {
        token: HOST_TOKEN,
        expiresAtMs: Date.now() + 60_000,
      },
      hostTokens.era(USER_A),
    );

    const websocketUrl = LOCAL_HOST_AT_FLOOR.websocketUrl;
    if (websocketUrl === null)
      throw new Error("the mock local host has no websocket URL");
    const endpoint = {
      hostId: LOCAL_HOST_AT_FLOOR.hostId,
      websocketUrl,
      version: LOCAL_HOST_AT_FLOOR.version,
    };
    const localHost = () => endpoint;
    const inventoryClient = createLocalHostInventoryStreamClient({
      hostTokens,
      localHost,
      bearer: liveBearer(provider),
      appVersion: "1.0.0-test",
    });
    const inventoryWsStreamClient = inventoryClient(endpoint, USER_A);
    if (inventoryWsStreamClient === null)
      throw new Error("local inventory stream client did not build");
    expect(wsStreamClientConstructionHarness.constructed).toBe(1);
    const inventory = new HostInventoryStreamClient({
      wsStreamClient: inventoryWsStreamClient,
      callbacks: {
        onSnapshot: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(1),
    );
    const inventorySocket = FakeNativeWebSocket.instances[0];
    if (inventorySocket === undefined)
      throw new Error("inventory socket missing");
    inventorySocket.fireOpen();
    await settle();

    const browserTransport = openBrowserSessionsTransport(
      LOCAL_HOST_AT_FLOOR,
      USER_A,
      {
        authnBaseUrl: () => "https://authn.test",
        bearer: liveBearer(provider),
        cloudAuthorized: () => true,
        endpoint: localHost,
        appVersion: "1.0.0-test",
        hostTokens,
      },
    );
    if (browserTransport === null)
      throw new Error("local browser-session transport did not build");
    expect(wsStreamClientConstructionHarness.constructed).toBe(2);
    const browserSessions = new BrowserSessionsStreamClient({
      wsStreamClient: browserTransport.wsStreamClient,
      scope: { kind: "independent" },
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(2),
    );
    const browserSocket = FakeNativeWebSocket.instances[1];
    if (browserSocket === undefined) throw new Error("browser socket missing");
    browserSocket.fireOpen();
    await settle();

    expect(sentFramesOfKind(inventorySocket, "open")[0]?.token).toBe(
      HOST_TOKEN,
    );
    expect(sentFramesOfKind(browserSocket, "open")[0]?.token).toBe(HOST_TOKEN);
    expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);

    browserSessions.close();
    browserTransport.close();
    inventory.close();
    inventoryWsStreamClient.close("test complete");
  });

  it.each(LOCAL_OWNER_JAR_CASES)(
    "applies the main jar lane to a local entry with $name",
    async ({ owner, omitOwner, previousOwner, admitted }) => {
      const entryFor = (currentOwner: typeof owner): HostDirectoryEntry =>
        omitOwner
          ? { ...mockLocalHostEntry }
          : { ...mockLocalHostEntry, owner: currentOwner };
      const socketsBefore = FakeNativeWebSocket.instances.length;

      if (previousOwner !== undefined) {
        const prior = await openLocalBrowserTransport(entryFor(previousOwner));
        expect(prior).not.toBeNull();
        prior?.close();
      }

      const transport = await openLocalBrowserTransport(entryFor(owner));
      expect(transport !== null).toBe(admitted);
      if (transport === null) {
        expect(FakeNativeWebSocket.instances).toHaveLength(socketsBefore);
        return;
      }

      const sessions = new BrowserSessionsStreamClient({
        wsStreamClient: transport.wsStreamClient,
        scope: { kind: "independent" },
        callbacks: {
          onServerFrame: () => undefined,
          onConnectionStatus: () => undefined,
        },
      });
      await vi.waitFor(() =>
        expect(FakeNativeWebSocket.instances).toHaveLength(socketsBefore + 1),
      );
      const browserSocket = FakeNativeWebSocket.instances[socketsBefore];
      if (browserSocket === undefined)
        throw new Error("browser-session socket missing");
      browserSocket.fireOpen();
      await settle();
      expect(sentFramesOfKind(browserSocket, "open")[0]?.token).toBe(
        HOST_TOKEN,
      );
      expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
      sessions.close();
      transport.close();
    },
  );

  it("does not construct either local stream transport below the minimum", async () => {
    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN);
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    });
    const websocketUrl = LOCAL_HOST_AT_FLOOR.websocketUrl;
    if (websocketUrl === null)
      throw new Error("the mock local host has no websocket URL");
    const belowFloor = {
      ...LOCAL_HOST_AT_FLOOR,
      websocketUrl,
      version: "1.5.4",
    };
    const endpoint = {
      hostId: belowFloor.hostId,
      websocketUrl: belowFloor.websocketUrl,
      version: belowFloor.version,
    };
    const inventoryFactory = createLocalHostInventoryStreamClient({
      hostTokens,
      localHost: () => endpoint,
      bearer: liveBearer(provider),
      appVersion: "1.0.0-test",
    });

    expect(inventoryFactory(endpoint, USER_A)).toBeNull();
    expect(wsStreamClientConstructionHarness.constructed).toBe(0);
    expect(
      openBrowserSessionsTransport(belowFloor, USER_A, {
        authnBaseUrl: () => "https://authn.test",
        bearer: liveBearer(provider),
        cloudAuthorized: () => true,
        endpoint: () => endpoint,
        appVersion: "1.0.0-test",
        hostTokens,
      }),
    ).toBeNull();
    expect(wsStreamClientConstructionHarness.constructed).toBe(0);
    expect(FakeNativeWebSocket.instances).toHaveLength(0);
  });

  it("rejects a below-floor personal remote before transport construction and opens the exact floor", async () => {
    const peer = new RemoteMuxTestPeer();
    remoteSocketFactoryHarness.delegate = peer.factory;
    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN);
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    });
    await hostTokens.adopt(
      USER_A,
      REMOTE_HOST_ID,
      {
        token: HOST_TOKEN,
        expiresAtMs: Date.now() + 60_000,
      },
      hostTokens.era(USER_A),
    );
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            grant: "relay-pass",
            role: "client",
            expires_in: 300,
            session_grant: "relay-session-grant",
            session_grant_expires_in: 300,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const deps = {
      authnBaseUrl: () => "https://authn.test",
      bearer: liveBearer(provider),
      cloudAuthorized: () => true,
      endpoint: () => null,
      appVersion: "1.0.0-test",
      hostTokens,
    };
    const belowFloor = remoteHostEntry("1.5.4", peer.hostPublicKey);
    const atFloor = remoteHostEntry(MINIMUM_HOST_VERSION, peer.hostPublicKey);

    expect(belowFloor.kind).toBe("remote");
    expect(belowFloor.owner).toBeNull();
    expect(belowFloor.sandbox).toBeNull();
    expect(belowFloor.publicKey).toBe(peer.hostPublicKey);
    expect(openBrowserSessionsTransport(belowFloor, USER_A, deps)).toBeNull();
    expect(vi.mocked(createRemoteHostTransport)).not.toHaveBeenCalled();
    expect(peer.openCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const transport = openBrowserSessionsTransport(atFloor, USER_A, deps);
    if (transport === null)
      throw new Error("the personal remote at the minimum did not build");
    try {
      await vi.waitFor(() => expect(peer.openCount).toBe(1));
      expect(vi.mocked(createRemoteHostTransport)).toHaveBeenCalledTimes(1);
      expect(peer.opens).toHaveLength(1);
      expect(peer.errors).toEqual([]);
    } finally {
      transport.close();
    }
  });

  it("uses the fresh local version on reconnect and preserves exact-floor equality", async () => {
    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN);
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    });
    await hostTokens.adopt(
      USER_A,
      LOCAL_HOST_AT_FLOOR.hostId,
      {
        token: HOST_TOKEN,
        expiresAtMs: Date.now() + 60_000,
      },
      hostTokens.era(USER_A),
    );
    const websocketUrl = LOCAL_HOST_AT_FLOOR.websocketUrl;
    if (websocketUrl === null)
      throw new Error("the local host has no websocket URL");
    const endpoint = {
      hostId: LOCAL_HOST_AT_FLOOR.hostId,
      websocketUrl,
      version: MINIMUM_HOST_VERSION,
    };
    let currentVersion = MINIMUM_HOST_VERSION;
    const observedVersions: string[] = [];
    const inventoryFactory = createLocalHostInventoryStreamClient({
      hostTokens,
      localHost: () => {
        observedVersions.push(currentVersion);
        return { ...endpoint, version: currentVersion };
      },
      bearer: liveBearer(provider),
      appVersion: "1.0.0-test",
    });
    const client = inventoryFactory(endpoint, USER_A);
    if (client === null)
      throw new Error("the local inventory stream did not build at the floor");
    expect(wsStreamClientConstructionHarness.constructed).toBe(1);
    const inventory = new HostInventoryStreamClient({
      wsStreamClient: client,
      callbacks: {
        onSnapshot: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });

    try {
      await vi.waitFor(() =>
        expect(FakeNativeWebSocket.instances).toHaveLength(1),
      );
      const firstSocket = FakeNativeWebSocket.instances[0];
      if (firstSocket === undefined)
        throw new Error("initial inventory socket missing");
      firstSocket.fireOpen();
      await settle();
      firstSocket.fireClose(1006, "network interrupted at the floor");
      await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS);
      await vi.waitFor(() =>
        expect(FakeNativeWebSocket.instances).toHaveLength(2),
      );

      const equalitySocket = FakeNativeWebSocket.instances[1];
      if (equalitySocket === undefined)
        throw new Error("the equality reconnect socket was not constructed");
      expect(equalitySocket.url).toBe(
        websocketUrl.replace(/\/rpc$/, "/stream"),
      );
      equalitySocket.fireOpen();
      await settle();

      const readsBeforeDowngradeReconnect = observedVersions.length;
      currentVersion = "1.5.4";
      expect(endpoint.hostId).toBe(LOCAL_HOST_AT_FLOOR.hostId);
      expect(endpoint.websocketUrl).toBe(websocketUrl);
      equalitySocket.fireClose(1006, "network interrupted after version drop");
      await vi.advanceTimersByTimeAsync(2 * DEFAULT_INITIAL_BACKOFF_MS);
      await settle();
      expect(
        observedVersions
          .slice(readsBeforeDowngradeReconnect)
          .every((version) => version === "1.5.4"),
      ).toBe(true);
      expect(observedVersions.length).toBeGreaterThan(
        readsBeforeDowngradeReconnect,
      );
      expect(FakeNativeWebSocket.instances).toHaveLength(2);
    } finally {
      inventory.close();
      client.close("test complete");
    }
  });
});
