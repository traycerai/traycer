import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { StoredAuthTokens } from "@traycer-clients/shared/platform/runner-host";
import {
  AuthService,
  type AuthSessionSnapshot,
  AUTH_ERROR_DEVICE_DENIED,
  AUTH_ERROR_DEVICE_EXPIRED,
  AUTH_ERROR_LAUNCH_FAILED,
  AUTH_ERROR_SESSION_EXPIRED,
  AUTH_ERROR_SIGN_IN_FAILED,
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
    await host.tokenStore.set({
      token: "persisted-token",
      refreshToken: "persisted-token-refresh",
    });
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
    await host.tokenStore.set({
      token: "persisted-token",
      refreshToken: "persisted-token-refresh",
    });
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
    await host.tokenStore.set({
      token: "persisted-token",
      refreshToken: "persisted-token-refresh",
    });
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
    await host.tokenStore.set({
      token: "persisted-token",
      refreshToken: "persisted-token-refresh",
    });
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
    await host.tokenStore.set({
      token: nearExpiry,
      refreshToken: `${nearExpiry}-refresh`,
    });
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
    await host.tokenStore.set({
      token: farExpiry,
      refreshToken: `${farExpiry}-refresh`,
    });
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
    await host.tokenStore.set({
      token: "expired-token",
      refreshToken: "expired-token-refresh",
    });
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
    expect(await host.tokenStore.get()).toEqual({
      token: "refreshed-token",
      refreshToken: "refreshed-token-refresh",
    });
    expect(service.getLastError()).toBeNull();
    expect(calls).toEqual([
      `GET ${VALIDATION_URL}`,
      `POST ${REFRESH_URL}`,
      `GET ${VALIDATION_URL}`,
    ]);
  });

  it("surfaces session-expired when startup user lookup and refresh both fail", async () => {
    const { service, host } = makeService();
    await host.tokenStore.set({
      token: "stale-token",
      refreshToken: "stale-token-refresh",
    });
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
    expect(await host.tokenStore.get()).toBeNull();
    expect(calls).toEqual([`GET ${VALIDATION_URL}`, `POST ${REFRESH_URL}`]);
  });

  it("clears tokenStore and surfaces session-expired when validation rejects with 401 on start()", async () => {
    const { service, host } = makeService();
    await host.tokenStore.set({
      token: "revoked-token",
      refreshToken: "revoked-token-refresh",
    });
    restoreFetch();
    restoreFetch = installFetch(() => status(401));

    await service.start();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
    expect(await host.tokenStore.get()).toBeNull();
  });

  it("clears tokenStore and surfaces session-expired when validation rejects with 404 on start()", async () => {
    const { service, host } = makeService();
    await host.tokenStore.set({
      token: "missing-user-token",
      refreshToken: "missing-user-token-refresh",
    });
    restoreFetch();
    restoreFetch = installFetch(() => status(404));

    await service.start();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
    expect(await host.tokenStore.get()).toBeNull();
  });

  it("treats a 200 response with no usable profile as session-expired on start()", async () => {
    const { service, host } = makeService();
    await host.tokenStore.set({
      token: "profileless-token",
      refreshToken: "profileless-token-refresh",
    });
    restoreFetch();
    restoreFetch = installFetch(() => ok());

    await service.start();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
    expect(await host.tokenStore.get()).toBeNull();
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

  it("attempts refresh then surfaces session-expired when startup validation stays unreachable", async () => {
    const { service, host } = makeService();
    await host.tokenStore.set({
      token: "offline-token",
      refreshToken: "offline-token-refresh",
    });
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
    expect(await host.tokenStore.get()).toBeNull();
    expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
    expect(calls).toEqual([`GET ${VALIDATION_URL}`, `POST ${REFRESH_URL}`]);
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
    await host.tokenStore.set({
      token: "persisted-token",
      refreshToken: "persisted-token-refresh",
    });
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
    expect(await host.tokenStore.get()).toEqual({
      token: "new-token",
      refreshToken: "new-token-refresh",
    });
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

    await vi.waitFor(() => {
      expect(service.getLastError()).toBe(AUTH_ERROR_SIGN_IN_FAILED);
    });
    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(await host.tokenStore.get()).toBeNull();
  });

  it("clears tokenStore and resets state on signOut()", async () => {
    const { service, host } = makeService();
    await host.tokenStore.set({
      token: "token",
      refreshToken: "token-refresh",
    });
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
    let resolveLoad: (value: StoredAuthTokens | null) => void = () => undefined;
    const pendingLoad = new Promise<StoredAuthTokens | null>((resolve) => {
      resolveLoad = resolve;
    });

    const originalOnAuthCallback = host.onAuthCallback.bind(host);
    host.onAuthCallback = (handler) => {
      authSubscribed = true;
      return originalOnAuthCallback(handler);
    };
    host.tokenStore.get = (): Promise<StoredAuthTokens | null> => pendingLoad;

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
    expect(await host.tokenStore.get()).toEqual({
      token: "retry-token",
      refreshToken: "retry-token-refresh",
    });
  });

  it("fails like a launch failure and clears any persisted token when device authorization fails", async () => {
    const { service, host } = makeService();
    await host.tokenStore.set({
      token: "stale",
      refreshToken: "stale-refresh",
    });
    // A null authorization models a network/5xx authorize failure.
    host.deviceFlow.nextAuthorization = null;

    await service.signIn();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(service.getLastError()).toBe(AUTH_ERROR_LAUNCH_FAILED);
    expect(await host.tokenStore.get()).toBeNull();
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
      expect(await host.tokenStore.get()).toEqual({
        token: "device-token",
        refreshToken: "device-token-refresh",
      });
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
      expect(await host.tokenStore.get()).toEqual({
        token: "rotated-token",
        refreshToken: "rotated-token-refresh",
      });
      expect(service.getLastError()).toBeNull();
    });
  });

  describe("local CLI provisioning (host owner gate)", () => {
    it("provisions local CLI credentials BEFORE flipping to signed-in on the device happy path", async () => {
      // Device happy-path characterization:
      //   signIn → device poll authorized → applyTokenInternal →
      //   ensureLocalProvisioning (cli.cliLogin) → applySignedIn.
      // Pins that provisioning runs while the store is still "signing-in"
      // (i.e. seeded BEFORE the signed-in projection enables host RPCs), and
      // that the minted token/refresh pair is what gets seeded.
      const cli = new MockTraycerCli();
      const host = new MockRunnerHost({
        signInUrl:
          "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
        authnBaseUrl: "http://localhost:5005",
        localHost: null,
        hosts: [],
        workspaceFolderPickerPaths: undefined,
        hasLocalHost: undefined,
        traycerCli: cli,
      });
      const statusAtProvision: string[] = [];
      const originalLogin = cli.cliLogin.bind(cli);
      cli.cliLogin = async (
        token: string,
        refreshToken: string,
      ): Promise<void> => {
        statusAtProvision.push(useAuthStore.getState().status);
        await originalLogin(token, refreshToken);
      };
      const service = trackService(new AuthService({ runnerHost: host }));

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
      // Provisioning seeded the minted token pair...
      expect(cli.lastLoginToken).toBe("happy-token");
      expect(cli.lastLoginRefreshToken).toBe("happy-token-refresh");
      // ...and ran BEFORE the signed-in projection (store still "signing-in").
      expect(statusAtProvision).toEqual(["signing-in"]);
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
  });
});
