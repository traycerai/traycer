import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
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
  const held = clientsByHost.get(hostId);
  if (
    held !== undefined &&
    held.userId === userId &&
    held.queryClient === queryClient &&
    held.handlers === handlers
  ) {
    return held.client;
  }
  const entry: HostDirectoryEntry = { ...mockLocalHostEntry, hostId };
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
  clientsByHost.set(hostId, { userId, queryClient, handlers, client });
  return client;
}

export function resetTestHostClients(): void {
  clientsByHost.clear();
}
