import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import {
  ConfigurationSourceContext,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The shared host client a page under test reads through `useHostClient()`.
 * Each test file points `@/lib/host`'s `useHostClient` here, so the queries,
 * mutations and cache beneath it stay real.
 */
export const teamHostBoundary: {
  client: HostClient<HostRpcRegistry> | null;
} = { client: null };

export function requireTeamHostClient(): HostClient<HostRpcRegistry> {
  if (teamHostBoundary.client === null) {
    throw new Error("no team host client mounted");
  }
  return teamHostBoundary.client;
}

export function poolSource(
  effectiveRole: "owner" | "admin" | "editor" | "viewer",
): ConfigurationSource {
  return {
    kind: "pool",
    environmentId: "env-a",
    roomId: "room-a",
    providerHandle: "handle-a",
    effectiveRole,
  };
}

/** One pool item row; `writtenBy` is the host that wrote it last. */
export function configurationItem(
  row: Pick<EnvironmentConfigurationItem, "kind" | "key" | "value"> &
    Partial<Pick<EnvironmentConfigurationItem, "os" | "revision">>,
): EnvironmentConfigurationItem {
  return {
    os: null,
    revision: 1,
    updatedAt: 1,
    writtenBy: { source: "live", hostId: null, hostName: null },
    ...row,
  };
}

export interface TeamPageHarness {
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  /** The params of every request the host received for `method`, in order. */
  readonly paramsOf: (method: string) => unknown[];
}

export function mountTeamPage(
  source: ConfigurationSource,
  handlers: MockHandlerMap<HostRpcRegistry>,
): TeamPageHarness {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  let requestCounter = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestCounter += 1;
      return `req-team-${String(requestCounter)}`;
    },
    handlers,
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  teamHostBoundary.client = spine.createRequester(mockLocalHostEntry);
  useAuthStore.setState({ status: "signed-in" });
  return {
    messenger,
    queryClient,
    paramsOf: (method) =>
      messenger.calls
        .filter((call) => call.method === method)
        .map((call) => call.params),
    Wrapper: (props) => (
      <QueryClientProvider client={queryClient}>
        <ConfigurationSourceContext.Provider value={source}>
          {props.children}
        </ConfigurationSourceContext.Provider>
      </QueryClientProvider>
    ),
  };
}

export function resetTeamPageHarness(): void {
  teamHostBoundary.client = null;
  useAuthStore.setState({ status: "signed-out" });
}
