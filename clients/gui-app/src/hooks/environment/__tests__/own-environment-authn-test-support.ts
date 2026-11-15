import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { AuthService } from "@/lib/auth/auth-service";
import { createAuthBoundHostDirectory } from "@/lib/host/auth-bound-host-directory";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { AuthnSecretRow } from "@traycer-clients/shared/environment/authn-environment-schemas";

export const AUTHN_BASE = "https://authn.test.invalid";
export const DIRECTORY_URL = "https://server.test.invalid/api/environments";
export const WINDOW_HOST = "host-window";

const PROFILE = {
  user: {
    id: "user-1",
    name: "Test User",
    providerId: "gh-1",
    providerHandle: "test-user",
    providerType: "GITHUB",
    email: "test@example.com",
    avatarUrl: null,
    activatedAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    lastSeenAt: null,
    privacyMode: false,
    isLearningEnabled: true,
  },
  userSubscription: {
    id: "sub-1",
    userID: "user-1",
    orgID: null,
    teamID: null,
    customerId: "cus-1",
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
};

export interface OwnEnvironmentTransportRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: BodyInit | null;
  readonly signal: AbortSignal | undefined;
}

export type OwnEnvironmentRoute = (
  request: OwnEnvironmentTransportRequest,
) => Response | Promise<Response> | undefined;

export interface OwnEnvironmentTransport {
  readonly requests: OwnEnvironmentTransportRequest[];
  restore: () => void;
}

export function installOwnEnvironmentTransport(
  route: OwnEnvironmentRoute,
  directory: unknown,
): OwnEnvironmentTransport {
  const originalFetch = globalThis.fetch;
  const requests: OwnEnvironmentTransportRequest[] = [];
  const mockedFetch: typeof fetch = (input, init) => {
    let url: URL;
    if (input instanceof Request) {
      url = new URL(input.url);
    } else if (input instanceof URL) {
      url = input;
    } else {
      url = new URL(input);
    }
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init?.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    const request: OwnEnvironmentTransportRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ?? null,
      signal: init?.signal ?? undefined,
    };
    requests.push(request);
    const handled = route(request);
    if (handled !== undefined) return Promise.resolve(handled);
    if (request.url.toString() === DIRECTORY_URL) {
      return Promise.resolve(jsonResponse(200, directory));
    }
    if (
      request.url.origin === AUTHN_BASE &&
      request.url.pathname.startsWith("/api/v3/environments/")
    ) {
      return Promise.resolve(jsonResponse(404, {}));
    }
    return Promise.resolve(jsonResponse(200, PROFILE));
  };
  globalThis.fetch = mockedFetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "x-traycer-user-record-version": "2.0",
    },
  });
}

export function authnSecretRowFixture(
  overrides: Partial<AuthnSecretRow>,
): AuthnSecretRow {
  return {
    id: "secret-fixture",
    name: "EXAMPLE_KEY",
    kind: "api_key",
    protocol: "https",
    hosts: ["api.example.test"],
    currentVersionId: "version-fixture",
    updatedAt: 1,
    variables: [],
    ...overrides,
  };
}

export interface AuthnHostRowFixture {
  readonly hostId: string;
  readonly hostName: string | null;
  readonly hostKind: "personal" | "sandbox";
  readonly reportedAt: number | null;
  readonly online: boolean;
  readonly purgePending: boolean;
  readonly items: ReadonlyArray<{
    readonly kind: string;
    readonly key: string;
    readonly status: "applied" | "pending" | "failed" | "unsupported";
    readonly code: string;
  }>;
  readonly hasLocalRow?: boolean | null;
  readonly enrolledByUserId?: string | null;
  readonly boundAt?: number | null;
  readonly hostPlatform?: string | null;
}

export function authnHostRowFixture(
  overrides: Partial<AuthnHostRowFixture>,
): AuthnHostRowFixture {
  return {
    hostId: "host-fixture",
    hostName: "Example host",
    hostKind: "personal",
    reportedAt: null,
    online: true,
    purgePending: false,
    items: [],
    ...overrides,
  };
}

export interface OwnEnvironmentAuthRuntime {
  readonly runnerHost: MockRunnerHost;
  readonly auth: AuthService;
  readonly binding: HostRuntimeBinding<HostRpcRegistry>;
  dispose: () => void;
}

export function createOwnEnvironmentAuthRuntime(): OwnEnvironmentAuthRuntime {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: AUTHN_BASE,
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
    remoteFetcher: null,
    localHostIdSeeder: () => Promise.resolve(null),
    onRegistryPollTick: null,
  });
  let requestSequence = 0;
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "own-env-" + String(++requestSequence),
      handlers: {},
    }),
    requestContextProvider: auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    ),
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
    hostId: WINDOW_HOST,
  };
  return {
    runnerHost,
    auth,
    binding,
    dispose: () => {
      runtime.dispose();
      directory.dispose();
      auth.dispose();
    },
  };
}

export async function signInOwnEnvironment(
  runtime: OwnEnvironmentAuthRuntime,
): Promise<void> {
  await signInOwnEnvironmentAs(runtime, "user-1", "user-1-token");
}

export async function signInOwnEnvironmentAs(
  runtime: OwnEnvironmentAuthRuntime,
  userId: string,
  token: string,
): Promise<void> {
  await runtime.auth.signIn();
  runtime.runnerHost.deviceFlow.emitResult({
    kind: "authorized",
    token,
    refreshToken: token + "-refresh",
  });
  await waitFor(() => {
    if (runtime.auth.getCurrentSessionSnapshot().token !== token) {
      throw new Error("authn sign-in has not settled");
    }
  });
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId,
      userName: "Test User",
      email: "test@example.com",
    },
    contextMetadata: { userId, username: "test-user" },
    shareableTeams: [{ teamId: "team-1", slug: "acme", avatarUrl: null }],
  });
}
