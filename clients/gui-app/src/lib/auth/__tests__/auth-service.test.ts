import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { StoredAuthTokens } from "@traycer-clients/shared/platform/runner-host";
import {
  AuthService,
  AUTH_CALLBACK_TIMEOUT_MS,
  AUTH_ERROR_LAUNCH_FAILED,
  AUTH_ERROR_SESSION_EXPIRED,
  AUTH_ERROR_SIGN_IN_FAILED,
  AUTH_ERROR_TIMEOUT,
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
    await service.signIn();
    host.emitAuthCallback({ code: "old-token" });
    await vi.waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-in");
    });

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

  it("aborts the current context and emits null on cross-user revalidation", async () => {
    const { service, host } = makeService();
    await service.start();
    await service.signIn();
    host.emitAuthCallback({ code: "user-1-token" });
    await vi.waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe("user-1");
    });

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

  it("treats a 200 response with no usable profile as sign-in-failed on the OAuth callback path", async () => {
    const { service, host } = makeService();
    await service.start();
    restoreFetch();
    restoreFetch = installFetch(() => ok());

    host.emitAuthCallback({ code: "callback-token" });

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

  it("opens the runner-host signInUrl and flips to signing-in on signIn()", async () => {
    const { service, host } = makeService();
    await service.start();

    await service.signIn();

    // signIn now appends the PKCE challenge to the signInUrl, preserving its
    // existing query (redirect_uri) and adding the S256 code_challenge.
    expect(host.openedExternalLinks).toHaveLength(1);
    const opened = host.openedExternalLinks[0];
    expect(opened.startsWith(host.signInUrl)).toBe(true);
    const params = new URL(opened).searchParams;
    expect((params.get("code_challenge") ?? "").length).toBeGreaterThan(0);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(useAuthStore.getState().status).toBe("signing-in");
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

  it("validates and persists a token delivered via onAuthCallback success result", async () => {
    const { service, host } = makeService();
    await service.start();
    await service.signIn();
    restoreFetch();
    const validationCalls: string[] = [];
    restoreFetch = installFetch((input) => {
      validationCalls.push(typeof input === "string" ? input : String(input));
      return okWithProfile();
    });

    host.emitAuthCallback({ code: "new-token" });

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

  it("surfaces sign-in-failed (NOT session-expired) when an OAuth callback token is rejected by AuthnV3", async () => {
    const { service, host } = makeService();
    await service.start();
    restoreFetch();
    restoreFetch = installFetch(() => status(401));

    host.emitAuthCallback({ code: "rejected-token" });

    await vi.waitFor(() => {
      expect(service.getLastError()).toBe(AUTH_ERROR_SIGN_IN_FAILED);
    });
    expect(service.getLastError()).not.toBe(AUTH_ERROR_SESSION_EXPIRED);
    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(await host.tokenStore.get()).toBeNull();
  });

  it("surfaces sign-in-failed when an OAuth callback token validation hits a network error", async () => {
    const { service, host } = makeService();
    await service.start();
    restoreFetch();
    restoreFetch = installFetch(() => Promise.reject(new Error("offline")));

    host.emitAuthCallback({ code: "net-fail-token" });

    await vi.waitFor(() => {
      expect(service.getLastError()).toBe(AUTH_ERROR_SIGN_IN_FAILED);
    });
    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(await host.tokenStore.get()).toBeNull();
  });

  it("returns to signed-out with the shell error on an error callback", async () => {
    const { service, host } = makeService();
    await service.start();

    await host.tokenStore.set({
      token: "stale",
      refreshToken: "stale-refresh",
    });
    host.emitAuthCallback({ error: "user_cancelled" });

    await vi.waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-out");
    });
    expect(service.getLastError()).toBe("user_cancelled");
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
    await service.signIn();
    host.emitAuthCallback({ code: "tok" });
    await vi.waitFor(() => {
      expect(service.getCurrentSessionSnapshot().token).toBe("tok");
    });
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
    await service.signIn();
    host.emitAuthCallback({ code: "tok-a" });
    await vi.waitFor(() => {
      expect(tokens).toContain("tok-a");
    });

    await service.signOut();
    expect(tokens[tokens.length - 1]).toBeNull();
  });

  it("returns to signed-out with auth-timeout when no callback arrives before the timeout", async () => {
    vi.useFakeTimers();
    const { service, host } = makeService();
    await host.tokenStore.set({
      token: "stale",
      refreshToken: "stale-refresh",
    });
    const events: string[] = [];
    service.onChange((statusValue) => {
      events.push(statusValue);
    });

    await service.start();
    await service.signIn();
    expect(useAuthStore.getState().status).toBe("signing-in");

    await vi.advanceTimersByTimeAsync(AUTH_CALLBACK_TIMEOUT_MS + 1);

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getLastError()).toBe(AUTH_ERROR_TIMEOUT);
    expect(await host.tokenStore.get()).toBeNull();
    expect(events).toContain("signed-out");
  });

  it("cancels the pending timeout on a successful callback so no spurious timeout fires", async () => {
    vi.useFakeTimers();
    const { service, host } = makeService();

    await service.start();
    await service.signIn();
    host.emitAuthCallback({ code: "good-token" });

    await vi.waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-in");
    });

    await vi.advanceTimersByTimeAsync(AUTH_CALLBACK_TIMEOUT_MS + 1);

    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(service.getCurrentSessionSnapshot().token).toBe("good-token");
    expect(service.getLastError()).toBeNull();
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

  it("treats an early { error } callback as authoritative over a pending persisted-token load", async () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.ai/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    await host.tokenStore.set({
      token: "stale-token",
      refreshToken: "stale-token-refresh",
    });

    let resolveLoad: (value: StoredAuthTokens | null) => void = () => undefined;
    const pendingLoad = new Promise<StoredAuthTokens | null>((resolve) => {
      resolveLoad = resolve;
    });
    host.tokenStore.get = (): Promise<StoredAuthTokens | null> => pendingLoad;

    const service = trackService(new AuthService({ runnerHost: host }));
    const tokenEvents: Array<string | null> = [];
    service.onSessionSnapshotChange((snapshot) => {
      tokenEvents.push(snapshot.token);
    });
    const startPromise = service.start();

    await Promise.resolve();

    host.emitAuthCallback({ error: "user_cancelled" });

    resolveLoad({ token: "stale-token", refreshToken: "stale-token-refresh" });
    await startPromise;
    await vi.waitFor(() => {
      expect(host.tokenStoreEntries.size).toBe(0);
    });

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(service.getLastError()).toBe("user_cancelled");
    expect(tokenEvents).not.toContain("stale-token");
  });

  it("applies an early code callback delivered before the persisted-token load resolves", async () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.ai/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    await host.tokenStore.set({
      token: "old-token",
      refreshToken: "old-token-refresh",
    });

    let resolveLoad: (value: StoredAuthTokens | null) => void = () => undefined;
    const pendingLoad = new Promise<StoredAuthTokens | null>((resolve) => {
      resolveLoad = resolve;
    });
    host.tokenStore.get = (): Promise<StoredAuthTokens | null> => pendingLoad;

    const service = trackService(new AuthService({ runnerHost: host }));
    // Establish the PKCE verifier so the early code callback can be exchanged.
    await service.signIn();
    const startPromise = service.start();

    await Promise.resolve();

    host.emitAuthCallback({ code: "new-token" });

    resolveLoad({ token: "old-token", refreshToken: "old-token-refresh" });
    await startPromise;

    await vi.waitFor(() => {
      expect(service.getCurrentSessionSnapshot().token).toBe("new-token");
    });
    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(
      Array.from(host.tokenStoreEntries.values()).map((t) => t.token),
    ).toContain("new-token");
  });

  it("treats a sign-in timeout that fires during start() as authoritative over a pending persisted-token load", async () => {
    vi.useFakeTimers();
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.ai/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    await host.tokenStore.set({
      token: "stale-token",
      refreshToken: "stale-token-refresh",
    });

    let resolveLoad: (value: StoredAuthTokens | null) => void = () => undefined;
    const pendingLoad = new Promise<StoredAuthTokens | null>((resolve) => {
      resolveLoad = resolve;
    });
    host.tokenStore.get = (): Promise<StoredAuthTokens | null> => pendingLoad;

    const service = trackService(new AuthService({ runnerHost: host }));
    const startPromise = service.start();

    await Promise.resolve();

    await service.signIn();

    await vi.advanceTimersByTimeAsync(AUTH_CALLBACK_TIMEOUT_MS + 1);

    resolveLoad({ token: "stale-token", refreshToken: "stale-token-refresh" });
    await startPromise;
    await vi.waitFor(() => {
      expect(host.tokenStoreEntries.size).toBe(0);
    });

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(service.getLastError()).toBe(AUTH_ERROR_TIMEOUT);
  });

  it("allows a successful retry after a failed sign-in attempt", async () => {
    const { service, host } = makeService();
    await service.start();

    await service.signIn();
    host.emitAuthCallback({ error: "user_cancelled" });
    await vi.waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-out");
    });
    expect(service.getLastError()).toBe("user_cancelled");

    await service.signIn();
    expect(service.getLastError()).toBeNull();
    expect(useAuthStore.getState().status).toBe("signing-in");

    host.emitAuthCallback({ code: "retry-token" });
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

  it("fails immediately when runnerHost.openExternalLink rejects, clearing any persisted token", async () => {
    const { service, host } = makeService();
    await host.tokenStore.set({
      token: "stale",
      refreshToken: "stale-refresh",
    });
    host.openExternalLink = (): Promise<void> =>
      Promise.reject(new Error("shell cannot open browser"));

    await service.start();
    await service.signIn();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(service.getCurrentSessionSnapshot().token).toBeNull();
    expect(service.getLastError()).toBe(AUTH_ERROR_LAUNCH_FAILED);
    expect(await host.tokenStore.get()).toBeNull();
  });

  it("cancels the pending callback timeout when openExternalLink rejects so auth-timeout cannot fire later", async () => {
    vi.useFakeTimers();
    const { service, host } = makeService();
    host.openExternalLink = (): Promise<void> =>
      Promise.reject(new Error("launch failed"));

    await service.start();
    await service.signIn();

    expect(service.getLastError()).toBe(AUTH_ERROR_LAUNCH_FAILED);

    await vi.advanceTimersByTimeAsync(AUTH_CALLBACK_TIMEOUT_MS + 1);

    expect(service.getLastError()).toBe(AUTH_ERROR_LAUNCH_FAILED);
    expect(useAuthStore.getState().status).toBe("signed-out");
  });

  it("race: handleCallback ignores a replayed OAuth token after the attempt has been consumed by a prior matching callback", async () => {
    const { service, host } = makeService();
    await service.start();
    await service.signIn();

    host.emitAuthCallback({ code: "oauth-token-1" });
    await vi.waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-in");
    });
    expect(service.getCurrentSessionSnapshot().token).toBe("oauth-token-1");

    host.emitAuthCallback({ code: "oauth-token-2" });
    await Promise.resolve();
    await Promise.resolve();

    expect(service.getCurrentSessionSnapshot().token).toBe("oauth-token-1");
  });

  it("emits onErrorChange when lastError transitions null → non-null and back", async () => {
    const { service, host } = makeService();
    const errors: Array<string | null> = [];
    service.onErrorChange((error) => {
      errors.push(error);
    });

    await service.start();
    host.emitAuthCallback({ error: "denied" });
    await vi.waitFor(() => {
      expect(service.getLastError()).toBe("denied");
    });
    expect(errors).toContain("denied");

    await service.signIn();
    expect(errors[errors.length - 1]).toBeNull();
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
      await service.signIn();
      host.emitAuthCallback({ code: "good-token" });
      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      });

      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("valid");
      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(service.getCurrentSessionSnapshot().token).toBe("good-token");
      expect(service.getLastError()).toBeNull();
    });

    it("signs the user out and surfaces SESSION_EXPIRED on rejected", async () => {
      const { service, host } = makeService();
      await service.start();
      await service.signIn();
      host.emitAuthCallback({ code: "to-be-revoked" });
      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      });

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
      await service.signIn();
      host.emitAuthCallback({ code: "still-valid" });
      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      });

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
      await service.signIn();
      host.emitAuthCallback({ code: "old-token" });
      await vi.waitFor(() => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      });

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
    it("preserves callback-provisioned CLI credentials when stale startup cleanup races with auth replay", async () => {
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
      await host.tokenStore.set({
        token: "stale-token",
        refreshToken: "stale-token-refresh",
      });
      restoreFetch();
      restoreFetch = installFetch((_input, init) => {
        const authorization = init?.headers?.Authorization;
        if (authorization === "Bearer fresh-token") {
          return okWithProfile();
        }
        return status(401);
      });
      const service = trackService(new AuthService({ runnerHost: host }));
      await service.signIn();

      host.tokenStore.delete = async (): Promise<void> => {
        host.tokenStoreEntries.clear();
        host.emitAuthCallback({ code: "fresh-token" });
        await vi.waitFor(() => {
          expect(cli.lastLoginToken).toBe("fresh-token");
        });
      };

      await service.start();

      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(service.getCurrentSessionSnapshot().token).toBe("fresh-token");
      expect(cli.lastLoginToken).toBe("fresh-token");
      expect(cli.lastLoginRefreshToken).toBe("fresh-token-refresh");
    });
  });
});
