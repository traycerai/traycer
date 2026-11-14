import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import {
  acquireHostStreamClient,
  resetHostStreamClientCacheForTest,
  type HostStreamClientIdentity,
} from "@/lib/host/host-stream-client-cache";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { refreshConnectedAccountSettings } from "@/lib/host/refresh-connected-account-settings";

const readiness = vi.hoisted(() => ({
  remoteSessionReady: false,
}));

vi.mock(
  "@traycer-clients/shared/host-transport/remote/active-remote-sessions",
  () => ({
    hasReadyRemoteSession: () => readiness.remoteSessionReady,
  }),
);

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

const firstHost: HostDirectoryEntry = {
  hostId: "stream-host",
  label: "Stream host",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.0.0",
  transportDialability: "dialable",
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function readyStreamClient(): IHostStreamClient<HostStreamRpcRegistry> {
  let closed = false;
  return {
    subscribe: () => {
      throw new Error("refresh must not open a stream subscription");
    },
    subscribeWithParamsProvider: () => {
      throw new Error("refresh must not open a stream subscription");
    },
    close: () => {
      closed = true;
    },
    isClosed: () => closed,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "notification-refresh-stream",
    notifyBearerRotated: () => undefined,
    notifyCloudVerdictChanged: () => undefined,
    reconnectAll: () => undefined,
    isReady: () => !closed,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
  };
}

afterEach(() => {
  readiness.remoteSessionReady = false;
  resetHostStreamClientCacheForTest();
  vi.restoreAllMocks();
});

describe("refreshConnectedAccountSettings", () => {
  it("uses the window's ready streams and rechecks a remote session after the fleet read", async () => {
    const requestIds: string[] = [];
    const requestedHosts: string[] = [];
    const identity: HostStreamClientIdentity = {
      kind: "local",
      hostId: "stream-host",
      userId: "viewer-1",
      websocketUrl: firstHost.websocketUrl ?? "",
      publicKey: "",
      authnBaseUrl: "",
      authRecovery: "revalidate",
      openAuth: null,
    };
    const streamClient = readyStreamClient();
    const streamLease = acquireHostStreamClient(identity, () => streamClient);
    expect(streamLease).not.toBeNull();
    readiness.remoteSessionReady = true;
    const directoryEntries = deferred<readonly HostDirectoryEntry[]>();
    const listStarted = deferred<void>();
    const list = vi.fn(() => {
      listStarted.resolve();
      return directoryEntries.promise;
    });
    const entries = [firstHost, remoteHost];
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
            requestIds.push("refresh");
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
    const resolveRequester =
      hostClient.createRequesterForHostId.bind(hostClient);
    const createRequester = vi.spyOn(hostClient, "createRequesterForHostId");
    createRequester.mockImplementation((hostId) => {
      if (hostId !== null) requestedHosts.push(hostId);
      return resolveRequester(hostId);
    });
    const binding = Object.assign(Object.create(null), {
      hostClient,
      directory: { list },
    }) as HostRuntimeBinding<HostRpcRegistry>;

    const refresh = refreshConnectedAccountSettings(
      binding,
      null,
      "viewer-1",
      () => true,
    );
    await listStarted.promise;
    readiness.remoteSessionReady = false;
    directoryEntries.resolve(entries);
    await refresh;

    expect(requestedHosts).toEqual(["stream-host"]);
    expect(requestIds).toHaveLength(1);
    expect(requestedHosts).not.toContain("remote-in-fleet");
    streamLease?.release();
  });

  it("does not resolve a remote requester after its held session closes", async () => {
    const requestIds: string[] = [];
    const requestedHosts: string[] = [];
    const dialAttempts: string[] = [];
    const identity: HostStreamClientIdentity = {
      kind: "local",
      hostId: "stream-host",
      userId: "viewer-1",
      websocketUrl: firstHost.websocketUrl ?? "",
      publicKey: "",
      authnBaseUrl: "",
      authRecovery: "revalidate",
      openAuth: null,
    };
    const streamLease = acquireHostStreamClient(identity, readyStreamClient);
    readiness.remoteSessionReady = true;
    const hostClient = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      findHostById: (hostId) =>
        [firstHost, remoteHost].find((entry) => entry.hostId === hostId) ??
        null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => `refresh-race-${requestIds.length}`,
        handlers: {
          "host.accountSettings.refresh": () => {
            requestIds.push("refresh");
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
    const resolveRequester =
      hostClient.createRequesterForHostId.bind(hostClient);
    const createRequester = vi.spyOn(hostClient, "createRequesterForHostId");
    createRequester.mockImplementation((hostId) => {
      if (hostId !== null) {
        requestedHosts.push(hostId);
        if (hostId === remoteHost.hostId && !readiness.remoteSessionReady)
          dialAttempts.push(hostId);
      }
      return resolveRequester(hostId);
    });
    const binding = Object.assign(Object.create(null), {
      hostClient,
      directory: { list: async () => [firstHost, remoteHost] },
    }) as HostRuntimeBinding<HostRpcRegistry>;

    await refreshConnectedAccountSettings(binding, null, "viewer-1", () => {
      readiness.remoteSessionReady = false;
      return true;
    });

    expect(dialAttempts).toEqual([]);
    expect(requestedHosts).toEqual(["stream-host"]);
    expect(requestIds).toHaveLength(1);
    streamLease?.release();
  });
});
