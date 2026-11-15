import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
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
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostMethodVersionUnsatisfiedError,
  type HostRequestOptions,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { negotiatedVersionMeetsRequirement } from "@traycer/protocol/host-transport/remote/rpc-types";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import {
  ConfigurationSourceContext,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { grantedEnvironmentRole } from "@traycer/protocol/host/environment/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { AuthService } from "@/lib/auth/auth-service";
import { createAuthBoundHostDirectory } from "@/lib/host/auth-bound-host-directory";
import type { HostDirectoryService } from "@/lib/host/host-directory-service";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { HostRuntimeContext } from "@/lib/host/runtime";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

export interface TeamProfileRecordHttpRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string | null;
}

export interface TeamProviderKeyHttpRequest {
  readonly action: "set" | "clear";
  readonly routeMatches: boolean;
  readonly authorized: boolean;
  readonly keyMatches: boolean | null;
}

export interface TeamProfileRecordHttpAnswer {
  readonly status: number;
  readonly body: unknown;
}

export interface TeamProfileRecordWireRow {
  readonly profileId: string;
  readonly harnessId: string;
  readonly name: string;
  readonly color: string | null;
  readonly enabled: boolean;
  readonly kind: string | null;
  readonly readerLabel: "live" | "waiting" | "needs-sign-in";
  readonly otherNames: readonly string[];
}

export type TeamProfileRecordListBody =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly records: readonly TeamProfileRecordWireRow[];
    };

export const teamProfileRecordHttpBoundary: {
  list: TeamProfileRecordHttpAnswer & { body: TeamProfileRecordListBody };
  items: TeamProfileRecordHttpAnswer;
  action: TeamProfileRecordHttpAnswer;
  itemWriteStatus: number;
  calls: TeamProfileRecordHttpRequest[];
} = {
  list: { status: 200, body: { enabled: false } },
  items: { status: 200, body: { items: [] } },
  action: {
    status: 200,
    body: {
      profileId: "team-profile",
      harnessId: "claude",
      recordRevision: "1",
    },
  },
  itemWriteStatus: 200,
  calls: [],
};

export const teamProviderKeyHttpBoundary: {
  status: number;
  matchesKey: (key: string) => boolean;
  calls: TeamProviderKeyHttpRequest[];
} = {
  status: 200,
  matchesKey: () => false,
  calls: [],
};

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
  readonly auth: AuthService;
  readonly runnerHost: MockRunnerHost;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  /** The params of every request the host received for `method`, in order. */
  readonly paramsOf: (method: string) => unknown[];
}

interface TeamAuthRuntime {
  readonly auth: AuthService;
  readonly directory: HostDirectoryService;
  readonly runtime: HostRuntime<HostRpcRegistry>;
  readonly runnerHost: MockRunnerHost;
  readonly binding: HostRuntimeBinding<HostRpcRegistry>;
}

const activeTeamAuthRuntimes: TeamAuthRuntime[] = [];
let restoreTeamFetch: (() => void) | null = null;

function installTeamFetch(): void {
  if (restoreTeamFetch !== null) return;
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: RequestInfo | URL, init: RequestInit | undefined) =>
      teamFetch(input, init),
  });
  restoreTeamFetch = () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

function teamFetchUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function providerKeyMatchesBody(body: string | null): boolean | null {
  if (body === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "key" in parsed &&
    typeof parsed.key === "string"
  ) {
    return teamProviderKeyHttpBoundary.matchesKey(parsed.key);
  }
  return null;
}

function handleProviderKeyTransport(
  url: URL,
  method: string,
  headers: Headers,
  body: string | null,
): Promise<Response> | null {
  if (!url.pathname.includes("/provider-keys/")) return null;
  const action = method === "PUT" ? "set" : "clear";
  const keyMatches = action === "set" ? providerKeyMatchesBody(body) : null;
  teamProviderKeyHttpBoundary.calls.push({
    action,
    routeMatches:
      url.pathname === "/api/v3/environments/env-a/provider-keys/cursor" &&
      method === (action === "set" ? "PUT" : "DELETE"),
    authorized: headers.get("authorization") === "Bearer team-test-app-session",
    keyMatches,
  });
  if (teamProviderKeyHttpBoundary.status !== 200) {
    return Promise.resolve(
      new Response(null, { status: teamProviderKeyHttpBoundary.status }),
    );
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        profileId: "team-provider-key-record",
        providerId: "cursor",
        state: action === "set" ? "live" : "removed",
        signInNumber: "3",
        recordRevision: "5",
        personIntentNumber: "2",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

function teamFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const url = teamFetchUrl(input);
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === "string" ? init.body : null;
  const providerKeyResponse = handleProviderKeyTransport(
    url,
    method,
    headers,
    body,
  );
  if (providerKeyResponse !== null) return providerKeyResponse;
  teamProfileRecordHttpBoundary.calls.push({
    url: url.toString(),
    method,
    authorization: headers.get("authorization"),
    body,
  });
  if (url.pathname === "/api/v3/user/negotiated")
    return Promise.resolve(
      new Response(
        JSON.stringify({
          user: {
            id: "team-test-user",
            name: "Team Test User",
            providerId: "team-test-provider",
            providerHandle: "team-test-handle",
            providerType: "GITHUB",
            email: "team-test@example.invalid",
            avatarUrl: null,
            activatedAt: null,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            lastSeenAt: null,
            privacyMode: false,
            isLearningEnabled: true,
          },
          userSubscription: {
            id: "team-test-subscription",
            userID: "team-test-user",
            orgID: null,
            teamID: null,
            customerId: "team-test-customer",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            subscriptionExpiry: null,
            trialEndsAt: null,
            subscriptionStatus: "FREE",
            hasPaymentMethod: false,
            isInTrial: false,
            rechargeRateSeconds: 0,
          },
          teamSubscriptions: [],
          payAsYouGoUsage: { allowPayAsYouGo: false },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-traycer-user-record-version": "2.0",
          },
        },
      ),
    );
  if (url.pathname.endsWith("/profile-records"))
    return teamHttpResponse(teamProfileRecordHttpBoundary.list);
  if (url.pathname.includes("/profile-records/"))
    return teamHttpResponse(teamProfileRecordHttpBoundary.action);
  if (url.pathname.endsWith("/items/managed_profile"))
    return Promise.resolve(
      new Response(null, {
        status: teamProfileRecordHttpBoundary.itemWriteStatus,
      }),
    );
  if (url.pathname.endsWith("/items"))
    return teamHttpResponse(teamProfileRecordHttpBoundary.items);
  return Promise.resolve(new Response(null, { status: 500 }));
}

function teamHttpResponse(
  answer: TeamProfileRecordHttpAnswer,
): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function buildTeamAuthRuntime(queryClient: QueryClient): TeamAuthRuntime {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const auth = new AuthService({ runnerHost });
  const directory = createAuthBoundHostDirectory({
    auth,
    runnerHost,
    remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
    localHostIdSeeder: () => Promise.resolve(null),
    onRegistryPollTick: null,
  });
  let requestId = 0;
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `team-auth-${++requestId}`,
      handlers: {},
    }),
    requestContextProvider: auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
    selectedHostId: () => null,
    connectionRegistry: null,
  });
  const binding: HostRuntimeBinding<HostRpcRegistry> = {
    runtime,
    hostClient: runtime.hostClient,
    directory,
    auth,
    hostId: null,
  };
  const harness = { auth, directory, runtime, runnerHost, binding };
  activeTeamAuthRuntimes.push(harness);
  return harness;
}

async function startVerifiedTeamAuth(harness: TeamAuthRuntime): Promise<void> {
  await harness.runnerHost.tokenStore.signIn(
    { token: "team-test-app-session", refreshToken: "team-test-refresh" },
    {
      id: "team-test-user",
      email: "team-test@example.invalid",
      name: "Team Test User",
    },
  );
  await harness.auth.start();
}

export function mountTeamPage(
  source: ConfigurationSource,
  handlers: MockHandlerMap<HostRpcRegistry>,
): TeamPageHarness {
  return buildTeamPage(source, handlers, null, false);
}

export function mountTeamPageWithRealBoundary(
  handlers: MockHandlerMap<HostRpcRegistry>,
): TeamPageHarness {
  return buildTeamPage(null, handlers, null, false);
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
  source: ConfigurationSource | null,
  handlers: MockHandlerMap<HostRpcRegistry>,
  negotiated: Readonly<Record<string, { major: number; minor: number }>> | null,
  withPool: boolean,
): TeamPageHarness {
  installTeamFetch();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
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
  useAuthStore.setState({ status: "signed-out" });
  const authHarness = buildTeamAuthRuntime(queryClient);
  void startVerifiedTeamAuth(authHarness);
  return {
    messenger,
    queryClient,
    auth: authHarness.auth,
    runnerHost: authHarness.runnerHost,
    paramsOf: (method) =>
      messenger.calls
        .filter((call) => call.method === method)
        .map((call) => call.params),
    Wrapper: (props) => (
      <RunnerHostProvider runnerHost={authHarness.runnerHost}>
        <HostRuntimeContext.Provider value={authHarness.binding}>
          <QueryClientProvider client={queryClient}>
            {source === null ? (
              props.children
            ) : (
              <ConfigurationSourceContext.Provider value={source}>
                {props.children}
              </ConfigurationSourceContext.Provider>
            )}
          </QueryClientProvider>
        </HostRuntimeContext.Provider>
      </RunnerHostProvider>
    ),
  };
}

export function resetTeamPageHarness(): void {
  for (const harness of activeTeamAuthRuntimes.splice(0)) {
    harness.runtime.dispose();
    harness.directory.dispose();
    harness.auth.dispose();
  }
  restoreTeamFetch?.();
  restoreTeamFetch = null;
  teamHostBoundary.client = null;
  viewingHostBoundary.client = null;
  windowHostBoundary.hostId = null;
  useAuthStore.setState({ status: "signed-out" });
  teamProfileRecordHttpBoundary.list = {
    status: 200,
    body: { enabled: false },
  };
  teamProfileRecordHttpBoundary.items = { status: 200, body: { items: [] } };
  teamProfileRecordHttpBoundary.action = {
    status: 200,
    body: {
      profileId: "team-profile",
      harnessId: "claude",
      recordRevision: "1",
    },
  };
  teamProfileRecordHttpBoundary.itemWriteStatus = 200;
  teamProfileRecordHttpBoundary.calls.length = 0;
  teamProviderKeyHttpBoundary.status = 200;
  teamProviderKeyHttpBoundary.matchesKey = () => false;
  teamProviderKeyHttpBoundary.calls.length = 0;
}
