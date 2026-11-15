import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { createHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  HostMethodVersionUnsatisfiedError,
  type HostRequestOptions,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import { negotiatedVersionMeetsRequirement } from "@traycer/protocol/host-transport/remote/rpc-types";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import {
  ConfigurationSourceContext,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { grantedEnvironmentRole } from "@traycer/protocol/host/environment/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { HostRuntimeContext } from "@/lib/host/runtime";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createFakeEnvironmentCloudAuth,
  createFakeEnvironmentCloudTransport,
  jsonEnvironmentAnswer,
} from "../../../../../__tests__/create-fake-runner-host";

/**
 * The shared host client a page under test reads through `useHostClient()`.
 * Each test file points `@/lib/host`'s `useHostClient` here, so the queries,
 * mutations and cache beneath it stay real.
 */
export const teamHostBoundary: {
  client: HostClient<HostRpcRegistry> | null;
} = { client: null };

/**
 * The client of a second host (`mockRemoteHostEntry`) over the same messenger:
 * a page that resolves its viewing host through `useHostClientForHostId`
 * reaches this one, so a request's recorded host says which client sent it.
 */
export const viewingHostBoundary: {
  client: HostClient<HostRpcRegistry> | null;
} = { client: null };

/**
 * The host this window runs on, as `usePersonalHostScope()` reports it. A
 * test file that renders a page reading it points that hook here with
 * `windowHostScopeMock`; `null` is a window with no host of its own.
 */
export const windowHostBoundary: { hostId: string | null } = { hostId: null };

export function windowHostScopeMock(): { hostId: string | null } {
  return { hostId: windowHostBoundary.hostId };
}

export function requireViewingHostClient(): HostClient<HostRpcRegistry> {
  if (viewingHostBoundary.client === null) {
    throw new Error("no viewing host client mounted");
  }
  return viewingHostBoundary.client;
}

export function requireTeamHostClient(): HostClient<HostRpcRegistry> {
  if (teamHostBoundary.client === null) {
    throw new Error("no team host client mounted");
  }
  return teamHostBoundary.client;
}

/**
 * `effectiveRole` is the wire's spelling. `"viewer"` is the retired role, and
 * the source it yields holds none, exactly as an inventory row naming it
 * decodes in the app.
 */
export function poolSource(
  effectiveRole: "owner" | "admin" | "editor" | "viewer",
): ConfigurationSource {
  return {
    kind: "pool",
    configuration: "team",
    environmentId: "env-a",
    roomId: "room-a",
    providerHandle: "handle-a",
    effectiveRole: grantedEnvironmentRole(effectiveRole),
  };
}

/** Personal read from the cloud: the user-owned environment, as its owner. */
export function personalPoolSource(): ConfigurationSource {
  return {
    kind: "pool",
    configuration: "personal",
    environmentId: "env-personal",
    roomId: "room-personal",
    providerHandle: null,
    effectiveRole: "owner",
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
  return buildTeamPage(source, handlers, null, false);
}

/**
 * A build that has a server pool: the client applies the real routing table,
 * so a pool-only method is sent to the pool and a host method to the window's
 * host (and refused if it were sent as the pool). The caller settles the
 * process plan with the same pool entry (`poolEntry`) before mounting.
 */
export function mountTeamPageOnPoolBuild(
  source: ConfigurationSource,
  handlers: MockHandlerMap<HostRpcRegistry>,
): TeamPageHarness {
  return buildTeamPage(source, handlers, null, true);
}

/** The host id each request for `method` was sent to, in order. */
export function hostIdsOf(harness: TeamPageHarness, method: string): string[] {
  return harness.messenger.calls
    .filter((call) => call.method === method)
    .map((call) => call.authority.endpoint.hostId);
}

async function answerEnvironmentReadFromHandlers(
  request: EnvironmentTransportRequest,
  handlers: MockHandlerMap<HostRpcRegistry>,
): Promise<EnvironmentTransportAnswer | null> {
  if (request.method !== "GET") return null;

  const url = new URL(request.url);
  const match = /\/api\/v3\/environments\/([^/]+)\/(.+)$/u.exec(url.pathname);
  if (match === null) return null;

  const environmentId = decodeURIComponent(match[1] ?? "");
  switch (match[2]) {
    case "items": {
      const response = await handlers["environment.configuration.items"]?.({
        environmentId,
      });
      if (response === undefined) return null;
      const kind = url.searchParams.get("kind");
      return jsonEnvironmentAnswer({
        items: response.items.filter((item) => item.kind === kind),
      });
    }
    case "revision": {
      const response = await handlers["environment.configuration.revision"]?.({
        environmentId,
      });
      return response === undefined
        ? null
        : jsonEnvironmentAnswer({ revision: response.revision });
    }
    case "mcp-servers": {
      const response = await handlers[
        "environment.configuration.mcpServers.list"
      ]?.({ environmentId });
      return response === undefined ? null : jsonEnvironmentAnswer(response);
    }
    case "secrets": {
      const response = await handlers["environment.secrets.list"]?.({});
      if (response === undefined) return null;
      return jsonEnvironmentAnswer({
        secrets: response.secrets.map((secret) => ({
          id: secret.secretId,
          name: secret.name,
          kind: secret.kind,
          protocol: secret.protocol ?? secret.kind,
          hosts: secret.destinations,
          currentVersionId: secret.currentVersionId ?? secret.secretId,
          updatedAt: secret.updatedAt,
          variables: secret.variables.map((name) => ({ name })),
        })),
        removed: response.removed,
      });
    }
    case "secrets/harness-connections": {
      const response = await handlers["environment.plans.list"]?.({
        environmentId,
      });
      if (response === undefined) return null;
      return jsonEnvironmentAnswer({
        connections: response.plans.map((plan) => ({
          profileId: plan.profileId,
          harnessId: plan.harness,
          bindingVersion: plan.bindingVersion ?? null,
          kind: plan.harness === "api_key" ? "api_key" : "harness",
          status:
            plan.status === "linked"
              ? "connected"
              : plan.status === "empty"
                ? "absent"
                : plan.status,
          linkedBy:
            plan.linkedBy === null
              ? null
              : {
                  displayName: plan.linkedBy.name,
                  you: plan.linkedBy.you,
                },
        })),
      });
    }
    case "hosts": {
      if (!url.searchParams.has("include")) return null;
      const response = await handlers["environment.host.list"]?.({
        environmentId,
      });
      if (response === undefined) return null;
      return jsonEnvironmentAnswer({
        hosts: response.hosts.map((host) => ({
          hostId: host.hostId,
          hostName: host.hostLabel,
          hostPlatform: host.hostPlatform,
          enrolledByUserId: host.enrolledByUserId,
          hostKind: host.kind,
          boundAt: host.boundAt,
          reportedAt: host.lastReportedAt,
          online: host.reachable,
          purgePending: false,
          hasLocalRow: host.hasLocalRow,
          items: host.applied.map((item) => {
            const separator = item.itemKey.indexOf(":");
            return {
              kind:
                separator < 0 ? item.itemKey : item.itemKey.slice(0, separator),
              key: separator < 0 ? "" : item.itemKey.slice(separator + 1),
              status:
                item.state === "applied"
                  ? "applied"
                  : item.state === "not_applied"
                    ? "failed"
                    : "pending",
              code: item.reason ?? "ok",
            };
          }),
        })),
      });
    }
    default:
      return null;
  }
}

/**
 * A host whose connection negotiated `negotiated` for a method: a request that
 * carries a higher version floor for that method is refused before anything is
 * sent, as the real transport does. Methods not listed negotiate whatever the
 * request asks.
 */
export function mountTeamPageNegotiating(
  source: ConfigurationSource,
  handlers: MockHandlerMap<HostRpcRegistry>,
  negotiated: Readonly<Record<string, { major: number; minor: number }>>,
): TeamPageHarness {
  return buildTeamPage(source, handlers, negotiated, false);
}

class FloorEnforcingMessenger extends MockHostMessenger<HostRpcRegistry> {
  constructor(
    options: ConstructorParameters<
      typeof MockHostMessenger<HostRpcRegistry>
    >[0],
    private readonly negotiated: Readonly<
      Record<string, { major: number; minor: number }>
    >,
  ) {
    super(options);
  }

  override request<Method extends keyof HostRpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<HostRpcRegistry, Method>,
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
    const floor = options.requiredHostMethodVersion;
    const have = Object.entries(this.negotiated).find(
      ([name]) => name === method,
    )?.[1];
    if (
      floor !== null &&
      have !== undefined &&
      !negotiatedVersionMeetsRequirement(have, floor)
    ) {
      return Promise.reject(
        new HostMethodVersionUnsatisfiedError({
          requirement: floor,
          negotiated: have,
          requestId: "req-floor",
          method,
          hostId: mockLocalHostEntry.hostId,
        }),
      );
    }
    return super.request(method, params, options);
  }
}

function buildTeamPage(
  source: ConfigurationSource,
  handlers: MockHandlerMap<HostRpcRegistry>,
  negotiated: Readonly<Record<string, { major: number; minor: number }>> | null,
  withPool: boolean,
): TeamPageHarness {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const fallbackRows: EnvironmentDescriptorV11[] =
    source.kind === "pool"
      ? [
          {
            environmentId: source.environmentId,
            ownerKind:
              source.configuration === "personal" ? "user" : "organization",
            ownerId: source.configuration === "personal" ? "user-me" : "team-a",
            roomId: source.roomId,
            label: source.configuration === "personal" ? "Personal" : "Acme",
            effectiveRole:
              source.configuration === "personal"
                ? "owner"
                : (source.effectiveRole ?? "viewer"),
            kind: source.configuration,
            hostCount: 1,
            providerHandle: source.providerHandle,
          },
        ]
      : [];
  let currentRows: EnvironmentDescriptorV11[] = [...fallbackRows];
  const auth = createFakeEnvironmentCloudAuth({
    listEnvironments: async () => {
      const response = await handlers["environment.list"]?.({});
      if (response !== undefined) currentRows = [...response.environments];
      return { kind: "ok", list: { environments: [...currentRows] } };
    },
    transport: createFakeEnvironmentCloudTransport({
      environments: () => currentRows,
      onRequest: (request) =>
        answerEnvironmentReadFromHandlers(request, handlers),
    }),
  });
  const authBinding = Object.create(
    null,
  ) as HostRuntimeBinding<HostRpcRegistry>;
  Object.defineProperty(authBinding, "auth", { value: auth });
  let requestCounter = 0;
  const messengerOptions = {
    registry: hostRpcRegistry,
    requestId: () => {
      requestCounter += 1;
      return `req-team-${String(requestCounter)}`;
    },
    handlers,
  };
  const messenger =
    negotiated === null
      ? new MockHostMessenger<HostRpcRegistry>(messengerOptions)
      : new FloorEnforcingMessenger(messengerOptions, negotiated);
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => {
      if (hostId === mockLocalHostEntry.hostId) return mockLocalHostEntry;
      if (hostId === mockRemoteHostEntry.hostId) return mockRemoteHostEntry;
      return withPool && hostId === poolEntry.hostId ? poolEntry : null;
    },
    messenger,
    ...(withPool
      ? {
          routing: {
            plan: createHostRpcTierPlan(poolEntry),
            selectedHostId: () => null,
          },
        }
      : {}),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  teamHostBoundary.client = spine.createRequester(mockLocalHostEntry);
  viewingHostBoundary.client = spine.createRequester(mockRemoteHostEntry);
  useAuthStore.setState({
    status: "signed-in",
    shareableTeams: [
      {
        teamId: "team-a",
        slug:
          source.kind === "pool" && source.configuration === "team"
            ? (source.providerHandle ?? "handle-a")
            : "handle-a",
        avatarUrl: null,
      },
    ],
  });
  return {
    messenger,
    queryClient,
    paramsOf: (method) =>
      messenger.calls
        .filter((call) => call.method === method)
        .map((call) => call.params),
    Wrapper: (props) => (
      <QueryClientProvider client={queryClient}>
        <HostRuntimeContext.Provider value={authBinding}>
          <ConfigurationSourceContext.Provider value={source}>
            {props.children}
          </ConfigurationSourceContext.Provider>
        </HostRuntimeContext.Provider>
      </QueryClientProvider>
    ),
  };
}

export function resetTeamPageHarness(): void {
  teamHostBoundary.client = null;
  viewingHostBoundary.client = null;
  windowHostBoundary.hostId = null;
  useAuthStore.setState({ status: "signed-out", shareableTeams: [] });
}
