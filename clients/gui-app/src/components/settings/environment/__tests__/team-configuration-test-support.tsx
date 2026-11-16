import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
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
  EnvironmentCloud,
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { negotiatedVersionMeetsRequirement } from "@traycer/protocol/host-transport/remote/rpc-types";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import {
  environmentDescriptorSchemaV11,
  environmentListUpgradeV10ToV11,
  type EnvironmentDescriptorV11,
  type EnvironmentListResponse,
} from "@traycer/protocol/host/environment/contracts";
import {
  ConfigurationSourceContext,
  configurationRoleOf,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { HostRuntimeContext } from "@/lib/host/runtime";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import type { AuthService, ExternalSession } from "@/lib/auth/auth-service";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hashAppQueryKey } from "@/lib/query/query-key-hash";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createFakeEnvironmentCloudServices,
  createFakeEnvironmentCloudTransport,
} from "../../../../../__tests__/create-fake-runner-host";
import {
  createTeamEnvironmentCloudHandlers,
  type TeamEnvironmentCloudResponses,
} from "./team-environment-cloud-handlers";

/**
 * The shared host client a page under test reads through `useHostClient()`.
 * Each test file points `@/lib/host`'s `useHostClient` here, so the queries,
 * mutations and cache beneath it stay real.
 */
export const teamHostBoundary: {
  client: HostClient<HostRpcRegistry> | null;
  auth: AuthService | null;
  runtime: HostRuntime<HostRpcRegistry> | null;
  directory: HostDirectoryService | null;
  binding: HostRuntimeBinding<HostRpcRegistry> | null;
} = { client: null, auth: null, runtime: null, directory: null, binding: null };

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

let environmentCloudOverride: EnvironmentCloud | null = null;

export function setTeamEnvironmentCloudOverride(
  cloud: EnvironmentCloud | null,
): void {
  environmentCloudOverride = cloud;
}

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

export function requireTeamCloudAuth(): AuthService {
  if (teamHostBoundary.auth === null) {
    throw new Error("no team cloud auth mounted");
  }
  return teamHostBoundary.auth;
}

export function requireTeamHostBinding(): HostRuntimeBinding<HostRpcRegistry> {
  if (teamHostBoundary.binding === null) {
    throw new Error("no team host binding mounted");
  }
  return teamHostBoundary.binding;
}

export function requireTeamEnvironmentAuthnBinding(): HostRuntimeBinding<HostRpcRegistry> {
  return requireTeamHostBinding();
}
/**
 * `effectiveRole` is the wire's spelling; the source holds the role an
 * inventory row naming it decodes to in the app.
 */
export function poolSource(
  effectiveRole: "owner" | "admin" | "editor" | "viewer",
): ConfigurationSource {
  const descriptor: EnvironmentDescriptorV11 = {
    environmentId: "env-a",
    ownerKind: effectiveRole === "owner" ? "user" : "organization",
    ownerId: effectiveRole === "owner" ? "user-me" : "team-a",
    roomId: "room-a",
    label: effectiveRole === "owner" ? "Personal" : "Acme",
    effectiveRole,
    kind: effectiveRole === "owner" ? "personal" : "team",
    hostCount: 1,
    providerHandle: effectiveRole === "owner" ? null : "handle-a",
  };
  return {
    kind: "pool",
    configuration: "team",
    environmentId: "env-a",
    roomId: "room-a",
    providerHandle: "handle-a",
    effectiveRole: configurationRoleOf(descriptor),
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

export function authSessionForUser(
  userId: string,
  token: string,
): ExternalSession {
  const now = new Date("2026-07-30T10:00:00.000Z");
  return {
    status: "signed-in",
    token,
    profile: {
      userId,
      userName: `${userId} display`,
      email: `${userId}@example.com`,
      avatarUrl: null,
    },
    user: {
      user: {
        id: userId,
        name: `${userId} display`,
        providerId: `gh-${userId}`,
        providerHandle: userId,
        providerType: "GITHUB",
        email: `${userId}@example.com`,
        avatarUrl: null,
        activatedAt: null,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: null,
        privacyMode: false,
        isLearningEnabled: true,
      },
      userSubscription: {
        id: `sub-${userId}`,
        userID: userId,
        orgID: null,
        teamID: null,
        customerId: `cus-${userId}`,
        createdAt: now,
        updatedAt: now,
        subscriptionExpiry: null,
        trialEndsAt: null,
        subscriptionStatus: "FREE",
        hasPaymentMethod: false,
        isInTrial: false,
        rechargeRateSeconds: 0,
      },
      teamSubscriptions: [],
      payAsYouGoUsage: { allowPayAsYouGo: false },
      environments: { personal: null, teams: [] },
      actingAs: null,
    },
  };
}

export interface TeamPageHarness {
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly auth: AuthService;
  readonly cloudRequests: readonly EnvironmentTransportRequest[];
  readonly cloudResponses: TeamEnvironmentCloudResponses;
  /** The params of every request the host received for `method`, in order. */
  readonly paramsOf: (method: string) => unknown[];
}

export function rejectNextTeamEnvironmentItemPut(
  harness: TeamPageHarness,
  kind: string,
): EnvironmentTransportRequest[] {
  const cloud = harness.auth.environmentCloud();
  const rejectedRequests: EnvironmentTransportRequest[] = [];
  let rejectNextPut = true;
  harness.auth.environmentCloud = () => ({
    ...cloud,
    transport: async (request) => {
      if (
        rejectNextPut &&
        request.method === "PUT" &&
        new URL(request.url).pathname.endsWith(`/items/${kind}`)
      ) {
        rejectNextPut = false;
        rejectedRequests.push(request);
        throw new Error("The transport did not answer.");
      }
      return cloud.transport(request);
    },
  });
  return rejectedRequests;
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

/** authn's answer: a status and the body it sends with it. */
export function authnAnswer(
  status: number,
  body: unknown,
): EnvironmentTransportAnswer {
  return { status, text: JSON.stringify(body) };
}

/**
 * What authn answers the team's host list read for `environmentId` from now
 * on; `null` is no answer at all, as when the transport fails.
 */
export function answerTeamHostList(
  harness: TeamPageHarness,
  environmentId: string,
  answer: EnvironmentTransportAnswer | null,
): void {
  harness.cloudResponses.set(
    `GET /api/v3/environments/${encodeURIComponent(environmentId)}/hosts`,
    () => {
      if (answer === null) throw new Error("The transport did not answer.");
      return answer;
    },
  );
}

/** The host id each request for `method` was sent to, in order. */
export function hostIdsOf(harness: TeamPageHarness, method: string): string[] {
  return harness.messenger.calls
    .filter((call) => call.method === method)
    .map((call) => call.authority.endpoint.hostId);
}

function shareableTeamsFor(
  environments: readonly EnvironmentDescriptorV11[],
): { teamId: string; slug: string; avatarUrl: null }[] {
  return environments.flatMap((environment) =>
    environment.ownerKind === "organization" &&
    environment.providerHandle !== null
      ? [
          {
            teamId: environment.ownerId,
            slug: environment.providerHandle,
            avatarUrl: null,
          },
        ]
      : [],
  );
}

function descriptorFromEnvironmentList(
  environment: EnvironmentListResponse["environments"][number],
): EnvironmentDescriptorV11 {
  const parsed = environmentDescriptorSchemaV11.safeParse(environment);
  if (parsed.success) return parsed.data;
  const upgraded = environmentListUpgradeV10ToV11
    .upgradeResponse({
      environments: [environment],
    })
    .environments.at(0);
  if (upgraded === undefined) {
    throw new Error("the environment list upgrade returned no row");
  }
  return upgraded;
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
      queries: { queryKeyHashFn: hashAppQueryKey, retry: false, gcTime: 0 },
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
  const cloudHandlers = createTeamEnvironmentCloudHandlers(handlers, source);
  const { auth, runnerHost } = createFakeEnvironmentCloudServices({
    listEnvironments: async () => {
      const response = await cloudHandlers.listEnvironments();
      if (response?.kind === "ok") {
        currentRows = response.list.environments.map(
          descriptorFromEnvironmentList,
        );
        useAuthStore.setState({
          shareableTeams: shareableTeamsFor(currentRows),
        });
      }
      return response ?? { kind: "no_response" };
    },
    transport: createFakeEnvironmentCloudTransport({
      environments: () => currentRows,
      onRequest: cloudHandlers.onRequest,
    }),
    runnerHostOverrides: {},
  });
  const baseEnvironmentCloud = auth.environmentCloud.bind(auth);
  auth.environmentCloud = () =>
    environmentCloudOverride ?? baseEnvironmentCloud();
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
  const directory = new TeamPageHostDirectory(runnerHost, withPool);
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger,
    singleAttemptMessenger: null,
    requestContextProvider: auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
    connectionRegistry: null,
    selectedHostId: () => null,
    onHostTokenRenewal: () => undefined,
  });
  const spine = runtime.hostClient;
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  teamHostBoundary.client = spine.createRequester(mockLocalHostEntry);
  teamHostBoundary.auth = auth;
  teamHostBoundary.runtime = runtime;
  teamHostBoundary.directory = directory;
  const authBinding: HostRuntimeBinding<HostRpcRegistry> = {
    runtime,
    hostClient: spine,
    directory,
    auth,
    hostId: null,
  };
  teamHostBoundary.binding = authBinding;
  viewingHostBoundary.client = spine.createRequester(mockRemoteHostEntry);
  useAuthStore.setState({
    status: "signed-in",
    shareableTeams: shareableTeamsFor(currentRows),
  });
  return {
    messenger,
    queryClient,
    auth,
    cloudRequests: cloudHandlers.requests,
    cloudResponses: cloudHandlers.responses,
    paramsOf: (method) => [
      ...messenger.calls
        .filter((call) => call.method === method)
        .map((call) => call.params),
      ...cloudHandlers.calls
        .filter((call) => call.method === method)
        .map((call) => call.params),
    ],
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
  environmentCloudOverride = null;
  teamHostBoundary.runtime?.dispose();
  teamHostBoundary.directory?.dispose();
  teamHostBoundary.auth?.dispose();
  teamHostBoundary.client = null;
  teamHostBoundary.auth = null;
  teamHostBoundary.runtime = null;
  teamHostBoundary.directory = null;
  teamHostBoundary.binding = null;
  viewingHostBoundary.client = null;
  windowHostBoundary.hostId = null;
  useAuthStore.setState({ status: "signed-out", shareableTeams: [] });
}

class TeamPageHostDirectory extends HostDirectoryService {
  constructor(runnerHost: IRunnerHost, withPool: boolean) {
    super({
      runnerHost,
      remoteFetcher: null,
      onRegistryPollTick: null,
      authContextId: null,
      credentialGeneration: null,
      localHostIdSeeder: null,
    });
    this.withPool = withPool;
  }

  private readonly withPool: boolean;

  override list(): Promise<readonly HostDirectoryEntry[]> {
    return Promise.resolve([mockLocalHostEntry, mockRemoteHostEntry]);
  }

  override findById(hostId: string): HostDirectoryEntry | null {
    if (hostId === mockLocalHostEntry.hostId) return mockLocalHostEntry;
    if (hostId === mockRemoteHostEntry.hostId) return mockRemoteHostEntry;
    if (this.withPool && hostId === poolEntry.hostId) return poolEntry;
    return null;
  }
}
