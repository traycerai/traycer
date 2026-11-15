import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";
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
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
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
import { hostQueryKeys } from "@/lib/query-keys";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { HostRuntimeContext } from "@/lib/host/runtime";
import { useAuthStore } from "@/stores/auth/auth-store";
import { appLogger } from "@/lib/logger";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ConfigurationSourceBoundary } from "@/components/settings/environment/configuration-source-boundary";
import type { SettingsSectionId } from "@/lib/settings-sections";
import {
  noteLocalTeamAdmission,
  useLocalTeamAdmissionStore,
} from "@/stores/host/local-team-admission-store";

export interface TeamProfileRecordHttpRequest {
  readonly url: string;
  readonly method: string;
  readonly hasBearerAuthorization: boolean;
  readonly body: string | null;
}

export const TEAM_PROFILE_KEY_CANARY = "synthetic-profile-key";

export interface TeamProfileRecordHttpAnswer {
  readonly status: number;
  readonly body: unknown;
}

export interface DeferredTeamProfileRecordAnswer {
  readonly promise: Promise<TeamProfileRecordHttpAnswer>;
  readonly resolve: (answer: TeamProfileRecordHttpAnswer) => void;
}

export function deferTeamProfileRecordAnswer(): DeferredTeamProfileRecordAnswer {
  let resolveAnswer: ((answer: TeamProfileRecordHttpAnswer) => void) | null =
    null;
  const promise = new Promise<TeamProfileRecordHttpAnswer>((resolve) => {
    resolveAnswer = resolve;
  });
  return {
    promise,
    resolve: (answer) => {
      if (resolveAnswer === null)
        throw new Error("profile-record read was not initialized");
      resolveAnswer(answer);
    },
  };
}

export interface TeamProfileRecordWireRow {
  readonly profileId: string;
  readonly harnessId: string;
  readonly name: string;
  readonly color: string | null;
  readonly enabled: boolean;
  readonly kind:
    | "oauth_code"
    | "setup_token"
    | "device_auth"
    | "api_key"
    | "grok-oidc"
    | "antigravity-google"
    | null;
  readonly state: "live" | "signed-out-by-person" | "refused-by-provider";
  readonly custodyMode: "legacy" | "owned";
  readonly signInNumber: string;
  readonly renewalNumber: string;
  readonly recordRevision: string;
  readonly personIntentNumber: string;
  readonly expiresAt: number | null;
  readonly renewal: {
    readonly unsettledSince: number;
    readonly standing: "settling" | "lost";
  } | null;
  readonly readerLabel: "live" | "waiting" | "needs-sign-in";
  readonly otherNames: readonly string[];
}

export type TeamProfileRecordListBody =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly environmentRevision: string;
      readonly records: readonly TeamProfileRecordWireRow[];
      readonly removed: readonly [];
      readonly aliases: readonly [];
      readonly providerKeys: readonly [];
    };

export type TeamAwaitLoginWireAnswer = ResponseOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;
export type TeamStartLoginWireAnswer = ResponseOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;

const TEAM_SIGN_IN_OPERATION_ID = "11111111-1111-4111-8111-111111111111";

export function teamLoginStartedAnswer(): TeamStartLoginWireAnswer {
  return {
    url: "https://auth.traycer.invalid/sign-in",
    started: true,
    profileId: "team-created-profile",
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
    targetRefusal: null,
  };
}

export function teamAwaitLoginSignInRequestAnswer(): TeamAwaitLoginWireAnswer {
  return {
    state: null,
    existingProfileId: null,
    codeRejected: false,
    refusal: null,
    installation: null,
    profileOutcome: null,
    signInRequest: {
      operationId: TEAM_SIGN_IN_OPERATION_ID,
      environmentId: "env-a",
      sourceHostId: mockLocalHostEntry.hostId,
      sourceSharingGeneration: 1,
      harnessId: "claude",
    },
  };
}

export function teamAwaitLoginOutcomeAnswer(
  outcome: NonNullable<TeamAwaitLoginWireAnswer["profileOutcome"]>,
): TeamAwaitLoginWireAnswer {
  return {
    state: null,
    existingProfileId: null,
    codeRejected: false,
    refusal: null,
    installation: null,
    profileOutcome: outcome,
    signInRequest: null,
  };
}

export function teamProfileRecord(input: {
  readonly profileId: string;
  readonly harnessId: string;
  readonly name: string;
  readonly readerLabel: TeamProfileRecordWireRow["readerLabel"];
  readonly kind: TeamProfileRecordWireRow["kind"];
}): TeamProfileRecordWireRow {
  return {
    profileId: input.profileId,
    harnessId: input.harnessId,
    name: input.name,
    color: null,
    enabled: true,
    kind: input.kind,
    state: "live",
    custodyMode: "owned",
    signInNumber: "1",
    renewalNumber: "0",
    recordRevision: "1",
    personIntentNumber: "0",
    expiresAt: null,
    renewal: null,
    readerLabel: input.readerLabel,
    otherNames: [],
  };
}

export function teamProfileRecordsBody(
  records: readonly TeamProfileRecordWireRow[],
): TeamProfileRecordListBody {
  return {
    enabled: true,
    environmentRevision: "1",
    records,
    removed: [],
    aliases: [],
    providerKeys: [],
  };
}

export const teamProfileRecordHttpBoundary: {
  list: TeamProfileRecordHttpAnswer;
  nextListAnswer: DeferredTeamProfileRecordAnswer | null;
  items: TeamProfileRecordHttpAnswer;
  action: TeamProfileRecordHttpAnswer;
  keyAction: TeamProfileRecordHttpAnswer;
  connections: TeamProfileRecordHttpAnswer;
  replaceKey: TeamProfileRecordHttpAnswer;
  signInIntent: TeamProfileRecordHttpAnswer;
  itemWriteStatus: number;
  keyCanaryForwarded: boolean;
  calls: TeamProfileRecordHttpRequest[];
} = {
  list: { status: 200, body: { enabled: false } },
  nextListAnswer: null,
  items: { status: 200, body: { items: [] } },
  action: {
    status: 200,
    body: {
      profileId: "team-profile",
      harnessId: "claude",
      recordRevision: "1",
    },
  },
  keyAction: {
    status: 200,
    body: {
      profileId: "team-key-profile",
      providerId: "cursor",
      state: "removed",
      signInNumber: "1",
      recordRevision: "2",
      personIntentNumber: "1",
    },
  },
  connections: {
    status: 200,
    body: {
      connections: [{ profileId: "team-api-key", bindingVersion: 4 }],
    },
  },
  replaceKey: {
    status: 200,
    body: {
      profileId: "team-api-key",
      harnessId: "claude",
      kind: "api_key",
      status: "connected",
    },
  },
  signInIntent: {
    status: 200,
    body: { operationId: TEAM_SIGN_IN_OPERATION_ID, endsAt: 1 },
  },
  itemWriteStatus: 200,
  keyCanaryForwarded: false,
  calls: [],
};

export function teamProfileRecordReadCount(): number {
  return teamProfileRecordHttpBoundary.calls.filter(
    (call) =>
      call.url.endsWith("/api/v3/environments/env-a/profile-records") &&
      call.method === "GET",
  ).length;
}

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

export type TeamPageRole = "owner" | "admin" | "editor" | "viewer";

export interface TeamBoundaryPageHarness extends TeamPageHarness {
  readonly environmentListState: { currentRole: TeamPageRole };
  readonly rereadEnvironmentList: () => Promise<void>;
}

export function recordAppLoggerCalls(): () => string {
  const debug = vi.spyOn(appLogger, "debug");
  const info = vi.spyOn(appLogger, "info");
  const warn = vi.spyOn(appLogger, "warn");
  const error = vi.spyOn(appLogger, "error");
  const errorSummary = vi.spyOn(appLogger, "errorSummary");
  return () =>
    JSON.stringify(
      {
        debug: debug.mock.calls,
        info: info.mock.calls,
        warn: warn.mock.calls,
        error: error.mock.calls,
        errorSummary: errorSummary.mock.calls,
      },
      (_key, value: unknown) =>
        value instanceof Error
          ? { name: value.name, message: value.message }
          : value,
    );
}

export function teamPageCachedErrorValues(harness: TeamPageHarness): string[] {
  const errors = [
    ...harness.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.error),
    ...harness.queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.error),
  ];
  return errors.map((error) =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
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

function teamFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const url = teamRequestUrl(input);
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  const rawBody = typeof init?.body === "string" ? init.body : null;
  if (
    url.pathname.includes("/harness-connections/") &&
    url.pathname.endsWith("/connect") &&
    rawBody !== null
  ) {
    teamProfileRecordHttpBoundary.keyCanaryForwarded = rawBody.includes(
      TEAM_PROFILE_KEY_CANARY,
    );
  }
  const omitBody =
    (url.pathname.includes("/harness-connections/") &&
      url.pathname.endsWith("/connect")) ||
    url.pathname.endsWith("/profile-records/intents");
  const body = omitBody ? null : rawBody;
  teamProfileRecordHttpBoundary.calls.push({
    url: url.toString(),
    method,
    hasBearerAuthorization:
      headers.get("authorization")?.startsWith("Bearer ") === true,
    body,
  });
  return (
    teamAuthnResponse(url) ??
    Promise.resolve(new Response(null, { status: 500 }))
  );
}

function teamRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function teamAuthnResponse(url: URL): Promise<Response> | null {
  if (url.pathname === "/api/v3/user/negotiated")
    return teamNegotiatedUserResponse();
  if (url.pathname.endsWith("/profile-records")) {
    const nextListAnswer = teamProfileRecordHttpBoundary.nextListAnswer;
    teamProfileRecordHttpBoundary.nextListAnswer = null;
    if (nextListAnswer !== null)
      return nextListAnswer.promise.then(teamHttpResponse);
    return teamHttpResponse(teamProfileRecordHttpBoundary.list);
  }
  if (url.pathname.endsWith("/profile-records/intents"))
    return teamHttpResponse(teamProfileRecordHttpBoundary.signInIntent);
  if (url.pathname.includes("/profile-records/"))
    return teamHttpResponse(teamProfileRecordHttpBoundary.action);
  if (url.pathname.endsWith("/provider-keys/cursor"))
    return teamHttpResponse(teamProfileRecordHttpBoundary.keyAction);
  if (url.pathname.endsWith("/harness-connections"))
    return teamHttpResponse(teamProfileRecordHttpBoundary.connections);
  if (
    url.pathname.includes("/harness-connections/") &&
    url.pathname.endsWith("/connect")
  )
    return teamHttpResponse(teamProfileRecordHttpBoundary.replaceKey);
  if (url.pathname.endsWith("/items/managed_profile"))
    return Promise.resolve(
      new Response(null, {
        status: teamProfileRecordHttpBoundary.itemWriteStatus,
      }),
    );
  if (url.pathname.endsWith("/items"))
    return teamHttpResponse(teamProfileRecordHttpBoundary.items);
  return null;
}

function teamNegotiatedUserResponse(): Promise<Response> {
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
  return buildTeamPage({
    source,
    handlers,
    negotiated: null,
    withPool: false,
    boundarySection: null,
    boundaryTarget: null,
    pinBoundaryWindowHost: false,
  });
}

export function mountVerifiedTeamProvidersPage(
  source: ConfigurationSource,
  handlers: MockHandlerMap<HostRpcRegistry>,
): TeamPageHarness {
  return buildVerifiedTeamProvidersPage({
    source,
    handlers,
    negotiated: null,
    withPool: false,
    boundarySection: null,
    boundaryTarget: null,
    pinBoundaryWindowHost: false,
  });
}

type TeamPageBoundaryTarget =
  | { readonly kind: "team"; readonly environmentId: string }
  | { readonly kind: "personal" };

/** Renders a team Providers surface through the real cloud boundary. */
export function mountTeamPageThroughBoundary(
  role: TeamPageRole,
  handlers: MockHandlerMap<HostRpcRegistry>,
  section: SettingsSectionId,
): TeamBoundaryPageHarness {
  const environmentListState = { currentRole: role };
  const harness = buildVerifiedTeamProvidersPage({
    source: poolSource(role),
    handlers: {
      ...handlers,
      "environment.list": () =>
        teamEnvironmentList(environmentListState.currentRole),
    },
    negotiated: null,
    withPool: false,
    boundarySection: section,
    boundaryTarget: { kind: "team", environmentId: "env-a" },
    pinBoundaryWindowHost: true,
  });
  return {
    ...harness,
    environmentListState,
    rereadEnvironmentList: async () => {
      await harness.queryClient.refetchQueries({
        queryKey: hostQueryKeys.methodScope(
          mockLocalHostEntry.hostId,
          "environment.list",
        ),
      });
    },
  };
}

function teamEnvironmentList(role: TeamPageRole): EnvironmentListResponseV11 {
  return {
    environments: [
      {
        environmentId: "env-a",
        ownerKind: "organization",
        ownerId: "team-a",
        roomId: "room-a",
        label: "Acme",
        effectiveRole: role,
        kind: "team",
        hostCount: 1,
        providerHandle: "handle-a",
      },
    ],
  };
}

export function mountPersonalProvidersThroughBoundary(
  handlers: MockHandlerMap<HostRpcRegistry>,
): TeamPageHarness {
  const list: EnvironmentListResponseV11 = {
    environments: [
      {
        environmentId: "env-personal",
        ownerKind: "user",
        ownerId: "team-test-user",
        roomId: "room-personal",
        label: "Personal",
        effectiveRole: "owner",
        kind: "personal",
        hostCount: 1,
        providerHandle: null,
      },
      {
        environmentId: "env-a",
        ownerKind: "organization",
        ownerId: "team-a",
        roomId: "room-a",
        label: "Acme",
        effectiveRole: "admin",
        kind: "team",
        hostCount: 1,
        providerHandle: "handle-a",
      },
    ],
  };
  return buildVerifiedTeamProvidersPage({
    source: personalPoolSource(),
    handlers: { ...handlers, "environment.list": () => list },
    negotiated: null,
    withPool: false,
    boundarySection: "providers",
    boundaryTarget: { kind: "personal" },
    pinBoundaryWindowHost: true,
  });
}

export function admitCurrentUserToTeamWindow(): void {
  const userId = useAuthStore.getState().contextMetadata?.userId;
  if (userId === undefined) {
    throw new Error("team window admission requires a signed-in test user");
  }
  noteLocalTeamAdmission(mockLocalHostEntry.hostId, userId, "admitted");
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
  return buildTeamPage({
    source,
    handlers,
    negotiated: null,
    withPool: true,
    boundarySection: null,
    boundaryTarget: null,
    pinBoundaryWindowHost: false,
  });
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
  return buildTeamPage({
    source,
    handlers,
    negotiated,
    withPool: false,
    boundarySection: null,
    boundaryTarget: null,
    pinBoundaryWindowHost: false,
  });
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

interface TeamPageBuildOptions {
  readonly source: ConfigurationSource;
  readonly handlers: MockHandlerMap<HostRpcRegistry>;
  readonly negotiated: Readonly<
    Record<string, { major: number; minor: number }>
  > | null;
  readonly withPool: boolean;
  readonly boundarySection: SettingsSectionId | null;
  readonly boundaryTarget: TeamPageBoundaryTarget | null;
  readonly pinBoundaryWindowHost: boolean;
}

interface TeamPageAssembly {
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly auth: AuthService;
  readonly runnerHost: MockRunnerHost;
  readonly paramsOf: (method: string) => unknown[];
  readonly binding: HostRuntimeBinding<HostRpcRegistry>;
}

function buildTeamPage(options: TeamPageBuildOptions): TeamPageHarness {
  const queryClient = createTeamPageQueryClient();
  useAuthStore.setState({ status: "signed-in" });
  useLocalTeamAdmissionStore.setState({ byHost: new Map() });
  const authHarness = buildTeamAuthRuntime(queryClient);
  const assembly = assembleTeamPage(
    { ...options, pinBoundaryWindowHost: true },
    queryClient,
    authHarness,
  );
  return createTeamPageHarness(assembly, (props) => (
    <HostRuntimeContext.Provider value={assembly.binding}>
      <QueryClientProvider client={queryClient}>
        <ConfigurationSourceContext.Provider value={options.source}>
          {props.children}
        </ConfigurationSourceContext.Provider>
      </QueryClientProvider>
    </HostRuntimeContext.Provider>
  ));
}

function buildVerifiedTeamProvidersPage(
  options: TeamPageBuildOptions,
): TeamPageHarness {
  installTeamFetch();
  const queryClient = createTeamPageQueryClient();
  useAuthStore.setState({ status: "signed-out" });
  useLocalTeamAdmissionStore.setState({ byHost: new Map() });
  const authHarness = buildTeamAuthRuntime(queryClient);
  void startVerifiedTeamAuth(authHarness);
  const assembly = assembleTeamPage(options, queryClient, authHarness);
  return createTeamPageHarness(assembly, (props) => (
    <RunnerHostProvider runnerHost={assembly.runnerHost}>
      <HostRuntimeContext.Provider value={assembly.binding}>
        <QueryClientProvider client={queryClient}>
          {renderConfigurationSource(options, props.children)}
        </QueryClientProvider>
      </HostRuntimeContext.Provider>
    </RunnerHostProvider>
  ));
}

function createTeamPageQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function createTeamPageHarness(
  assembly: TeamPageAssembly,
  Wrapper: TeamPageHarness["Wrapper"],
): TeamPageHarness {
  return {
    messenger: assembly.messenger,
    queryClient: assembly.queryClient,
    auth: assembly.auth,
    runnerHost: assembly.runnerHost,
    paramsOf: assembly.paramsOf,
    Wrapper,
  };
}

function renderConfigurationSource(
  options: TeamPageBuildOptions,
  children: ReactNode,
): ReactNode {
  if (options.boundarySection === null || options.boundaryTarget === null) {
    return (
      <ConfigurationSourceContext.Provider value={options.source}>
        {children}
      </ConfigurationSourceContext.Provider>
    );
  }
  return (
    <ConfigurationSourceBoundary
      target={options.boundaryTarget}
      section={options.boundarySection}
    >
      {children}
    </ConfigurationSourceBoundary>
  );
}

function assembleTeamPage(
  options: TeamPageBuildOptions,
  queryClient: QueryClient,
  authHarness: TeamAuthRuntime,
): TeamPageAssembly {
  const { handlers, negotiated, withPool, pinBoundaryWindowHost } = options;
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
    schedulingPolicy: hostRpcSchedulingPolicy,
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
  const binding = pinBoundaryWindowHost
    ? {
        ...authHarness.binding,
        hostClient: teamHostBoundary.client,
        hostId: mockLocalHostEntry.hostId,
      }
    : authHarness.binding;
  return {
    messenger,
    queryClient,
    auth: authHarness.auth,
    runnerHost: authHarness.runnerHost,
    paramsOf: (method) =>
      messenger.calls
        .filter((call) => call.method === method)
        .map((call) => call.params),
    binding,
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
  useLocalTeamAdmissionStore.setState({ byHost: new Map() });
  teamProfileRecordHttpBoundary.list = {
    status: 200,
    body: { enabled: false },
  };
  teamProfileRecordHttpBoundary.nextListAnswer = null;
  teamProfileRecordHttpBoundary.items = { status: 200, body: { items: [] } };
  teamProfileRecordHttpBoundary.action = {
    status: 200,
    body: {
      profileId: "team-profile",
      harnessId: "claude",
      recordRevision: "1",
    },
  };
  teamProfileRecordHttpBoundary.keyAction = {
    status: 200,
    body: {
      profileId: "team-key-profile",
      providerId: "cursor",
      state: "removed",
      signInNumber: "1",
      recordRevision: "2",
      personIntentNumber: "1",
    },
  };
  teamProfileRecordHttpBoundary.connections = {
    status: 200,
    body: {
      connections: [{ profileId: "team-api-key", bindingVersion: 4 }],
    },
  };
  teamProfileRecordHttpBoundary.replaceKey = {
    status: 200,
    body: {
      profileId: "team-api-key",
      harnessId: "claude",
      kind: "api_key",
      status: "connected",
    },
  };
  teamProfileRecordHttpBoundary.signInIntent = {
    status: 200,
    body: { operationId: TEAM_SIGN_IN_OPERATION_ID, endsAt: 1 },
  };
  teamProfileRecordHttpBoundary.itemWriteStatus = 200;
  teamProfileRecordHttpBoundary.keyCanaryForwarded = false;
  teamProfileRecordHttpBoundary.calls.length = 0;
}
