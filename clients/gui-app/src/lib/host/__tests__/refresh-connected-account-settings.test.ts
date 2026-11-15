import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IRemoteSession } from "@traycer-clients/shared/host-transport/remote/remote-session";
import {
  acquireRemoteSession,
  remoteSessionBorrowCountForTest,
  remoteSessionRefCountForTest,
  retireAllRemoteSessions,
  type RemoteSessionAcquirePolicy,
  type RemoteSessionIdentity,
} from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { refreshConnectedAccountSettings } from "@/lib/host/refresh-connected-account-settings";

const remoteHost: RemoteHostDirectoryEntry = {
  hostId: "remote-in-fleet",
  label: "Remote computer",
  kind: "remote",
  websocketUrl: "wss://relay.example.test/attach",
  version: "1.0.0",
  transportDialability: "dialable",
  publicKey: "public-key",
  owner: null,
  relayFuseGrace: false,
  sandbox: null,
  remoteStatus: {
    connectivity: "connectable",
    viewerReachability: "ok",
    clientCloud: "ok",
    updateState: "current",
    appVersion: null,
    lastSeenAt: null,
  },
};

const remoteSessionPolicy: RemoteSessionAcquirePolicy = {
  proactiveWakeEligible: true,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function remoteIdentity(userId: string): RemoteSessionIdentity {
  const hostPublicKey = remoteHost.publicKey;
  const relayAttachUrl = remoteHost.websocketUrl;
  if (hostPublicKey === null || relayAttachUrl === null)
    throw new Error("The remote fixture needs a public key and relay address.");
  return {
    hostId: remoteHost.hostId,
    userId,
    hostPublicKey,
    relayAttachUrl,
    authRecovery: "revalidate",
    authEpoch: "notification-refresh-context",
    openAuth: "user-bearer",
  };
}

interface FakeRemoteSession extends IRemoteSession<
  VersionedRpcRegistry,
  VersionedStreamRpcRegistry
> {
  readonly closeCalls: number;
}

function readyRemoteSession(): FakeRemoteSession {
  let closeCalls = 0;
  let closed = false;
  return {
    get closeCalls() {
      return closeCalls;
    },
    start: vi.fn(),
    isClosed: () => closed,
    isReady: () => !closed,
    isSilentFor: () => false,
    sendUnary: vi.fn(async () => {
      throw new Error("remote refresh response is not used by this fake");
    }),
    forceReconnect: vi.fn(),
    subscribe: vi.fn(() => {
      throw new Error("refresh must not open a stream subscription");
    }),
    subscribeAtVersion: vi.fn(() => {
      throw new Error("refresh must not open a stream subscription");
    }),
    subscribeWithParamsProvider: vi.fn(() => {
      throw new Error("refresh must not open a stream subscription");
    }),
    notifyBearerRotated: vi.fn(),
    notifyCloudVerdictChanged: vi.fn(),
    wake: vi.fn(),
    onClosed: () => () => undefined,
    subscribeAvailabilityRecovered: () => () => undefined,
    subscribeReadinessLost: () => () => undefined,
    getMethodSupport: () => "supported",
    getMethodSchemaVersion: () => ({ major: 1, minor: 0 }),
    subscribeMethodSupport: () => () => undefined,
    terminalFatal: () => null,
    close: () => {
      closeCalls += 1;
      closed = true;
    },
  };
}

function makeBinding(
  entries: readonly HostDirectoryEntry[],
  list: () => Promise<readonly HostDirectoryEntry[]>,
  requestIds: string[],
  requestedHosts: string[],
): HostRuntimeBinding<HostRpcRegistry> {
  const hostClient = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      entries.find((entry) => entry.hostId === hostId) ?? null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `refresh-${requestIds.length}`,
      handlers: {
        "host.accountSettings.refresh": () => {
          requestIds.push("local-refresh");
          return {};
        },
      },
    }),
  });
  hostClient.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "test-bearer",
    }),
  );
  const resolveRequester = hostClient.createRequesterForHostId.bind(hostClient);
  vi.spyOn(hostClient, "createRequesterForHostId").mockImplementation(
    (hostId) => {
      if (hostId !== null) requestedHosts.push(hostId);
      return resolveRequester(hostId);
    },
  );
  return Object.assign(Object.create(null), {
    hostClient,
    directory: {
      list,
      findById: (hostId: string) =>
        entries.find((entry) => entry.hostId === hostId) ?? null,
    },
  }) as HostRuntimeBinding<HostRpcRegistry>;
}

afterEach(() => {
  retireAllRemoteSessions();
  vi.restoreAllMocks();
});

describe("refreshConnectedAccountSettings", () => {
  it("skips a remote session whose last owner closes during the deferred directory read", async () => {
    const requestIds: string[] = [];
    const requestedHosts: string[] = [];
    const identity = remoteIdentity("viewer-1");
    const session = readyRemoteSession();
    const owner = acquireRemoteSession(
      identity,
      remoteSessionPolicy,
      () => session,
    );
    const directoryEntries = deferred<readonly HostDirectoryEntry[]>();
    const listStarted = deferred<void>();
    const list = vi.fn(() => {
      listStarted.resolve();
      return directoryEntries.promise;
    });
    const entries = [remoteHost];
    const binding = makeBinding(entries, list, requestIds, requestedHosts);

    const refresh = refreshConnectedAccountSettings(
      binding,
      null,
      "viewer-1",
      () => true,
    );
    await listStarted.promise;
    owner.close();
    expect(remoteSessionRefCountForTest(identity)).toBe(0);
    expect(session.isClosed()).toBe(false);

    directoryEntries.resolve(entries);
    await refresh;

    expect(requestedHosts).toEqual([]);
    expect(requestIds).toEqual([]);
    expect(session.sendUnary).not.toHaveBeenCalled();
    expect(remoteSessionBorrowCountForTest(identity)).toBe(0);
  });

  it("borrows the matching viewer's remote session and releases the borrow when the refresh settles", async () => {
    const requestIds: string[] = [];
    const requestedHosts: string[] = [];
    const identity = remoteIdentity("viewer-1");
    const session = readyRemoteSession();
    const sendStarted = deferred<void>();
    const sendGate = deferred<void>();
    session.sendUnary = vi.fn(async () => {
      sendStarted.resolve();
      await sendGate.promise;
      throw new Error("remote refresh response is not used by this fake");
    });
    const owner = acquireRemoteSession(
      identity,
      remoteSessionPolicy,
      () => session,
    );
    const entries = [remoteHost];
    const binding = makeBinding(
      entries,
      async () => entries,
      requestIds,
      requestedHosts,
    );

    const refresh = refreshConnectedAccountSettings(
      binding,
      null,
      "viewer-1",
      () => true,
    );
    await sendStarted.promise;
    expect(remoteSessionBorrowCountForTest(identity)).toBe(1);
    expect(remoteSessionRefCountForTest(identity)).toBe(1);

    owner.close();
    expect(remoteSessionBorrowCountForTest(identity)).toBe(1);
    expect(remoteSessionRefCountForTest(identity)).toBe(0);
    sendGate.resolve();
    await refresh;

    expect(session.sendUnary).toHaveBeenCalledTimes(1);
    expect(remoteSessionBorrowCountForTest(identity)).toBe(0);
    expect(requestedHosts).toEqual([]);
    expect(requestIds).toEqual([]);
  });

  it("does not refresh a ready remote session owned by another viewer and balances its borrow", async () => {
    const requestIds: string[] = [];
    const requestedHosts: string[] = [];
    const identity = remoteIdentity("another-viewer");
    const session = readyRemoteSession();
    const owner = acquireRemoteSession(
      identity,
      remoteSessionPolicy,
      () => session,
    );
    const entries = [remoteHost];
    const binding = makeBinding(
      entries,
      async () => entries,
      requestIds,
      requestedHosts,
    );

    await refreshConnectedAccountSettings(
      binding,
      null,
      "viewer-1",
      () => true,
    );

    expect(session.sendUnary).not.toHaveBeenCalled();
    expect(remoteSessionRefCountForTest(identity)).toBe(1);
    expect(remoteSessionBorrowCountForTest(identity)).toBe(0);
    expect(requestedHosts).toEqual([]);
    expect(requestIds).toEqual([]);
    owner.close();
  });
});
