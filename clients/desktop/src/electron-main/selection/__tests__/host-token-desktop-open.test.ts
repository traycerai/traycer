import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROW_CONFIRM_CEILING_MS } from "@traycer-clients/shared/host-transport/row-confirmation";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
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
  type HostListFetchResult,
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
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
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
import {
  createBrowserSessionsHostDirectory,
  openBrowserSessionsTransport,
} from "../../browser-sessions/browser-sessions-transport";
import { createLocalHostInventoryStreamClient } from "../local-host-inventory-subscription";

const SIGN_IN_TOKEN = "main-sign-in-token";
const HOST_TOKEN = "main-host-token";
const LOCAL_HOST_AT_FLOOR = { ...mockLocalHostEntry, version: "2.0.0" };
const REMOTE_HOST_ID = "remote-personal-host";

function remoteHostItem(appVersion: string, publicKey: string): HostListItem {
  return {
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
}

function remoteHostEntry(
  appVersion: string,
  publicKey: string,
): RemoteHostDirectoryEntry {
  return hostListItemToDirectoryEntry(
    remoteHostItem(appVersion, publicKey),
    "wss://relay.test/attach",
  );
}

async function openLocalBrowserTransport(
  target: HostDirectoryEntry,
  confirmRow: () => Promise<boolean>,
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
    () => true,
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
    liveRow: () => target,
    confirmRow,
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
      () => true,
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
        liveRow: () => LOCAL_HOST_AT_FLOOR,
        confirmRow: () => Promise.resolve(true),
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
          ? { ...LOCAL_HOST_AT_FLOOR }
          : { ...LOCAL_HOST_AT_FLOOR, owner: currentOwner };
      const socketsBefore = FakeNativeWebSocket.instances.length;

      if (previousOwner !== undefined) {
        const prior = await openLocalBrowserTransport(
          entryFor(previousOwner),
          () => Promise.resolve(true),
        );
        expect(prior).not.toBeNull();
        prior?.close();
      }

      const transport = await openLocalBrowserTransport(entryFor(owner), () =>
        Promise.resolve(true),
      );
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
        liveRow: () => belowFloor,
        confirmRow: () => Promise.resolve(true),
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
      () => true,
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
    const depsFor = (row: RemoteHostDirectoryEntry) => ({
      authnBaseUrl: () => "https://authn.test",
      bearer: liveBearer(provider),
      cloudAuthorized: () => true,
      endpoint: () => null,
      liveRow: () => row,
      confirmRow: () => Promise.resolve(true),
      appVersion: "1.0.0-test",
      hostTokens,
    });
    const belowFloor = remoteHostEntry("1.5.4", peer.hostPublicKey);
    const atFloor = remoteHostEntry(MINIMUM_HOST_VERSION, peer.hostPublicKey);

    expect(belowFloor.kind).toBe("remote");
    expect(belowFloor.owner).toBeNull();
    expect(belowFloor.sandbox).toBeNull();
    expect(belowFloor.publicKey).toBe(peer.hostPublicKey);
    expect(
      openBrowserSessionsTransport(belowFloor, USER_A, depsFor(belowFloor)),
    ).toBeNull();
    expect(vi.mocked(createRemoteHostTransport)).not.toHaveBeenCalled();
    expect(peer.openCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const transport = openBrowserSessionsTransport(
      atFloor,
      USER_A,
      depsFor(atFloor),
    );
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
      () => true,
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

describe("desktop main's browser-sessions sign-in waits for the row only on a remote attach", () => {
  const RELEASED_REFUSAL: FatalErrorDetails = {
    code: "UNAUTHORIZED",
    reason: "released-host-token-refusal",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
  const PERSONAL_OWNER = { kind: "user", id: USER_A } as const;
  const TEAM_OWNER = { kind: "team", id: "team-a", name: "Alpha" } as const;
  // The attach asks for the row confirmation before it reads its open, so
  // while the read is held nothing past the bare refusal can have been written.
  const REDIAL_WAIT = { timeout: 10_000, interval: 50 } as const;

  /**
   * The redial is parked on the row read: the read was asked, and after
   * `parkedForMs` of the fake clock the attach has asked authn for no second
   * relay pass (an attach that did not wait asks for it as soon as it starts)
   * and only the host-only token's open is written.
   */
  async function expectParkedOnRowRead(
    remote: {
      readonly peer: RemoteMuxTestPeer;
      readonly reads: () => number;
      readonly mints: () => number;
    },
    parkedForMs: number,
  ): Promise<void> {
    await vi.waitFor(() => expect(remote.reads()).toBe(2), REDIAL_WAIT);
    await vi.advanceTimersByTimeAsync(parkedForMs);
    expect(remote.mints()).toBe(1);
    expect(remote.peer.openCount).toBe(1);
    expect(bearersOf(remote.peer)).toEqual([""]);
  }

  beforeEach(() => {
    remoteSocketFactoryHarness.delegate = null;
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    for (const socket of FakeNativeWebSocket.instances)
      socket.fireClose(1006, "test teardown");
    await settle();
    retireAllRemoteSessions();
    processReleasedHosts.forgetAll();
    remoteSocketFactoryHarness.delegate = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  type Registry =
    | { readonly kind: "owner"; readonly owner: HostOwnerPrincipal }
    | { readonly kind: "fails" }
    | { readonly kind: "silent" }
    | { readonly kind: "held" };

  /** A remote personal host whose first open the host refuses the released way; returns once that open is sent. */
  async function startRemote(initial: Registry): Promise<{
    readonly peer: RemoteMuxTestPeer;
    readonly registry: { current: Registry };
    readonly reads: () => number;
    /** Relay-pass mints asked of authn: one per attach that reached its grant. */
    readonly mints: () => number;
    /** Answers the oldest read the `held` registry is holding, listing the host under `owner`. */
    readonly answerHeld: (owner: HostOwnerPrincipal) => void;
    readonly close: () => void;
  }> {
    const peer = new RemoteMuxTestPeer();
    peer.refuseFirstOpen(RELEASED_REFUSAL);
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
      { token: HOST_TOKEN, expiresAtMs: Date.now() + 3_600_000 },
      hostTokens.era(USER_A),
      () => true,
    );
    const mintMock = vi.fn<typeof fetch>(
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
    vi.stubGlobal("fetch", mintMock);
    const registry = { current: initial };
    let reads = 0;
    const heldReads: Array<(owner: HostOwnerPrincipal) => void> = [];
    const listing = (owner: HostOwnerPrincipal): HostListFetchResult => ({
      kind: "ok",
      response: {
        hosts: [
          {
            ...remoteHostItem(MINIMUM_HOST_VERSION, peer.hostPublicKey),
            owner,
          },
        ],
      },
    });
    const directory = createBrowserSessionsHostDirectory({
      authnBaseUrl: () => "https://authn.test",
      relayBaseUrl: "wss://relay.test/attach",
      localHost: () => null,
      bearerToken: () => SIGN_IN_TOKEN,
      listRegisteredHosts: (): Promise<HostListFetchResult> => {
        reads += 1;
        const answer = registry.current;
        if (answer.kind === "silent") return new Promise(() => undefined);
        if (answer.kind === "fails")
          return Promise.resolve({ kind: "network-error" });
        if (answer.kind === "held")
          return new Promise((resolve) => {
            heldReads.push((owner) => resolve(listing(owner)));
          });
        return Promise.resolve(listing(answer.owner));
      },
      now: () => Date.now(),
    });
    // The row main holds when it builds the transport: the person's own.
    const row = await directory.resolve(REMOTE_HOST_ID);
    if (row === null) throw new Error("the registry did not list the host");
    const transport = openBrowserSessionsTransport(row, USER_A, {
      authnBaseUrl: () => "https://authn.test",
      bearer: liveBearer(provider),
      cloudAuthorized: () => true,
      endpoint: () => null,
      liveRow: () => directory.peek(REMOTE_HOST_ID),
      confirmRow: (stillWaiting, ended) =>
        directory.confirmRows(stillWaiting, ended),
      appVersion: "1.0.0-test",
      hostTokens,
    });
    if (transport === null)
      throw new Error("the remote transport did not build");
    const sessions = new BrowserSessionsStreamClient({
      wsStreamClient: transport.wsStreamClient,
      scope: { kind: "independent" },
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });
    // The first open is on the wire and refused; the redial is still to come.
    await vi.waitFor(() => expect(peer.openCount).toBe(1));
    return {
      peer,
      registry,
      reads: () => reads,
      mints: () => mintMock.mock.calls.length,
      answerHeld: (owner) => {
        const answer = heldReads.shift();
        if (answer === undefined) throw new Error("no registry read is held");
        answer(owner);
      },
      close: () => {
        sessions.close();
        transport.close();
      },
    };
  }

  const bearersOf = (peer: RemoteMuxTestPeer): unknown[] =>
    peer.opens.map((open) => open.bearer);

  it("sends the sign-in once, after the bare refusal, when the row is still the person's", async () => {
    const remote = await startRemote({ kind: "owner", owner: PERSONAL_OWNER });
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(remote.peer.openCount).toBe(2));
      expect(bearersOf(remote.peer)).toEqual(["", SIGN_IN_TOKEN]);
    } finally {
      remote.close();
    }
  });

  it("sends no sign-in when the row moved from the person's to a team's between the dials", async () => {
    const remote = await startRemote({ kind: "owner", owner: PERSONAL_OWNER });
    try {
      remote.registry.current = { kind: "held" };
      await expectParkedOnRowRead(remote, 1_000);

      remote.answerHeld(TEAM_OWNER);
      await vi.waitFor(() => expect(remote.peer.openCount).toBeGreaterThan(1));
      expect(bearersOf(remote.peer)).not.toContain(SIGN_IN_TOKEN);
    } finally {
      remote.close();
    }
  });

  it.each([
    { name: "fails", registry: { kind: "fails" } as const },
    {
      name: "does not answer within its ceiling",
      registry: { kind: "silent" } as const,
    },
  ])(
    "sends the sign-in on the redial, as the row last read allows, when the row read $name",
    async ({ registry }) => {
      const remote = await startRemote({
        kind: "owner",
        owner: PERSONAL_OWNER,
      });
      try {
        remote.registry.current = registry;
        await vi.advanceTimersByTimeAsync(8_000);
        await vi.waitFor(() => expect(remote.peer.openCount).toBe(2));
        expect(bearersOf(remote.peer)).toEqual(["", SIGN_IN_TOKEN]);
      } finally {
        remote.close();
      }
    },
  );

  it("writes no sign-in until the row read it waits on settles, then sends it", async () => {
    const remote = await startRemote({ kind: "owner", owner: PERSONAL_OWNER });
    try {
      remote.registry.current = { kind: "held" };
      await expectParkedOnRowRead(remote, 1_000);

      remote.answerHeld(PERSONAL_OWNER);
      await vi.waitFor(() => expect(remote.peer.openCount).toBe(2));
      expect(bearersOf(remote.peer)).toEqual(["", SIGN_IN_TOKEN]);
    } finally {
      remote.close();
    }
  });

  it("writes no sign-in before the row read's ceiling passes, then sends it", async () => {
    const remote = await startRemote({ kind: "owner", owner: PERSONAL_OWNER });
    try {
      remote.registry.current = { kind: "silent" };
      // The wait began within one poll of the read being asked.
      await expectParkedOnRowRead(remote, ROW_CONFIRM_CEILING_MS - 100);

      await vi.advanceTimersByTimeAsync(200);
      await vi.waitFor(() => expect(remote.peer.openCount).toBe(2));
      expect(bearersOf(remote.peer)).toEqual(["", SIGN_IN_TOKEN]);
    } finally {
      remote.close();
    }
  });

  it("never awaits the row confirmation on a local door", async () => {
    const confirmRow = vi.fn(() => Promise.resolve(true));
    const transport = await openLocalBrowserTransport(
      { ...LOCAL_HOST_AT_FLOOR, owner: PERSONAL_OWNER },
      confirmRow,
    );
    if (transport === null)
      throw new Error("the local transport did not build");
    const sessions = new BrowserSessionsStreamClient({
      wsStreamClient: transport.wsStreamClient,
      scope: { kind: "independent" },
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });
    try {
      await vi.waitFor(() =>
        expect(FakeNativeWebSocket.instances).toHaveLength(1),
      );
      const first = FakeNativeWebSocket.instances[0];
      first.fireOpen();
      await vi.waitFor(() =>
        expect(sentFramesOfKind(first, "open")).toHaveLength(1),
      );
      first.fireMessage(
        JSON.stringify({ kind: "fatalError", details: RELEASED_REFUSAL }),
      );
      await vi.waitFor(() =>
        expect(FakeNativeWebSocket.instances).toHaveLength(2),
      );
      const second = FakeNativeWebSocket.instances[1];
      second.fireOpen();
      await vi.waitFor(() =>
        expect(sentFramesOfKind(second, "open")).toHaveLength(1),
      );
      expect(sentFramesOfKind(second, "open")[0]?.token).toBe(SIGN_IN_TOKEN);
      expect(confirmRow).not.toHaveBeenCalled();
    } finally {
      sessions.close();
      transport.close();
    }
  });
});
