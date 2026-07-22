import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
  TokenRotateResult,
} from "@traycer-clients/shared/platform/runner-host";
import {
  AuthService,
  type AuthSessionSnapshot,
  AUTH_ERROR_DEVICE_DENIED,
  AUTH_ERROR_DEVICE_EXPIRED,
  AUTH_ERROR_LAUNCH_FAILED,
  AUTH_ERROR_SESSION_EXPIRED,
  AUTH_ERROR_SIGN_IN_FAILED,
  AUTH_ERROR_STORE_UNAVAILABLE,
} from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

type FetchHandler = (
  input: unknown,
  init:
    | {
        readonly method?: string;
        readonly headers?: Record<string, string>;
        readonly body?: BodyInit | null;
      }
    | undefined,
) => Promise<Response>;

interface DeferredResponse {
  readonly promise: Promise<Response>;
  resolve(response: Response): void;
}

const VALIDATION_URL = "http://localhost:5005/api/v3/user";
const REFRESH_URL = "http://localhost:5005/api/v3/auth/refresh";

// The default `/device/authorize` user code the `MockDeviceFlowHost` hands back,
// and the pre-filled verification URL the controller asks the shell to open.
const MOCK_DEVICE_USER_CODE = "ABCDE-FGHIJ";
const MOCK_DEVICE_VERIFICATION_URI_COMPLETE =
  "https://app.traycer.ai/device?user_code=ABCDE-FGHIJ";

// Collapse consecutive identical entries so an ordered validate -> refresh
// assertion tolerates the auth boundary's bounded retry (a transient 5xx /
// transport error is re-driven a few times before the flow advances) without
// coupling the test to the exact attempt count.
function collapseConsecutiveCalls(calls: readonly string[]): string[] {
  return calls.filter(
    (call, index) => index === 0 || call !== calls[index - 1],
  );
}

const trackedServices: AuthService[] = [];

function makeService(): { service: AuthService; host: MockRunnerHost } {
  const host = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const service = trackService(new AuthService({ runnerHost: host }));
  return { service, host };
}

function trackService(service: AuthService): AuthService {
  trackedServices.push(service);
  return service;
}

function installFetch(handler: FetchHandler): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: handler,
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

function createDeferredResponse(): DeferredResponse {
  const state: { resolve: (response: Response) => void } = {
    resolve: () => undefined,
  };
  const promise = new Promise<Response>((resolve) => {
    state.resolve = resolve;
  });
  return {
    promise,
    resolve: (response) => {
      state.resolve(response);
    },
  };
}

function ok(): Promise<Response> {
  return Promise.resolve(new Response("{}", { status: 200 }));
}

function okWithProfile(): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({
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
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
}

function okWithProfileForUser(userId: string): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        user: {
          id: userId,
          name: `${userId} display`,
          providerId: `gh-${userId}`,
          providerHandle: userId,
          providerType: "GITHUB",
          email: `${userId}@example.com`,
          avatarUrl: null,
          activatedAt: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
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
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
}

function okWithRefreshToken(token: string): Promise<Response> {
  // The `/api/v3/auth/refresh` response rotates BOTH tokens; the helper reads both.
  return Promise.resolve(
    new Response(JSON.stringify({ token, refreshToken: `${token}-refresh` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function status(code: number): Promise<Response> {
  return Promise.resolve(new Response(null, { status: code }));
}

/**
 * Drives a full device-flow sign-in: start the attempt, then settle its poll on
 * the `authorized` terminal and wait for the signed-in projection. The minted
 * `token` validates through the installed fetch mock (default `okWithProfile`).
 */
async function deviceSignIn(
  service: AuthService,
  host: MockRunnerHost,
  token: string,
): Promise<void> {
  await service.signIn();
  host.deviceFlow.emitResult({
    kind: "authorized",
    token,
    refreshToken: `${token}-refresh`,
  });
  await vi.waitFor(() => {
    expect(service.getCurrentSessionSnapshot().token).toBe(token);
  });
}

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A JWS-shaped access token whose payload carries a decodable `exp`, so the
 * proactive refresh scheduler arms off it (the arbitrary opaque strings the
 * other tests use carry no `exp` and leave the scheduler disabled).
 */
function jwtExpiringInMs(fromNowMs: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      id: "user-1",
      exp: Math.trunc((Date.now() + fromNowMs) / 1000),
    }),
  );
  return `${header}.${payload}.signature`;
}

const DEFAULT_IDENTITY = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
} as const;

function expectedStored(token: string, refreshToken: string) {
  return {
    token,
    refreshToken,
    authnBaseUrl: "http://localhost:5005",
    // `expect.any(String)` is an `any`-typed matcher; type it as the field it
    // stands in for so the object literal stays free of unsafe `any` assignment.
    savedAt: expect.any(String) as string,
    user: { ...DEFAULT_IDENTITY },
  };
}

describe("AuthService", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    restoreFetch = installFetch(() => okWithProfile());
  });

  afterEach(() => {
    while (trackedServices.length > 0) {
      const service = trackedServices.pop();
      if (service !== undefined) {
        service.dispose();
      }
    }
    useAuthStore.getState().setSignedOut();
    vi.useRealTimers();
    restoreFetch();
  });

  it("rehydrates a persisted token after AuthnV3 validation succeeds", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "persisted-token", refreshToken: "persisted-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    const seenAuthHeaders: string[] = [];
    restoreFetch = installFetch((_input, init) => {
      const headers = init === undefined ? undefined : init.headers;
      if (headers !== undefined && typeof headers.Authorization === "string") {
        seenAuthHeaders.push(headers.Authorization);
      }
      return okWithProfile();
    });

    await service.start();

    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(service.getCurrentSessionSnapshot().token).toBe("persisted-token");
    expect(useAuthStore.getState().contextMetadata?.userId).toBe("user-1");
    expect(seenAuthHeaders).toContain("Bearer persisted-token");
  });

  it("does not drive auth transitions when disposed during startup validation", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "persisted-token", refreshToken: "persisted-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    const deferred = createDeferredResponse();
    restoreFetch = installFetch(() => deferred.promise);

    const startPromise = service.start();
    service.dispose();
    deferred.resolve(new Response(null, { status: 401 }));

    await expect(startPromise).resolves.toBeUndefined();
    expect(useAuthStore.getState().status).toBe("signed-out");
  });

  it("publishes a live RequestContext through getRequestContextProvider() after sign-in", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "persisted-token", refreshToken: "persisted-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    await service.start();

    const provider = service.getRequestContextProvider();
    const ctx = provider.current();
    expect(ctx).not.toBeNull();
    expect(ctx?.identity.userId).toBe("user-1");
    expect(ctx?.credentials.getBearerToken()).toBe("persisted-token");
    expect(ctx?.origin).toBe("renderer");
  });

  it("emits null on the provider when the user signs out", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "persisted-token", refreshToken: "persisted-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    await service.start();

    const events: Array<string | null> = [];
    service
      .getRequestContextProvider()
      .onChange((ctx) => events.push(ctx?.identity.userId ?? null));

    await service.signOut();

    expect(service.getRequestContextProvider().current()).toBeNull();
    expect(events).toContain(null);
  });

  it("rotates the active context's credential lease in place on same-user refresh (no provider re-emit)", async () => {
    const { service, host } = makeService();
    await service.start();
    await deviceSignIn(service, host, "old-token");

    const provider = service.getRequestContextProvider();
    const ctxBefore = provider.current();
    expect(ctxBefore).not.toBeNull();

    const reemits: Array<string | null> = [];
    provider.onChange((ctx) => reemits.push(ctx?.identity.userId ?? null));

    restoreFetch();
    restoreFetch = installFetch((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (
        url === VALIDATION_URL &&
        init?.headers?.Authorization === "Bearer old-token"
      ) {
        return status(401);
      }
      if (
        url === REFRESH_URL &&
        init?.headers?.Authorization === "Bearer old-token"
      ) {
        return okWithRefreshToken("rotated-token");
      }
      if (
        url === VALIDATION_URL &&
        init?.headers?.Authorization === "Bearer rotated-token"
      ) {
        return okWithProfile();
      }
      return status(500);
    });

    const outcome = await service.revalidateCurrentContext();
    expect(outcome?.kind).toBe("valid");

    const ctxAfter = provider.current();
    expect(ctxAfter).toBe(ctxBefore);
    expect(ctxAfter?.credentials.getBearerToken()).toBe("rotated-token");
    expect(reemits).toEqual([]);
    expect(service.getCurrentSessionSnapshot().token).toBe("rotated-token");
  });

  it("proactively refreshes the bearer on OS resume when the token is inside the lead window", async () => {
    const { service, host } = makeService();
    // 5m of life left → inside the ~10m proactive lead window. During a sleep
    // the scheduler's monotonic timer is frozen, so without a wake hook this
    // bearer would rot; the OS resume signal must drive an immediate refresh.
    const nearExpiry = jwtExpiringInMs(5 * 60_000);
    await host.tokenStore.signIn(
      { token: nearExpiry, refreshToken: `${nearExpiry}-refresh` },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    await service.start();
    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(service.getCurrentSessionSnapshot().token).toBe(nearExpiry);

    const provider = service.getRequestContextProvider();
    const ctxBefore = provider.current();
    const rotated = jwtExpiringInMs(4 * 60 * 60_000);
    const refreshAuth: string[] = [];
    restoreFetch();
    restoreFetch = installFetch((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === REFRESH_URL) {
        refreshAuth.push(String(init?.headers?.Authorization));
        return okWithRefreshToken(rotated);
      }
      return okWithProfile();
    });

    // Electron powerMonitor resume bridged through the runner host.
    host.emitSystemResumed();

    await vi.waitFor(() => {
      expect(service.getCurrentSessionSnapshot().token).toBe(rotated);
    });
    expect(refreshAuth).toEqual([`Bearer ${nearExpiry}`]);
    // Same-user rotation mutates the existing context's lease in place.
    expect(provider.current()).toBe(ctxBefore);
    expect(provider.current()?.credentials.getBearerToken()).toBe(rotated);
  });

  it("does not refresh on OS resume when the bearer is still well within its TTL", async () => {
    const { service, host } = makeService();
    const farExpiry = jwtExpiringInMs(4 * 60 * 60_000);
    await host.tokenStore.signIn(
      { token: farExpiry, refreshToken: `${farExpiry}-refresh` },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    await service.start();
    expect(service.getCurrentSessionSnapshot().token).toBe(farExpiry);

    let refreshed = false;
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === REFRESH_URL) {
        refreshed = true;
        return okWithRefreshToken(jwtExpiringInMs(4 * 60 * 60_000));
      }
      return okWithProfile();
    });

    host.emitSystemResumed();
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(refreshed).toBe(false);
    expect(service.getCurrentSessionSnapshot().token).toBe(farExpiry);
  });

  it("aborts the current context and emits null on cross-user revalidation", async () => {
    const { service, host } = makeService();
    await service.start();
    await deviceSignIn(service, host, "user-1-token");

    const provider = service.getRequestContextProvider();
    const ctxA = provider.current();
    expect(ctxA?.identity.userId).toBe("user-1");

    restoreFetch();
    restoreFetch = installFetch(() => okWithProfileForUser("user-2"));

    await service.revalidateCurrentContext();

    expect(ctxA?.isAborted).toBe(true);
    expect(provider.current()?.identity.userId).toBe("user-2");
  });

  it("refreshes a persisted token when startup validation rejects before signing out", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "expired-token", refreshToken: "expired-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    const calls: string[] = [];
    restoreFetch = installFetch((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (
        url === VALIDATION_URL &&
        init?.headers?.Authorization === "Bearer expired-token"
      ) {
        return status(401);
      }
      if (
        url === REFRESH_URL &&
        init?.headers?.Authorization === "Bearer expired-token"
      ) {
        return okWithRefreshToken("refreshed-token");
      }
      if (
        url === VALIDATION_URL &&
        init?.headers?.Authorization === "Bearer refreshed-token"
      ) {
        return okWithProfile();
      }
      return status(500);
    });

    await service.start();

    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(service.getCurrentSessionSnapshot().token).toBe("refreshed-token");
    expect(await host.tokenStore.get()).toEqual(
      expectedStored("refreshed-token", "refreshed-token-refresh"),
    );
    expect(service.getLastError()).toBeNull();
    // collapseConsecutiveCalls: rotate's self-write may schedule a reconcile
    // validate (same URL as the post-rotate revalidate) that is a no-op adopt.
    expect(collapseConsecutiveCalls(calls)).toEqual([
      `GET ${VALIDATION_URL}`,
      `POST ${REFRESH_URL}`,
      `GET ${VALIDATION_URL}`,
    ]);
  });

  it("surfaces session-expired on refresh-rejected but keeps the credentials file", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "stale-token", refreshToken: "stale-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    const calls: string[] = [];
    restoreFetch = installFetch((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === VALIDATION_URL) {
        return status(500);
      }
      if (url === REFRESH_URL) {
        return status(401);
      }
      return status(500);
    });

    await service.start();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
    // Automatic failures never destroy the shared file (tech plan §5).
    expect(await host.tokenStore.get()).toEqual(
      expectedStored("stale-token", "stale-token-refresh"),
    );
    expect(collapseConsecutiveCalls(calls)).toEqual([
      `GET ${VALIDATION_URL}`,
      `POST ${REFRESH_URL}`,
    ]);
  });

  it("UI-only signs out with session-expired when validation rejects with 401 on start()", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "revoked-token", refreshToken: "revoked-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    restoreFetch = installFetch(() => status(401));

    await service.start();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
    expect(await host.tokenStore.get()).toEqual(
      expectedStored("revoked-token", "revoked-token-refresh"),
    );
  });

  it("UI-only signs out with session-expired when validation rejects with 404 on start()", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      {
        token: "missing-user-token",
        refreshToken: "missing-user-token-refresh",
      },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    restoreFetch = installFetch(() => status(404));

    await service.start();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
    expect(await host.tokenStore.get()).toEqual(
      expectedStored("missing-user-token", "missing-user-token-refresh"),
    );
  });

  it("UI-only signs out when a 200 response has no usable profile on start()", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "profileless-token", refreshToken: "profileless-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    // Access validate rejects (unparseable profile); rotate's refresh also
    // gets `{}` → rejected → refresh-rejected → session-expired, file kept.
    restoreFetch = installFetch(() => ok());

    await service.start();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
    expect(await host.tokenStore.get()).toEqual(
      expectedStored("profileless-token", "profileless-token-refresh"),
    );
  });

  it("treats a 200 response with no usable profile as sign-in-failed on the device-poll path", async () => {
    const { service, host } = makeService();
    await service.start();
    restoreFetch();
    restoreFetch = installFetch(() => ok());

    await service.signIn();
    host.deviceFlow.emitResult({
      kind: "authorized",
      token: "callback-token",
      refreshToken: "callback-token-refresh",
    });

    await vi.waitFor(() => {
      expect(service.getLastError()).toBe(AUTH_ERROR_SIGN_IN_FAILED);
    });
    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(await host.tokenStore.get()).toBeNull();
  });

  it("UI-only signs out (file kept, no session-expired) when startup stays offline", async () => {
    // Transient refresh-network does not destroy the file and does not claim
    // a dead credential (H1 / §5).
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "offline-token", refreshToken: "offline-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    const calls: string[] = [];
    restoreFetch = installFetch((input, init) => {
      calls.push(
        `${init?.method ?? "GET"} ${typeof input === "string" ? input : String(input)}`,
      );
      return Promise.reject(new Error("offline"));
    });

    await service.start();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(await host.tokenStore.get()).toEqual(
      expectedStored("offline-token", "offline-token-refresh"),
    );
    // refresh-network is not a terminal authn reject.
    expect(service.getLastError()).toBeNull();
    expect(collapseConsecutiveCalls(calls)).toEqual([
      `GET ${VALIDATION_URL}`,
      `POST ${REFRESH_URL}`,
    ]);
  });

  it("opens the device verification page and flips to signing-in on signIn()", async () => {
    const { service, host } = makeService();
    await service.start();

    await service.signIn();

    // signIn() now runs the device flow directly: it starts the main-process
    // authorize+poll and opens the pre-filled verification page (not a redirect
    // sign-in URL).
    expect(host.deviceFlow.startCalls).toBe(1);
    expect(host.openedExternalLinks).toEqual([
      MOCK_DEVICE_VERIFICATION_URI_COMPLETE,
    ]);
    expect(useAuthStore.getState().status).toBe("signing-in");
    // Progress is surfaced (no silent spinner).
    expect(service.getDeviceProgress()?.userCode).toBe(MOCK_DEVICE_USER_CODE);
  });

  it("calls runnerHost.beginAuthAttempt() exactly once before openExternalLink(...) on signIn()", async () => {
    const { service, host } = makeService();
    await service.start();

    const calls: Array<"begin" | "open"> = [];
    const originalBegin = host.beginAuthAttempt.bind(host);
    host.beginAuthAttempt = (): void => {
      calls.push("begin");
      originalBegin();
    };
    const originalOpen = host.openExternalLink.bind(host);
    host.openExternalLink = async (url: string): Promise<void> => {
      calls.push("open");
      await originalOpen(url);
    };

    await service.signIn();

    expect(host.beginAuthAttemptCalls).toBe(1);
    expect(calls).toEqual(["begin", "open"]);
  });

  it("hits /api/v3/user (NOT the legacy /api/user) when validating a token", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "persisted-token", refreshToken: "persisted-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    const seenUrls: string[] = [];
    restoreFetch = installFetch((input) => {
      seenUrls.push(typeof input === "string" ? input : String(input));
      return okWithProfile();
    });

    await service.start();

    expect(seenUrls).toContain(VALIDATION_URL);
    expect(seenUrls).not.toContain("http://localhost:5005/api/user");
  });

  it("validates and persists a token delivered by the device poll", async () => {
    const { service, host } = makeService();
    await service.start();
    await service.signIn();
    restoreFetch();
    const validationCalls: string[] = [];
    restoreFetch = installFetch((input) => {
      validationCalls.push(typeof input === "string" ? input : String(input));
      return okWithProfile();
    });

    host.deviceFlow.emitResult({
      kind: "authorized",
      token: "new-token",
      refreshToken: "new-token-refresh",
    });

    await vi.waitFor(() => {
      expect(service.getCurrentSessionSnapshot().token).toBe("new-token");
    });
    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(await host.tokenStore.get()).toEqual(
      expectedStored("new-token", "new-token-refresh"),
    );
    expect(validationCalls).toContain(VALIDATION_URL);
  });

  it("surfaces sign-in-failed (NOT session-expired) when a device-poll token is rejected by AuthnV3", async () => {
    const { service, host } = makeService();
    await service.start();
    restoreFetch();
    restoreFetch = installFetch(() => status(401));

    await service.signIn();
    host.deviceFlow.emitResult({
      kind: "authorized",
      token: "rejected-token",
      refreshToken: "rejected-token-refresh",
    });

    await vi.waitFor(() => {
      expect(service.getLastError()).toBe(AUTH_ERROR_SIGN_IN_FAILED);
    });
    expect(service.getLastError()).not.toBe(AUTH_ERROR_SESSION_EXPIRED);
    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(await host.tokenStore.get()).toBeNull();
  });

  it("surfaces sign-in-failed when a device-poll token validation hits a network error", async () => {
    const { service, host } = makeService();
    await service.start();
    restoreFetch();
    restoreFetch = installFetch(() => Promise.reject(new Error("offline")));

    await service.signIn();
    host.deviceFlow.emitResult({
      kind: "authorized",
      token: "net-fail-token",
      refreshToken: "net-fail-token-refresh",
    });

    // The device-poll token validation now retries transient failures on a
    // bounded backoff, so the surfaced error can arrive after the default 1s
    // waitFor budget - allow for the full retry window.
    await vi.waitFor(
      () => {
        expect(service.getLastError()).toBe(AUTH_ERROR_SIGN_IN_FAILED);
      },
      { timeout: 5000 },
    );
    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(await host.tokenStore.get()).toBeNull();
  });

  it("clears tokenStore and resets state on signOut()", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "token", refreshToken: "token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    await service.start();

    await service.signOut();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(await host.tokenStore.get()).toBeNull();
  });

  it("notifies status listeners on sign-in, sign-out, and token application", async () => {
    const { service, host } = makeService();
    const events: string[] = [];
    service.onChange((status) => {
      events.push(status);
    });

    await service.start();
    await deviceSignIn(service, host, "tok");
    await service.signOut();

    expect(events).toEqual(["signing-in", "signed-in", "signed-out"]);
  });

  it("publishes session snapshots through onSessionSnapshotChange (persistence-boundary surface)", async () => {
    const { service, host } = makeService();
    const tokens: Array<string | null> = [];
    service.onSessionSnapshotChange((snapshot) => {
      tokens.push(snapshot.token);
    });

    await service.start();
    await deviceSignIn(service, host, "tok-a");

    await service.signOut();
    expect(tokens[tokens.length - 1]).toBeNull();
  });

  it("installs the onAuthCallback subscription before awaiting tokenStore.load()", async () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.ai/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    let authSubscribed = false;
    let resolveLoad: (value: StoredCredentials | null) => void = () =>
      undefined;
    const pendingLoad = new Promise<StoredCredentials | null>((resolve) => {
      resolveLoad = resolve;
    });

    const originalOnAuthCallback = host.onAuthCallback.bind(host);
    host.onAuthCallback = (handler) => {
      authSubscribed = true;
      return originalOnAuthCallback(handler);
    };
    host.tokenStore.get = (): Promise<StoredCredentials | null> => pendingLoad;

    const service = trackService(new AuthService({ runnerHost: host }));
    const startPromise = service.start();

    await Promise.resolve();

    expect(authSubscribed).toBe(true);

    resolveLoad(null);
    await startPromise;
  });

  it("allows a successful retry after a failed sign-in attempt", async () => {
    const { service, host } = makeService();
    await service.start();

    await service.signIn();
    host.deviceFlow.emitResult({ kind: "denied" });
    await vi.waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-out");
    });
    expect(service.getLastError()).toBe(AUTH_ERROR_DEVICE_DENIED);

    await service.signIn();
    expect(service.getLastError()).toBeNull();
    expect(useAuthStore.getState().status).toBe("signing-in");

    host.deviceFlow.emitResult({
      kind: "authorized",
      token: "retry-token",
      refreshToken: "retry-token-refresh",
    });
    await vi.waitFor(() => {
      expect(service.getCurrentSessionSnapshot().token).toBe("retry-token");
    });
    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(service.getLastError()).toBeNull();
    expect(await host.tokenStore.get()).toEqual(
      expectedStored("retry-token", "retry-token-refresh"),
    );
  });

  it("fails like a launch failure without destroying a pre-existing credentials file", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "stale", refreshToken: "stale-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    // A null authorization models a network/5xx authorize failure.
    host.deviceFlow.nextAuthorization = null;

    await service.signIn();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(service.getLastError()).toBe(AUTH_ERROR_LAUNCH_FAILED);
    // Only explicit sign-out deletes the file.
    expect(await host.tokenStore.get()).toEqual(
      expectedStored("stale", "stale-refresh"),
    );
  });

  it("drops a device result whose epoch a newer signIn() superseded", async () => {
    const { service, host } = makeService();
    await service.start();
    await service.signIn(); // epoch 1, session A
    const sessionA = host.deviceFlow.lastSession;

    await service.signIn(); // epoch 2 supersedes; session A is cancelled
    expect(sessionA?.cancelled).toBe(true);

    // A late authorized result for the superseded session A is dropped by epoch.
    sessionA?.emit({
      kind: "authorized",
      token: "superseded-token",
      refreshToken: "superseded-token-refresh",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(useAuthStore.getState().status).toBe("signing-in");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
  });

  it("ignores a replayed device result after the attempt has already signed in", async () => {
    const { service, host } = makeService();
    await service.start();
    await service.signIn();
    const session = host.deviceFlow.lastSession;

    session?.emit({
      kind: "authorized",
      token: "device-token-1",
      refreshToken: "device-token-1-refresh",
    });
    await vi.waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-in");
    });
    expect(service.getCurrentSessionSnapshot().token).toBe("device-token-1");

    // A replayed terminal for the now-consumed attempt must not re-apply.
    session?.emit({
      kind: "authorized",
      token: "device-token-2",
      refreshToken: "device-token-2-refresh",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(service.getCurrentSessionSnapshot().token).toBe("device-token-1");
  });

  it("emits onErrorChange when lastError transitions null → non-null and back", async () => {
    const { service, host } = makeService();
    const errors: Array<string | null> = [];
    service.onErrorChange((error) => {
      errors.push(error);
    });

    await service.start();
    await service.signIn();
    host.deviceFlow.emitResult({ kind: "denied" });
    await vi.waitFor(() => {
      expect(service.getLastError()).toBe(AUTH_ERROR_DEVICE_DENIED);
    });
    expect(errors).toContain(AUTH_ERROR_DEVICE_DENIED);

    await service.signIn();
    expect(errors[errors.length - 1]).toBeNull();
  });

  describe("device flow (RFC 8628) is the primary interactive login", () => {
    it("signs in when the device poll resolves authorized (converges on the shared tail)", async () => {
      const { service, host } = makeService();
      await service.start();

      await service.signIn();
      expect(useAuthStore.getState().status).toBe("signing-in");
      expect(host.deviceFlow.startCalls).toBe(1);
      expect(service.getDeviceProgress()?.userCode).toBe(MOCK_DEVICE_USER_CODE);

      host.deviceFlow.emitResult({
        kind: "authorized",
        token: "device-token",
        refreshToken: "device-token-refresh",
      });

      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      });
      expect(service.getCurrentSessionSnapshot().token).toBe("device-token");
      expect(service.getDeviceProgress()).toBeNull();
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("device-token", "device-token-refresh"),
      );
    });

    it("completes sign-in from the poll alone when the browser-return signal never fires", async () => {
      const { service, host } = makeService();
      await service.start();

      // No `emitAuthCallback()` at all - login must still complete poll-only.
      await service.signIn();
      host.deviceFlow.emitResult({
        kind: "authorized",
        token: "poll-only-token",
        refreshToken: "poll-only-token-refresh",
      });

      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      });
      expect(service.getCurrentSessionSnapshot().token).toBe("poll-only-token");
    });

    it("the browser-return signal nudges the in-flight poll but never delivers a token", async () => {
      const { service, host } = makeService();
      await service.start();
      await service.signIn();
      const session = host.deviceFlow.lastSession;
      expect(session?.pollNowCalls).toBe(0);

      // The shell delivers the payload-free return signal.
      host.emitAuthCallback();

      // It only nudged the poll; no token landed and we are still signing-in.
      expect(session?.pollNowCalls).toBe(1);
      expect(useAuthStore.getState().status).toBe("signing-in");
      expect(service.getCurrentSessionSnapshot().token).toBeNull();

      // The poll still carries the token to completion.
      host.deviceFlow.emitResult({
        kind: "authorized",
        token: "nudged-token",
        refreshToken: "nudged-token-refresh",
      });
      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      });
      expect(service.getCurrentSessionSnapshot().token).toBe("nudged-token");
    });

    it("is a no-op when the browser-return signal arrives with no active attempt", async () => {
      const { service, host } = makeService();
      await service.start();

      host.emitAuthCallback();

      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getCurrentSessionSnapshot().token).toBeNull();
    });

    it("surfaces device-denied when the user denies the request", async () => {
      const { service, host } = makeService();
      await service.start();
      await service.signIn();

      host.deviceFlow.emitResult({ kind: "denied" });

      await vi.waitFor(() => {
        expect(service.getLastError()).toBe(AUTH_ERROR_DEVICE_DENIED);
      });
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getDeviceProgress()).toBeNull();
    });

    it("surfaces device-expired when the controller reports the code expired", async () => {
      const { service, host } = makeService();
      await service.start();
      await service.signIn();

      host.deviceFlow.emitResult({ kind: "expired" });

      await vi.waitFor(() => {
        expect(service.getLastError()).toBe(AUTH_ERROR_DEVICE_EXPIRED);
      });
      expect(useAuthStore.getState().status).toBe("signed-out");
    });

    it("surfaces device-expired and cancels the poll when the attempt times out at the device_code TTL", async () => {
      vi.useFakeTimers();
      const { service, host } = makeService();
      await service.start();
      await service.signIn();
      const session = host.deviceFlow.lastSession;

      // The mock authorization's `expiresInSeconds` is 600s; the epoch-scoped
      // backstop timer fires at the TTL even if the controller never reports it.
      await vi.advanceTimersByTimeAsync(600_000 + 1);

      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getLastError()).toBe(AUTH_ERROR_DEVICE_EXPIRED);
      expect(session?.cancelled).toBe(true);
    });

    it("cancels the expiry backstop on a successful sign-in so no spurious expiry fires", async () => {
      vi.useFakeTimers();
      const { service, host } = makeService();
      await service.start();
      await service.signIn();

      host.deviceFlow.emitResult({
        kind: "authorized",
        token: "good-token",
        refreshToken: "good-token-refresh",
      });
      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      });

      await vi.advanceTimersByTimeAsync(600_000 + 1);

      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(service.getCurrentSessionSnapshot().token).toBe("good-token");
      expect(service.getLastError()).toBeNull();
    });
  });

  describe("revalidateCurrentContext", () => {
    it("returns null and does nothing when no context is live", async () => {
      const { service } = makeService();
      const outcome = await service.revalidateCurrentContext();
      expect(outcome).toBeNull();
      expect(useAuthStore.getState().status).toBe("signed-out");
    });

    it("leaves the user signed-in when AuthnV3 still accepts the token", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "good-token");

      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("valid");
      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(service.getCurrentSessionSnapshot().token).toBe("good-token");
      expect(service.getLastError()).toBeNull();
    });

    it("signs the user out and surfaces SESSION_EXPIRED on rejected", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "to-be-revoked");

      restoreFetch();
      restoreFetch = installFetch(() => status(401));

      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("rejected");
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getCurrentSessionSnapshot().token).toBeNull();
      expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
    });

    it("preserves signed-in state on transient network-error", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "still-valid");

      restoreFetch();
      restoreFetch = installFetch(() => status(503));

      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("network-error");
      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(service.getCurrentSessionSnapshot().token).toBe("still-valid");
    });

    it("coalesces concurrent refresh revalidations so a spent sibling refresh token does not sign out", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "old-token");

      const refreshResponse = createDeferredResponse();
      let refreshCalls = 0;

      restoreFetch();
      restoreFetch = installFetch((input, init) => {
        const url = typeof input === "string" ? input : String(input);
        if (
          url === VALIDATION_URL &&
          init?.headers?.Authorization === "Bearer old-token"
        ) {
          return status(401);
        }
        if (
          url === REFRESH_URL &&
          init?.headers?.Authorization === "Bearer old-token"
        ) {
          refreshCalls += 1;
          if (refreshCalls === 1) {
            return refreshResponse.promise;
          }
          return status(401);
        }
        if (
          url === VALIDATION_URL &&
          init?.headers?.Authorization === "Bearer rotated-token"
        ) {
          return okWithProfile();
        }
        return status(500);
      });

      const first = service.revalidateCurrentContext();
      const second = service.revalidateCurrentContext();

      await vi.waitFor(() => {
        expect(refreshCalls).toBeGreaterThan(0);
      });
      refreshResponse.resolve(
        new Response(
          JSON.stringify({
            token: "rotated-token",
            refreshToken: "rotated-token-refresh",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

      const outcomes = await Promise.all([first, second]);

      expect(outcomes.map((outcome) => outcome?.kind)).toEqual([
        "valid",
        "valid",
      ]);
      expect(refreshCalls).toBe(1);
      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(service.getCurrentSessionSnapshot().token).toBe("rotated-token");
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("rotated-token", "rotated-token-refresh"),
      );
      expect(service.getLastError()).toBeNull();
    });

    it("returns superseded when the expected lease is replaced during validation", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "old-token");

      const provider = service.getRequestContextProvider();
      const oldContext = provider.current();
      if (oldContext === null) {
        throw new Error("expected the old session to be signed in");
      }

      const oldValidation = createDeferredResponse();
      let oldValidationStarted = false;
      restoreFetch();
      restoreFetch = installFetch((input, init) => {
        const url = typeof input === "string" ? input : String(input);
        if (
          url === VALIDATION_URL &&
          init?.headers?.Authorization === "Bearer old-token"
        ) {
          oldValidationStarted = true;
          return oldValidation.promise;
        }
        return okWithProfile();
      });

      const pending = service.revalidateExpectedBearer(oldContext.credentials);
      await vi.waitFor(() => {
        expect(oldValidationStarted).toBe(true);
      });

      let tokenStoreDeletes = 0;
      const originalDelete = host.tokenStore.delete.bind(host.tokenStore);
      host.tokenStore.delete = async (): Promise<void> => {
        tokenStoreDeletes += 1;
        await originalDelete();
      };

      // Replace the whole context/lease while the old AuthnV3 validation is
      // still pending. The stale validation must not clear or mutate this new
      // session when it eventually resolves.
      await service.signOut();
      await deviceSignIn(service, host, "replacement-token");

      const replacementContext = provider.current();
      if (replacementContext === null) {
        throw new Error("expected the replacement session to be signed in");
      }
      const replacementBearer = replacementContext.credentials.getBearerToken();
      const replacementSnapshot = service.getCurrentSessionSnapshot();
      const deletesAfterReplacement = tokenStoreDeletes;

      oldValidation.resolve(await okWithProfile());

      await expect(pending).resolves.toBe("superseded");
      expect(tokenStoreDeletes).toBe(deletesAfterReplacement);
      expect(provider.current()).toBe(replacementContext);
      expect(replacementContext.isAborted).toBe(false);
      expect(replacementContext.credentials.getBearerToken()).toBe(
        replacementBearer,
      );
      expect(service.getCurrentSessionSnapshot()).toEqual(replacementSnapshot);
      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("replacement-token", "replacement-token-refresh"),
      );
    });
  });

  describe("credentials file write before signed-in (owner gate)", () => {
    it("writes tokenStore.signIn BEFORE flipping to signed-in on the device happy path", async () => {
      // Device happy-path characterization:
      //   signIn → device poll authorized → applyTokenInternal →
      //   tokenStore.signIn (file write) → applySignedIn.
      // Pins that the credentials file is written while the store is still
      // "signing-in" (BEFORE the signed-in projection enables host RPCs).
      const { service, host } = makeService();
      const statusAtWrite: string[] = [];
      const originalSignIn = host.tokenStore.signIn.bind(host.tokenStore);
      host.tokenStore.signIn = async (
        tokens: StoredAuthTokens,
        identity: StoredCredentialsIdentity,
      ): Promise<void> => {
        statusAtWrite.push(useAuthStore.getState().status);
        await originalSignIn(tokens, identity);
      };

      await service.start();
      await service.signIn();
      host.deviceFlow.emitResult({
        kind: "authorized",
        token: "happy-token",
        refreshToken: "happy-token-refresh",
      });

      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      });
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("happy-token", "happy-token-refresh"),
      );
      expect(statusAtWrite).toEqual(["signing-in"]);
      expect(service.getCurrentSessionSnapshot().token).toBe("happy-token");
    });
  });

  describe("multi-window session projection on sign-in", () => {
    it("emits a complete signed-in snapshot (token + profile + contextMetadata) for sibling windows", async () => {
      const { service, host } = makeService();
      await service.start();

      const snapshots: AuthSessionSnapshot[] = [];
      service.onSessionSnapshotChange((snapshot) => {
        snapshots.push(snapshot);
      });

      await deviceSignIn(service, host, "win-token");

      const signedIn = snapshots.find((s) => s.status === "signed-in");
      expect(signedIn?.token).toBe("win-token");
      expect(signedIn?.profile?.userId).toBe("user-1");
      expect(signedIn?.contextMetadata?.userId).toBe("user-1");
    });

    it("resumes the same identity in a sibling window via ingestProjectedSessionSnapshot (no device re-run)", async () => {
      const { service: windowA, host: hostA } = makeService();
      await windowA.start();
      await deviceSignIn(windowA, hostA, "shared-token");
      const projected = windowA.getCurrentSessionSnapshot();

      const { service: windowB, host: hostB } = makeService();
      await windowB.ingestProjectedSessionSnapshot(projected);

      // Window B resumes the identity from the projected snapshot alone - it
      // never ran signIn() / beginAuthAttempt nor opened a browser.
      expect(windowB.getCurrentSessionSnapshot().token).toBe("shared-token");
      expect(
        windowB.getRequestContextProvider().current()?.identity.userId,
      ).toBe("user-1");
      expect(hostB.beginAuthAttemptCalls).toBe(0);
      expect(hostB.openedExternalLinks).toHaveLength(0);
      expect(hostB.deviceFlow.startCalls).toBe(0);
    });

    it("persists the rotated pair via tokenStore.rotate on a reactive refresh", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "old-token");
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("old-token", "old-token-refresh"),
      );

      // A reactive revalidation 401s on the current bearer, refreshes once, and
      // rotates the live lease in place via the locked rotate op.
      restoreFetch();
      restoreFetch = installFetch((input, init) => {
        const url = typeof input === "string" ? input : String(input);
        if (
          url === VALIDATION_URL &&
          init?.headers?.Authorization === "Bearer old-token"
        ) {
          return status(401);
        }
        if (
          url === REFRESH_URL &&
          init?.headers?.Authorization === "Bearer old-token"
        ) {
          return okWithRefreshToken("rotated-token");
        }
        if (
          url === VALIDATION_URL &&
          init?.headers?.Authorization === "Bearer rotated-token"
        ) {
          return okWithProfile();
        }
        return status(500);
      });

      const outcome = await service.revalidateCurrentContext();

      expect(outcome?.kind).toBe("valid");
      expect(service.getCurrentSessionSnapshot().token).toBe("rotated-token");
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("rotated-token", "rotated-token-refresh"),
      );
    });

    it("persists the rotated pair via tokenStore.rotate on a proactive refresh", async () => {
      const { service, host } = makeService();
      // 5m of life left → inside the proactive lead window, so an OS resume
      // drives an immediate force-refresh against `/api/v3/auth/refresh`.
      const nearExpiry = jwtExpiringInMs(5 * 60_000);
      await host.tokenStore.signIn(
        { token: nearExpiry, refreshToken: `${nearExpiry}-refresh` },
        { id: "user-1", email: "test@example.com", name: "Test User" },
      );
      await service.start();
      expect(useAuthStore.getState().status).toBe("signed-in");

      const rotated = jwtExpiringInMs(4 * 60 * 60_000);
      restoreFetch();
      restoreFetch = installFetch((input) => {
        const url = typeof input === "string" ? input : String(input);
        if (url === REFRESH_URL) {
          return okWithRefreshToken(rotated);
        }
        return okWithProfile();
      });

      host.emitSystemResumed();

      await vi.waitFor(() => {
        expect(service.getCurrentSessionSnapshot().token).toBe(rotated);
      });
      expect(await host.tokenStore.get()).toEqual(
        expectedStored(rotated, `${rotated}-refresh`),
      );
    });
  });

  describe("identity-transition generation fencing", () => {
    // The attempt epoch is consumed before the finalization's token-save and
    // provisioning awaits, so these races are exactly the window only the
    // identity generation can fence.

    it("a sign-out during the token save wins over the in-flight finalization", async () => {
      const { service, host } = makeService();
      await service.start();
      await service.signIn();

      let releaseSave: () => void = () => undefined;
      const savePending = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let signalSaveStarted: () => void = () => undefined;
      const saveStarted = new Promise<void>((resolve) => {
        signalSaveStarted = resolve;
      });
      const originalSignIn = host.tokenStore.signIn.bind(host.tokenStore);
      host.tokenStore.signIn = async (
        tokens: StoredAuthTokens,
        identity: StoredCredentialsIdentity,
      ): Promise<void> => {
        signalSaveStarted();
        await savePending;
        await originalSignIn(tokens, identity);
      };

      host.deviceFlow.emitResult({
        kind: "authorized",
        token: "raced-token",
        refreshToken: "raced-token-refresh",
      });
      // The finalization validated the token and is now awaiting the save.
      await saveStarted;

      // Sign out while the save is in flight. Its generation bump lands
      // synchronously; the storage clear is SERIALIZED behind the hanging
      // save (last-dispatched op owns the final on-disk state), so the
      // sign-out settles only after the save is released.
      const signOutSettled = service.signOut();
      releaseSave();
      await signOutSettled;
      expect(useAuthStore.getState().status).toBe("signed-out");

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // The stale finalization must not resurrect the signed-in projection.
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getCurrentSessionSnapshot().token).toBeNull();
      expect(await host.tokenStore.get()).toBeNull();
    });

    it("a newer sign-in wins over a finalization awaiting the credentials signIn write", async () => {
      const { service, host } = makeService();
      await service.start();

      let releaseSave: () => void = () => undefined;
      const savePending = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let signalSaveStarted: () => void = () => undefined;
      const saveStarted = new Promise<void>((resolve) => {
        signalSaveStarted = resolve;
      });
      const originalSignIn = host.tokenStore.signIn.bind(host.tokenStore);
      let hangNext = true;
      host.tokenStore.signIn = async (
        tokens: StoredAuthTokens,
        identity: StoredCredentialsIdentity,
      ): Promise<void> => {
        if (hangNext) {
          hangNext = false;
          signalSaveStarted();
          await savePending;
        }
        await originalSignIn(tokens, identity);
      };

      await service.signIn();
      const sessionA = host.deviceFlow.lastSession;
      sessionA?.emit({
        kind: "authorized",
        token: "token-a",
        refreshToken: "token-a-refresh",
      });
      // Attempt A validated and is now awaiting the credentials write.
      await saveStarted;

      await service.signIn();
      expect(useAuthStore.getState().status).toBe("signing-in");

      releaseSave();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // A's finalization must not project its identity over attempt B.
      expect(useAuthStore.getState().status).toBe("signing-in");
      expect(service.getCurrentSessionSnapshot().token).toBeNull();

      // Attempt B still completes normally.
      host.deviceFlow.emitResult({
        kind: "authorized",
        token: "token-b",
        refreshToken: "token-b-refresh",
      });
      await vi.waitFor(() => {
        expect(service.getCurrentSessionSnapshot().token).toBe("token-b");
      });
      expect(useAuthStore.getState().status).toBe("signed-in");
    });

    it("treats a rejected token save as a product sign-in failure and stays retryable", async () => {
      const { service, host } = makeService();
      await service.start();

      const originalSignIn = host.tokenStore.signIn.bind(host.tokenStore);
      host.tokenStore.signIn = (): Promise<void> =>
        Promise.reject(new Error("disk full"));

      await service.signIn();
      host.deviceFlow.emitResult({
        kind: "authorized",
        token: "unsaved-token",
        refreshToken: "unsaved-token-refresh",
      });

      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-out");
      });
      expect(service.getLastError()).toBe(AUTH_ERROR_SIGN_IN_FAILED);
      expect(service.getCurrentSessionSnapshot().token).toBeNull();

      // Terminal failure, not a wedge: a retry with a healthy store succeeds.
      host.tokenStore.signIn = originalSignIn;
      await deviceSignIn(service, host, "retry-after-save-failure");
      expect(useAuthStore.getState().status).toBe("signed-in");
    });

    it("a sign-out during a proactive token refresh is not resurrected by the refresh tail", async () => {
      const { service, host } = makeService();
      // 5m of life left → inside the proactive lead window, so an OS resume
      // drives an immediate force-refresh against `/api/v3/auth/refresh`.
      const nearExpiry = jwtExpiringInMs(5 * 60_000);
      await host.tokenStore.signIn(
        { token: nearExpiry, refreshToken: `${nearExpiry}-refresh` },
        { id: "user-1", email: "test@example.com", name: "Test User" },
      );
      restoreFetch();
      const deferredRefresh = createDeferredResponse();
      let signalRefreshStarted: () => void = () => undefined;
      const refreshStarted = new Promise<void>((resolve) => {
        signalRefreshStarted = resolve;
      });
      restoreFetch = installFetch((input) => {
        const url = typeof input === "string" ? input : String(input);
        if (url === REFRESH_URL) {
          signalRefreshStarted();
          return deferredRefresh.promise;
        }
        return okWithProfile();
      });
      await service.start();
      expect(useAuthStore.getState().status).toBe("signed-in");

      // The wake-driven proactive refresh dispatches and hangs on /refresh
      // inside `tokenStore.rotate`. `delete` is serialized behind that rotate
      // (AuthTokenStore op chain), so signOut must be started while the rotate
      // is in flight and the hang must be released before signOut can finish.
      host.emitSystemResumed();
      await refreshStarted;

      const signOutPromise = service.signOut();

      const rotated = jwtExpiringInMs(4 * 60 * 60_000);
      deferredRefresh.resolve(
        new Response(
          JSON.stringify({
            token: rotated,
            refreshToken: `${rotated}-refresh`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      await signOutPromise;

      // Identity-generation fence: the rotate tail must not re-project signed-in
      // after an explicit sign-out won. The file is gone because delete ran after
      // the in-flight rotate finished (op-chain serialization).
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getCurrentSessionSnapshot().token).toBeNull();
      expect(await host.tokenStore.get()).toBeNull();
    });

    it("start()'s rehydration defers to an interactive sign-in that began mid-validation", async () => {
      const { service, host } = makeService();
      await host.tokenStore.signIn(
        { token: "persisted-token", refreshToken: "persisted-token-refresh" },
        { id: "user-1", email: "test@example.com", name: "Test User" },
      );
      restoreFetch();
      const deferredValidate = createDeferredResponse();
      restoreFetch = installFetch(() => deferredValidate.promise);

      const startPromise = service.start();
      // Let start() get past the token load and dispatch its validation.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      await service.signIn();
      expect(useAuthStore.getState().status).toBe("signing-in");

      deferredValidate.resolve(await okWithProfile());
      await startPromise;

      // The stored-token rehydration must not project the old identity over
      // the interactive attempt the user just started.
      expect(useAuthStore.getState().status).toBe("signing-in");
      expect(service.getCurrentSessionSnapshot().token).toBeNull();
    });
  });

  describe("credentials file authority (tech plan §5)", () => {
    it("device-flow sign-in writes the file BEFORE the signed-in projection", async () => {
      const { service, host } = makeService();
      await service.start();

      const statusAtWrite: string[] = [];
      const originalSignIn = host.tokenStore.signIn.bind(host.tokenStore);
      host.tokenStore.signIn = async (
        tokens: StoredAuthTokens,
        identity: StoredCredentialsIdentity,
      ): Promise<void> => {
        statusAtWrite.push(useAuthStore.getState().status);
        await originalSignIn(tokens, identity);
      };

      await service.signIn();
      host.deviceFlow.emitResult({
        kind: "authorized",
        token: "gate-token",
        refreshToken: "gate-token-refresh",
      });
      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      });
      expect(statusAtWrite).toEqual(["signing-in"]);
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("gate-token", "gate-token-refresh"),
      );
    });

    it("explicit signOut deletes the credentials file", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "live-token");
      expect(await host.tokenStore.get()).not.toBeNull();

      await service.signOut();

      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(await host.tokenStore.get()).toBeNull();
    });

    it("stays signed in when signOut's delete rejects", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "sticky-token");

      host.tokenStore.delete = (): Promise<void> =>
        Promise.reject(new Error("EACCES: credentials locked"));

      await service.signOut();

      // Failed sign-out must never claim signed-out without the delete landing.
      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(service.getCurrentSessionSnapshot().token).toBe("sticky-token");
      // The rejecting stub never removed the entry.
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("sticky-token", "sticky-token-refresh"),
      );
    });

    it("reactive 401 rotates the live session and updates the file", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "live-token");

      restoreFetch();
      restoreFetch = installFetch((input, init) => {
        const url = typeof input === "string" ? input : String(input);
        if (
          url === VALIDATION_URL &&
          init?.headers?.Authorization === "Bearer live-token"
        ) {
          return status(401);
        }
        if (
          url === REFRESH_URL &&
          init?.headers?.Authorization === "Bearer live-token"
        ) {
          return okWithRefreshToken("post-401-token");
        }
        if (
          url === VALIDATION_URL &&
          init?.headers?.Authorization === "Bearer post-401-token"
        ) {
          return okWithProfile();
        }
        return status(500);
      });

      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("valid");
      expect(service.getCurrentSessionSnapshot().token).toBe("post-401-token");
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("post-401-token", "post-401-token-refresh"),
      );
    });

    it("reactive refresh-rejected is UI-only (file kept, session-expired)", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "dead-token");

      restoreFetch();
      restoreFetch = installFetch((input) => {
        const url = typeof input === "string" ? input : String(input);
        if (url === VALIDATION_URL) {
          return status(401);
        }
        if (url === REFRESH_URL) {
          return status(401);
        }
        return status(500);
      });

      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("rejected");
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("dead-token", "dead-token-refresh"),
      );
    });

    it("start() maps get() faults to store-unavailable (resolves, no runtime teardown)", async () => {
      const { service, host } = makeService();
      host.tokenStore.get = (): Promise<StoredCredentials | null> =>
        Promise.reject(new Error("EACCES: credentials unreadable"));

      // Must resolve (not reject) so HostRuntimeProvider keeps the runtime.
      await expect(service.start()).resolves.toBeUndefined();
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getLastError()).toBe(AUTH_ERROR_STORE_UNAVAILABLE);
    });

    it("start() maps rotate() faults to store-unavailable UI signed-out", async () => {
      const { service, host } = makeService();
      await host.tokenStore.signIn(
        { token: "stale-token", refreshToken: "stale-token-refresh" },
        { id: "user-1", email: "test@example.com", name: "Test User" },
      );
      restoreFetch();
      restoreFetch = installFetch(() => status(401));
      host.tokenStore.rotate = (): Promise<TokenRotateResult> =>
        Promise.reject(new Error("EIO: credentials store fault"));

      await expect(service.start()).resolves.toBeUndefined();
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getLastError()).toBe(AUTH_ERROR_STORE_UNAVAILABLE);
      // File kept — automatic failure never deletes.
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("stale-token", "stale-token-refresh"),
      );
    });

    it("reactive rotate() faults map to store-unavailable (file kept)", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "live-token");

      restoreFetch();
      restoreFetch = installFetch((input) => {
        const url = typeof input === "string" ? input : String(input);
        if (url === VALIDATION_URL) {
          return status(401);
        }
        return status(500);
      });
      host.tokenStore.rotate = (): Promise<TokenRotateResult> =>
        Promise.reject(new Error("EACCES: rotate blocked"));

      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("rejected");
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getLastError()).toBe(AUTH_ERROR_STORE_UNAVAILABLE);
      expect(await host.tokenStore.get()).toEqual(
        expectedStored("live-token", "live-token-refresh"),
      );
    });

    it("commit-failed with a foreign pair does not bind the foreign bearer", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "live-token");

      restoreFetch();
      restoreFetch = installFetch((input) => {
        const url = typeof input === "string" ? input : String(input);
        if (url === VALIDATION_URL) {
          return status(401);
        }
        return status(500);
      });
      host.tokenStore.rotate = () =>
        Promise.resolve({
          outcome: "commit-failed" as const,
          pair: {
            token: "foreign-token",
            refreshToken: "foreign-refresh",
            authnBaseUrl: "http://localhost:5005",
            savedAt: new Date().toISOString(),
            user: {
              id: "other-user",
              email: "other@example.com",
              name: "Other User",
            },
          },
        });

      const outcome = await service.revalidateCurrentContext();
      // Foreign commit-failed is treated as transient (network-error to the
      // reactive path): session stays signed in on the original bearer.
      expect(outcome?.kind).toBe("network-error");
      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(service.getCurrentSessionSnapshot().token).toBe("live-token");
      expect(service.getLastError()).toBeNull();
    });
  });

  describe("credentials-file reconcile worker (tech plan §4)", () => {
    it("signed-in + external delete → UI signed-out (no file write)", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "live-token");
      expect(useAuthStore.getState().status).toBe("signed-in");

      // External delete: mutate the map and fire the watcher event without
      // going through AuthService.signOut (which would also clear the UI).
      host.tokenStoreEntries.clear();
      host.notifyTokenStoreChanged();

      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-out");
      });
      expect(service.getCurrentSessionSnapshot().token).toBeNull();
      // Reconcile never writes — file stays absent.
      expect(await host.tokenStore.get()).toBeNull();
    });

    it("signed-in + external same-user rotation → adopts the new bearer (no write)", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "live-token");

      // External rotation: put a new valid token for the same user and notify.
      host.tokenStoreEntries.set("traycer.token", {
        token: "external-rotated",
        refreshToken: "external-rotated-refresh",
        authnBaseUrl: "http://localhost:5005",
        savedAt: new Date().toISOString(),
        user: {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
        },
      });
      restoreFetch();
      restoreFetch = installFetch((input, init) => {
        const url = typeof input === "string" ? input : String(input);
        if (
          url === VALIDATION_URL &&
          init?.headers?.Authorization === "Bearer external-rotated"
        ) {
          return okWithProfile();
        }
        return status(500);
      });
      host.notifyTokenStoreChanged();

      await vi.waitFor(() => {
        expect(service.getCurrentSessionSnapshot().token).toBe(
          "external-rotated",
        );
      });
      expect(useAuthStore.getState().status).toBe("signed-in");
      // Still the external write — reconcile did not re-signIn.
      expect(await host.tokenStore.get()).toEqual(
        expect.objectContaining({ token: "external-rotated" }),
      );
    });

    it("stale reconcile does not clobber a concurrent signIn", async () => {
      const { service, host } = makeService();
      await service.start();

      // Hang the first validate so a reconcile from a pre-signIn notify stays
      // mid-flight while the interactive sign-in completes.
      restoreFetch();
      const deferredValidate = createDeferredResponse();
      let validateCalls = 0;
      restoreFetch = installFetch((input) => {
        const url = typeof input === "string" ? input : String(input);
        if (url === VALIDATION_URL) {
          validateCalls += 1;
          if (validateCalls === 1) {
            return deferredValidate.promise;
          }
          return okWithProfile();
        }
        return status(500);
      });

      // Pre-seed a foreign/stale file and fire reconcile (validate hangs).
      host.tokenStoreEntries.set("traycer.token", {
        token: "stale-external",
        refreshToken: "stale-external-refresh",
        authnBaseUrl: "http://localhost:5005",
        savedAt: new Date().toISOString(),
        user: {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
        },
      });
      host.notifyTokenStoreChanged();
      // Let the reconcile start its validate await.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // Interactive sign-in wins (bumps identityGeneration).
      await service.signIn();
      host.deviceFlow.emitResult({
        kind: "authorized",
        token: "fresh-sign-in",
        refreshToken: "fresh-sign-in-refresh",
      });
      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      });
      expect(service.getCurrentSessionSnapshot().token).toBe("fresh-sign-in");

      // Release the stale reconcile's validation — it must drop on generation.
      deferredValidate.resolve(await okWithProfile());
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(service.getCurrentSessionSnapshot().token).toBe("fresh-sign-in");
    });

    it("ingestProjectedSessionSnapshot drops a projection when generation moved", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "live-token");

      restoreFetch();
      const deferredValidate = createDeferredResponse();
      restoreFetch = installFetch(() => deferredValidate.promise);

      const generationBefore = service.getIdentityGeneration();
      const ingestPromise = service.ingestProjectedSessionSnapshot({
        status: "signed-in",
        token: "projected-token",
        profile: {
          userId: "user-1",
          userName: "Test User",
          email: "test@example.com",
          avatarUrl: null,
        },
        contextMetadata: null,
      });

      // Supersede the projection: local sign-out bumps identityGeneration.
      await service.signOut();
      expect(service.getIdentityGeneration()).toBeGreaterThan(generationBefore);
      expect(useAuthStore.getState().status).toBe("signed-out");

      deferredValidate.resolve(await okWithProfile());
      await ingestPromise;

      // Stale projection must not resurrect signed-in.
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getCurrentSessionSnapshot().token).toBeNull();
    });

    it("ingestProjectedSessionSnapshot defers to a reconcile that adopts a newer bearer mid-validate", async () => {
      const { service, host } = makeService();
      await service.start();
      await deviceSignIn(service, host, "live-token");

      // Hang only the projection's validate; the reconcile's validate of the
      // newer file token must still resolve so adopt can land mid-flight.
      restoreFetch();
      const deferredProjectionValidate = createDeferredResponse();
      restoreFetch = installFetch((input, init) => {
        const url = typeof input === "string" ? input : String(input);
        if (url === VALIDATION_URL) {
          const auth = init?.headers?.Authorization ?? "";
          if (auth === "Bearer projected-token") {
            return deferredProjectionValidate.promise;
          }
          if (auth === "Bearer file-newer-token") {
            return okWithProfile();
          }
        }
        return status(500);
      });

      const ingestPromise = service.ingestProjectedSessionSnapshot({
        status: "signed-in",
        token: "projected-token",
        profile: {
          userId: "user-1",
          userName: "Test User",
          email: "test@example.com",
          avatarUrl: null,
        },
        contextMetadata: null,
      });
      // Let the ingest reach its hung validate await.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // Concurrent file-watcher reconcile adopts a different valid token.
      // This changes currentBearer without bumping identityGeneration.
      host.tokenStoreEntries.set("traycer.token", {
        token: "file-newer-token",
        refreshToken: "file-newer-token-refresh",
        authnBaseUrl: "http://localhost:5005",
        savedAt: new Date().toISOString(),
        user: {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
        },
      });
      host.notifyTokenStoreChanged();

      await vi.waitFor(() => {
        expect(service.getCurrentSessionSnapshot().token).toBe(
          "file-newer-token",
        );
      });

      deferredProjectionValidate.resolve(await okWithProfile());
      await ingestPromise;

      // Projection must not clobber the file-authoritative newer bearer.
      expect(service.getCurrentSessionSnapshot().token).toBe(
        "file-newer-token",
      );
      expect(useAuthStore.getState().status).toBe("signed-in");
    });
  });

  describe("legacy credentials migration (tech plan §6 start pre-step)", () => {
    const LEGACY_ACCESS_KEY = "traycer.token";
    const LEGACY_REFRESH_KEY = "traycer.refresh-token";

    function seedLegacy(host: MockRunnerHost): void {
      host.secureStorageEntries.set(LEGACY_ACCESS_KEY, "legacy-access");
      host.secureStorageEntries.set(LEGACY_REFRESH_KEY, "legacy-refresh");
    }

    // `/api/v3/user` answers the identity probe + startup validate; the refresh
    // endpoint mints the migrated pair (or rejects with a transport failure).
    function installUserAndRefresh(refresh: "ok" | "network"): () => void {
      return installFetch((input) => {
        const url = typeof input === "string" ? input : String(input);
        if (url.endsWith("/api/v3/auth/refresh")) {
          return refresh === "network"
            ? Promise.reject(new Error("refresh network"))
            : Promise.resolve(
                new Response(
                  JSON.stringify({
                    token: "migrated-token",
                    refreshToken: "migrated-refresh",
                  }),
                  {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                  },
                ),
              );
        }
        return okWithProfile();
      });
    }

    it("F absent + legacy present → migrates, wipes the legacy slots, and signs in", async () => {
      const { service, host } = makeService();
      seedLegacy(host);
      restoreFetch = installUserAndRefresh("ok");

      await service.start();

      expect(host.secureStorageEntries.has(LEGACY_ACCESS_KEY)).toBe(false);
      expect(host.secureStorageEntries.has(LEGACY_REFRESH_KEY)).toBe(false);
      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(
        service.getRequestContextProvider().current()?.identity.userId,
      ).toBe("user-1");
      // The file now holds the pair rotated from the legacy refresh token.
      expect((await host.tokenStore.get())?.token).toBe("migrated-token");
    });

    it("F present + legacy present → file-wins, legacy wiped, existing session kept", async () => {
      const { service, host } = makeService();
      await host.tokenStore.signIn(
        { token: "file-token", refreshToken: "file-refresh" },
        { id: "user-1", email: "test@example.com", name: "Test User" },
      );
      seedLegacy(host);
      restoreFetch = installUserAndRefresh("ok");

      await service.start();

      expect(host.secureStorageEntries.has(LEGACY_ACCESS_KEY)).toBe(false);
      expect(useAuthStore.getState().status).toBe("signed-in");
      // The pre-existing file session is not overwritten by the legacy remnant.
      expect((await host.tokenStore.get())?.token).toBe("file-token");
    });

    it("probe network error → retryable, keeps the legacy slots for a later launch", async () => {
      const { service, host } = makeService();
      seedLegacy(host);
      restoreFetch = installFetch((input) => {
        const url = typeof input === "string" ? input : String(input);
        // The identity probe itself fails: nothing is spent, migration defers.
        return url.endsWith("/api/v3/user")
          ? Promise.reject(new Error("user probe network"))
          : Promise.reject(new Error("unexpected call"));
      });

      await service.start();

      expect(host.secureStorageEntries.has(LEGACY_ACCESS_KEY)).toBe(true);
      expect(host.secureStorageEntries.has(LEGACY_REFRESH_KEY)).toBe(true);
      expect(useAuthStore.getState().status).toBe("signed-out");
    });

    it("terminal-dead (legacy refresh rejected, F absent) → wipes the legacy slots and lands signed out", async () => {
      const { service, host } = makeService();
      seedLegacy(host);
      restoreFetch = installFetch((input) => {
        const url = typeof input === "string" ? input : String(input);
        // Identity probe valid, but the legacy refresh is explicitly rejected.
        return url.endsWith("/api/v3/auth/refresh")
          ? status(400)
          : okWithProfile();
      });

      await service.start();

      expect(host.secureStorageEntries.has(LEGACY_ACCESS_KEY)).toBe(false);
      expect(host.secureStorageEntries.has(LEGACY_REFRESH_KEY)).toBe(false);
      expect(useAuthStore.getState().status).toBe("signed-out");
    });

    it("identity-unknown (legacy access expired, F absent) → wipes the legacy slots and lands signed out", async () => {
      const { service, host } = makeService();
      seedLegacy(host);
      restoreFetch = installFetch(() => status(401)); // /user rejects → unknowable

      await service.start();

      expect(host.secureStorageEntries.has(LEGACY_ACCESS_KEY)).toBe(false);
      expect(useAuthStore.getState().status).toBe("signed-out");
    });

    it("no legacy slots → migration is a no-op and wipes nothing", async () => {
      const { service, host } = makeService();
      host.secureStorageEntries.set("unrelated.key", "keep-me");
      restoreFetch = installFetch(() => okWithProfile());

      await service.start();

      expect(host.secureStorageEntries.get("unrelated.key")).toBe("keep-me");
      expect(useAuthStore.getState().status).toBe("signed-out");
    });
  });
});
