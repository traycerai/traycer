import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { QueryClient } from "@tanstack/react-query";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";

/** What the mock messenger answers, by host method. */
export type TestHostHandlers = ConstructorParameters<
  typeof MockHostMessenger<HostRpcRegistry>
>[0]["handlers"];

interface HeldClient {
  /** Names the directory entry the client addresses, so another entry builds another client. */
  readonly entryKey: string;
  readonly userId: string;
  readonly queryClient: QueryClient;
  readonly handlers: TestHostHandlers;
  readonly client: HostClient<HostRpcRegistry>;
}

const clientsByHost = new Map<string, HeldClient>();

/**
 * One real `HostClient` per host id, stable across calls, answering `handlers`
 * through the shared mock messenger, signed in as `userId`. A call naming
 * another user, query client or handlers object builds a fresh client rather
 * than reusing the held one. A suite with several hosts resolves each
 * through `createRequester` on the entry named `hostId`.
 */
export function createTestHostClient(
  hostId: string,
  userId: string,
  queryClient: QueryClient,
  handlers: TestHostHandlers,
): HostClient<HostRpcRegistry> {
  const entry: HostDirectoryEntry = { ...mockLocalHostEntry, hostId };
  return clientFor({ entry, entryKey: hostId, userId, queryClient, handlers });
}

/**
 * The same client over a REMOTE directory entry for `hostId` with `publicKey`:
 * its owner identity is the remote one (host, user, key, address), so a
 * different key under the same host id reads as a key rotation.
 */
export function createTestRemoteHostClient(options: {
  readonly hostId: string;
  readonly userId: string;
  readonly publicKey: string;
  readonly queryClient: QueryClient;
  readonly handlers: TestHostHandlers;
}): HostClient<HostRpcRegistry> {
  const { hostId, userId, publicKey, queryClient, handlers } = options;
  const entry: RemoteHostDirectoryEntry = {
    ...mockRemoteHostEntry,
    hostId,
    publicKey,
    relayFuseGrace: false,
    sandbox: null,
    owner: null,
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
  };
  return clientFor({
    entry,
    entryKey: `remote:${publicKey}`,
    userId,
    queryClient,
    handlers,
  });
}

function clientFor(options: {
  readonly entry: HostDirectoryEntry;
  readonly entryKey: string;
  readonly userId: string;
  readonly queryClient: QueryClient;
  readonly handlers: TestHostHandlers;
}): HostClient<HostRpcRegistry> {
  const { entry, entryKey, userId, queryClient, handlers } = options;
  const hostId = entry.hostId;
  const held = clientsByHost.get(hostId);
  if (
    held !== undefined &&
    held.entryKey === entryKey &&
    held.userId === userId &&
    held.queryClient === queryClient &&
    held.handlers === handlers
  ) {
    return held.client;
  }
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (id) => (id === hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `request-${hostId}`,
      handlers,
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "token",
      identity: { userId, username: userId, providerHandle: null },
    }),
  );
  const client = spine.createRequester(entry);
  clientsByHost.set(hostId, {
    entryKey,
    userId,
    queryClient,
    handlers,
    client,
  });
  return client;
}

export function resetTestHostClients(): void {
  clientsByHost.clear();
}
