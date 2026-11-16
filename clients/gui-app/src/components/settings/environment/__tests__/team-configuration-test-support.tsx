import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
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
import type { HostListResponse } from "@traycer/protocol/host/host-status";
import {
  ConfigurationSourceContext,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { grantedEnvironmentRole } from "@traycer/protocol/host/environment/contracts";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  EnvironmentCloud,
  EnvironmentTransport,
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import {
  environmentDescriptorSchemaV11,
  environmentListUpgradeV10ToV11,
  type EnvironmentDescriptorV11,
  type EnvironmentListResponse,
} from "@traycer/protocol/host/environment/contracts";
import { hashAppQueryKey } from "@/lib/query/query-key-hash";
import { ENVIRONMENT_CLOUD_QUERY_SCOPE } from "@/hooks/environment/use-environment-cloud";
import {
  createFakeEnvironmentCloudServices,
  createFakeEnvironmentCloudTransport,
} from "../../../../../__tests__/create-fake-runner-host";
import {
  createTeamEnvironmentCloudHandlers,
  type TeamEnvironmentCloudResponses,
} from "./team-environment-cloud-handlers";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { AuthService, type ExternalSession } from "@/lib/auth/auth-service";
import { createAuthBoundHostDirectory } from "@/lib/host/auth-bound-host-directory";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
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

export interface TeamProfileRecordHttpRequest {
  readonly url: string;
  readonly method: string;
  readonly hasBearerAuthorization: boolean;
  readonly body: string | null;
}

export interface TeamProviderKeyHttpRequest {
  readonly action: "set" | "clear";
  readonly routeMatches: boolean;
  readonly authorized: boolean;
  readonly keyMatches: boolean | null;
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

const DEFAULT_TEAM_PROFILE_ITEMS: TeamProfileRecordHttpAnswer = {
  status: 200,
  body: { items: [] },
};

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
  items: DEFAULT_TEAM_PROFILE_ITEMS,
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

export const teamProviderKeyHttpBoundary: {
  status: number;
  matchesKey: (key: string) => boolean;
  calls: TeamProviderKeyHttpRequest[];
} = {
  status: 200,
  matchesKey: () => false,
  calls: [],
};

type TeamProviderKeyResponseArm = "sk-provider-record" | "s3-key-action";

let teamProviderKeyResponseArm: TeamProviderKeyResponseArm = "s3-key-action";

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
  readonly auth: AuthService;
  readonly runnerHost: IRunnerHost;
  readonly cloudRequests: readonly EnvironmentTransportRequest[];
  readonly cloudResponses: TeamEnvironmentCloudResponses;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
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
let teamWindowRegistered = false;
let restoreTeamFetch: (() => void) | null = null;
let teamIntentsFetch: typeof fetch | null = null;
let verifiedSettingsTransport: EnvironmentTransport | null = null;
const activeTeamPageRuntimes: Array<{
  readonly runtime: HostRuntime<HostRpcRegistry>;
  readonly directory: HostDirectoryService;
  readonly auth: AuthService | null;
}> = [];

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
  const providerKeyResponse = handleProviderKeyTransport(
    url,
    method,
    headers,
    rawBody,
  );
  if (providerKeyResponse !== null) {
    if (teamProviderKeyResponseArm === "s3-key-action") {
      recordTeamProfileRequest(url, method, headers, null);
    }
    return providerKeyResponse;
  }
  recordTeamProfileRequest(url, method, headers, rawBody);
  if (
    url.pathname.endsWith("/profile-records/intents") &&
    teamIntentsFetch !== null
  ) {
    return teamIntentsFetch(input, init);
  }
  const profileResponse = teamAuthnResponse(url);
  if (profileResponse !== null) return profileResponse;
  return accountFetch(url, method, headers, {
    rawBody,
    signal: init?.signal ?? new AbortController().signal,
  });
}

function accountFetch(
  url: URL,
  method: string,
  headers: Headers,
  request: { readonly rawBody: string | null; readonly signal: AbortSignal },
): Promise<Response> {
  const { rawBody, signal } = request;
  if (
    verifiedSettingsTransport === null ||
    (method !== "GET" &&
      method !== "POST" &&
      method !== "PUT" &&
      method !== "DELETE" &&
      method !== "PATCH")
  )
    return Promise.resolve(new Response(null, { status: 500 }));
  const body: unknown = rawBody === null ? null : JSON.parse(rawBody);
  return verifiedSettingsTransport({
    url: url.toString(),
    method,
    headers: Object.fromEntries(headers.entries()),
    body,
    signal,
  }).then((answer) => accountResponse(url, method, answer));
}

function accountResponse(
  url: URL,
  method: string,
  answer: EnvironmentTransportAnswer,
): Response {
  const text =
    method === "GET" &&
    url.pathname.endsWith("/secrets/harness-connections") &&
    answer.status === 200 &&
    answer.text !== null
      ? withBoundaryConnections(answer.text)
      : answer.text;
  return new Response(text, {
    status: answer.status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * authn answers one connection list for the whole environment: the account's
 * plan sign-ins and the profile boundary's API-key bindings arrive together,
 * as the plans read and the key form both read it.
 */
function withBoundaryConnections(accountText: string): string {
  const account: unknown = JSON.parse(accountText);
  const boundary = teamProfileRecordHttpBoundary.connections.body;
  return JSON.stringify({
    connections: [
      ...connectionRows(account),
      ...connectionRows(boundary).map((row) => ({
        harnessId: "claude",
        kind: "api_key",
        status: "connected",
        linkedBy: null,
        ...row,
      })),
    ],
  });
}

function connectionRows(body: unknown): readonly object[] {
  if (
    typeof body !== "object" ||
    body === null ||
    !("connections" in body) ||
    !Array.isArray(body.connections)
  )
    return [];
  const rows: readonly unknown[] = body.connections;
  return rows.filter(
    (row): row is object => typeof row === "object" && row !== null,
  );
}

function recordTeamProfileRequest(
  url: URL,
  method: string,
  headers: Headers,
  rawBody: string | null,
): void {
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
    typeof parsed !== "object" ||
    parsed === null ||
    !("key" in parsed) ||
    typeof parsed.key !== "string"
  ) {
    return null;
  }
  return teamProviderKeyHttpBoundary.matchesKey(parsed.key);
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
  if (teamProviderKeyResponseArm === "s3-key-action") {
    return teamHttpResponse(teamProfileRecordHttpBoundary.keyAction);
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
  if (
    url.pathname.endsWith("/harness-connections") &&
    verifiedSettingsTransport === null
  )
    return teamHttpResponse(teamProfileRecordHttpBoundary.connections);
  if (
    url.pathname.includes("/harness-connections/") &&
    url.pathname.endsWith("/connect")
  )
    return teamHttpResponse(teamProfileRecordHttpBoundary.replaceKey);
  return teamItemsResponse(url);
}

/**
 * The profile boundary's item answers. Under a verified account transport the
 * defaults leave the route to the account handler; a test that states its own
 * items or write refusal answers here.
 */
function teamItemsResponse(url: URL): Promise<Response> | null {
  if (
    url.pathname.endsWith("/items/managed_profile") &&
    (verifiedSettingsTransport === null ||
      teamProfileRecordHttpBoundary.items !== DEFAULT_TEAM_PROFILE_ITEMS ||
      teamProfileRecordHttpBoundary.itemWriteStatus !== 200)
  )
    return Promise.resolve(
      new Response(null, {
        status: teamProfileRecordHttpBoundary.itemWriteStatus,
      }),
    );
  if (
    url.pathname.endsWith("/items") &&
    (verifiedSettingsTransport === null ||
      teamProfileRecordHttpBoundary.items !== DEFAULT_TEAM_PROFILE_ITEMS)
  )
    return teamHttpResponse(
      itemsPageAnswer(
        teamProfileRecordHttpBoundary.items,
        url.searchParams.get("kind"),
      ),
    );
  return null;
}

/**
 * The account read asks authn for one kind per page, and authn answers whole
 * rows; a test states only the rows it means, so each page carries that kind's
 * rows with authn's row fields filled in.
 */
function itemsPageAnswer(
  answer: TeamProfileRecordHttpAnswer,
  kind: string | null,
): TeamProfileRecordHttpAnswer {
  const body = answer.body;
  if (
    answer.status !== 200 ||
    typeof body !== "object" ||
    body === null ||
    !("items" in body) ||
    !Array.isArray(body.items)
  )
    return answer;
  const rows: readonly unknown[] = body.items;
  return {
    status: 200,
    body: {
      items: rows.flatMap((row) =>
        typeof row === "object" &&
        row !== null &&
        (kind === null || ("kind" in row && row.kind === kind))
          ? [
              {
                os: null,
                updatedAt: 1,
                writtenBy: { source: "live", hostId: null, hostName: null },
                ...row,
              },
            ]
          : [],
      ),
    },
  };
}

/**
 * The teams the signed-in user belongs to, as the account directory shows
 * them. authn's user answer names the same teams, so a revalidation that
 * re-projects the user keeps the team the page is mounted for.
 */
let negotiatedTeams: readonly { teamId: string; slug: string }[] = [];

function publishAccountTeams(
  environments: readonly EnvironmentDescriptorV11[],
): void {
  const shareableTeams = shareableTeamsFor(environments);
  negotiatedTeams = shareableTeams;
  useAuthStore.setState({ shareableTeams });
}

function negotiatedTeamSubscription(team: {
  readonly teamId: string;
  readonly slug: string;
}): unknown {
  return {
    id: `team-test-subscription-${team.teamId}`,
    userID: null,
    orgID: team.teamId,
    teamID: team.teamId,
    customerId: "team-test-customer",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    subscriptionExpiry: null,
    trialEndsAt: null,
    subscriptionStatus: "FREE",
    hasPaymentMethod: false,
    isInTrial: false,
    rechargeRateSeconds: 0,
    totalPlanCredits: 0,
    hasActiveBundle: false,
    bundleSummary: { bundleTotal: 0, bundleConsumed: 0, bundleRemaining: 0 },
    team: {
      id: team.teamId,
      slug: team.slug,
      avatarUrl: null,
      privacyMode: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  };
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
        teamSubscriptions: negotiatedTeams.map(negotiatedTeamSubscription),
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

function teamWindowRegistry(): HostListResponse {
  return {
    hosts: teamWindowRegistered
      ? [
          {
            hostId: mockLocalHostEntry.hostId,
            displayName: mockLocalHostEntry.label,
            platform: "darwin",
            kind: "personal",
            publicKey: "team-window-test-key",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatePolicy: "manual",
            owner: { kind: "team", id: "team-a", name: "Alpha" },
            status: {
              connectivity: "connectable",
              viewerReachability: "ok",
              clientCloud: "ok",
              updateState: "current",
              appVersion: "1.4.4",
              lastSeenAt: "2026-01-01T00:00:00.000Z",
            },
          },
        ]
      : [],
  };
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
  vi.spyOn(auth, "fetchRegisteredHosts").mockImplementation(() =>
    Promise.resolve(teamWindowRegistry()),
  );
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
    onHostTokenRenewal: vi.fn(),
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

export async function createVerifiedTeamAuthService(
  queryClient: QueryClient,
  intentsFetch: typeof fetch | null,
): Promise<AuthService> {
  teamIntentsFetch = intentsFetch;
  teamProviderKeyResponseArm = "sk-provider-record";
  installTeamFetch();
  const harness = buildTeamAuthRuntime(queryClient);
  await startVerifiedTeamAuth(harness);
  return harness.auth;
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
  return buildVerifiedTeamProvidersPage(
    {
      source,
      handlers,
      negotiated: null,
      withPool: false,
      boundarySection: null,
      boundaryTarget: null,
      pinBoundaryWindowHost: false,
    },
    "s3-key-action",
  );
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
  const harness = buildVerifiedTeamProvidersPage(
    {
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
    },
    "s3-key-action",
  );
  return {
    ...harness,
    environmentListState,
    rereadEnvironmentList: async () => {
      await harness.queryClient.refetchQueries({
        queryKey: hostQueryKeys.methodScope(
          ENVIRONMENT_CLOUD_QUERY_SCOPE,
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
  return buildVerifiedTeamProvidersPage(
    {
      source: personalPoolSource(),
      handlers: { ...handlers, "environment.list": () => list },
      negotiated: null,
      withPool: false,
      boundarySection: "providers",
      boundaryTarget: { kind: "personal" },
      pinBoundaryWindowHost: true,
    },
    "s3-key-action",
  );
}

export function mountTeamPageWithRealBoundary(
  handlers: MockHandlerMap<HostRpcRegistry>,
): TeamPageHarness {
  return buildVerifiedTeamProvidersPage(
    {
      source: null,
      handlers,
      negotiated: null,
      withPool: false,
      boundarySection: null,
      boundaryTarget: null,
      pinBoundaryWindowHost: false,
    },
    "sk-provider-record",
  );
}

export function admitCurrentUserToTeamWindow(): void {
  const userId = useAuthStore.getState().contextMetadata?.userId;
  if (userId === undefined) {
    throw new Error("team window admission requires a signed-in test user");
  }
  teamWindowRegistered = true;
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
  readonly source: ConfigurationSource | null;
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
  readonly runnerHost: IRunnerHost;
  readonly cloudRequests: readonly EnvironmentTransportRequest[];
  readonly cloudResponses: TeamEnvironmentCloudResponses;
  readonly paramsOf: (method: string) => unknown[];
  readonly binding: HostRuntimeBinding<HostRpcRegistry>;
}

function buildTeamPage(options: TeamPageBuildOptions): TeamPageHarness {
  if (options.source === null)
    throw new Error("Legacy team page requires a configuration source");
  teamProviderKeyResponseArm = "s3-key-action";
  teamWindowRegistered = false;
  return buildLegacyTeamPage(
    options.source,
    options.handlers,
    options.negotiated,
    options.withPool,
  );
}

function buildLegacyTeamPage(
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
        publishAccountTeams(currentRows);
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
  useAuthStore.setState({ status: "signed-in" });
  publishAccountTeams(currentRows);
  activeTeamPageRuntimes.push({ runtime, directory, auth });
  return {
    runnerHost,
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

function buildVerifiedTeamProvidersPage(
  options: TeamPageBuildOptions,
  providerKeyResponseArm: TeamProviderKeyResponseArm,
): TeamPageHarness {
  teamProviderKeyResponseArm = providerKeyResponseArm;
  installTeamFetch();
  const queryClient = createTeamPageQueryClient();
  useAuthStore.setState({ status: "signed-out", shareableTeams: [] });
  teamWindowRegistered = false;
  const authHarness = buildTeamAuthRuntime(queryClient);
  const assembly = assembleTeamPage(options, queryClient, authHarness);
  void startVerifiedTeamAuth(authHarness).then(() =>
    authHarness.auth.listEnvironments(),
  );
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
      queries: { queryKeyHashFn: hashAppQueryKey, retry: false, gcTime: 0 },
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
    cloudRequests: assembly.cloudRequests,
    cloudResponses: assembly.cloudResponses,
    paramsOf: assembly.paramsOf,
    Wrapper,
  };
}

function renderConfigurationSource(
  options: TeamPageBuildOptions,
  children: ReactNode,
): ReactNode {
  if (options.boundarySection === null || options.boundaryTarget === null) {
    return options.source === null ? (
      children
    ) : (
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
  const directory = new TeamPageHostDirectory(authHarness.runnerHost, withPool);
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost: authHarness.runnerHost,
    registry: hostRpcRegistry,
    messenger,
    requestContextProvider: authHarness.auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
    connectionRegistry: null,
    selectedHostId: () => null,
    onHostTokenRenewal: () => undefined,
  });
  activeTeamPageRuntimes.push({ runtime, directory, auth: null });
  const spine = runtime.hostClient;
  const source = options.source ?? poolSource("viewer");
  const cloudHandlers = createTeamEnvironmentCloudHandlers(handlers, source);
  let currentRows: readonly EnvironmentDescriptorV11[] =
    source.kind === "pool"
      ? [
          {
            environmentId: source.environmentId,
            ownerKind:
              source.configuration === "personal" ? "user" : "organization",
            ownerId:
              source.configuration === "personal" ? "team-test-user" : "team-a",
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
  authHarness.auth.listEnvironments = async () => {
    const answer = await cloudHandlers.listEnvironments();
    if (answer?.kind === "ok") {
      currentRows = answer.list.environments.map(descriptorFromEnvironmentList);
      publishAccountTeams(currentRows);
    }
    return answer ?? { kind: "no_response" };
  };
  verifiedSettingsTransport = createFakeEnvironmentCloudTransport({
    environments: () => currentRows,
    onRequest: cloudHandlers.onRequest,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  teamHostBoundary.client = spine.createRequester(mockLocalHostEntry);
  viewingHostBoundary.client = spine.createRequester(mockRemoteHostEntry);
  const authBinding: HostRuntimeBinding<HostRpcRegistry> = {
    runtime,
    hostClient: spine,
    directory,
    auth: authHarness.auth,
    hostId: null,
  };
  const binding = pinBoundaryWindowHost
    ? {
        ...authBinding,
        hostClient: teamHostBoundary.client,
        hostId: mockLocalHostEntry.hostId,
      }
    : authBinding;
  teamHostBoundary.auth = authHarness.auth;
  teamHostBoundary.runtime = runtime;
  teamHostBoundary.directory = directory;
  teamHostBoundary.binding = binding;
  return {
    messenger,
    queryClient,
    auth: authHarness.auth,
    runnerHost: authHarness.runnerHost,
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
    binding,
  };
}

export function resetTeamPageHarness(): void {
  negotiatedTeams = [];
  for (const mounted of activeTeamPageRuntimes.splice(0)) {
    mounted.runtime.dispose();
    mounted.directory.dispose();
    mounted.auth?.dispose();
  }
  environmentCloudOverride = null;
  verifiedSettingsTransport = null;
  teamHostBoundary.auth = null;
  teamHostBoundary.runtime = null;
  teamHostBoundary.directory = null;
  teamHostBoundary.binding = null;
  for (const harness of activeTeamAuthRuntimes.splice(0)) {
    harness.runtime.dispose();
    harness.directory.dispose();
    harness.auth.dispose();
  }
  restoreTeamFetch?.();
  restoreTeamFetch = null;
  teamIntentsFetch = null;
  teamProviderKeyResponseArm = "s3-key-action";
  teamHostBoundary.client = null;
  viewingHostBoundary.client = null;
  windowHostBoundary.hostId = null;
  useAuthStore.setState({ status: "signed-out", shareableTeams: [] });
  teamWindowRegistered = false;
  teamProfileRecordHttpBoundary.list = {
    status: 200,
    body: { enabled: false },
  };
  teamProfileRecordHttpBoundary.nextListAnswer = null;
  teamProfileRecordHttpBoundary.items = DEFAULT_TEAM_PROFILE_ITEMS;
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
  teamProviderKeyHttpBoundary.status = 200;
  teamProviderKeyHttpBoundary.matchesKey = () => false;
  teamProviderKeyHttpBoundary.calls.length = 0;
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
