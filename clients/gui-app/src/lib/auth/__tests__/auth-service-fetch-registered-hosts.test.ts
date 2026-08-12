/**
 * `AuthService.fetchRegisteredHosts()` in-flight coalescing — two independent
 * callers reach `GET /api/v3/hosts` (the globally-mounted `HostDirectoryService`
 * poll and the Settings liveness query), and their triggers genuinely coincide
 * (a window regaining focus fires both at once). This pins the coalescing
 * itself: callers that arrive together share ONE request; a caller that
 * arrives after it settles gets a real fetch; a rejected request does not pin
 * a poisoned promise for later callers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AuthService } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

const VALIDATION_URL = "http://localhost:5005/api/v3/user";
const HOSTS_URL = "http://localhost:5005/api/v3/hosts";

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
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

function okWithHosts(): Response {
  return new Response(JSON.stringify({ hosts: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: unknown): string {
  return typeof input === "string" ? input : String(input);
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
  const service = new AuthService({ runnerHost: host });
  trackedServices.push(service);
  return { service, host };
}

describe("AuthService.fetchRegisteredHosts — in-flight coalescing", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    restoreFetch = installFetch(() => okWithProfile());
  });

  afterEach(() => {
    while (trackedServices.length > 0) {
      trackedServices.pop()?.dispose();
    }
    useAuthStore.getState().setSignedOut();
    restoreFetch();
  });

  async function signedInService(): Promise<AuthService> {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "user-token", refreshToken: "user-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    await service.start();
    return service;
  }

  it("issues ONE underlying request for two concurrent callers", async () => {
    const service = await signedInService();
    let hostsCalls = 0;
    const pending: { resolve: ((response: Response) => void) | null } = {
      resolve: null,
    };
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = requestUrl(input);
      if (url === HOSTS_URL) {
        hostsCalls += 1;
        return new Promise<Response>((resolve) => {
          pending.resolve = resolve;
        });
      }
      if (url === VALIDATION_URL) return okWithProfile();
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    const callA = service.fetchRegisteredHosts();
    const callB = service.fetchRegisteredHosts();

    expect(hostsCalls).toBe(1);
    pending.resolve?.(okWithHosts());

    const [resultA, resultB] = await Promise.all([callA, callB]);
    expect(hostsCalls).toBe(1);
    expect(resultA?.hosts).toEqual([]);
    // Both callers observe the SAME underlying resolution, not two independent
    // parses of two independent responses.
    expect(resultA).toEqual(resultB);
  });

  it("issues a fresh request for a caller that arrives AFTER the in-flight one settles", async () => {
    const service = await signedInService();
    let hostsCalls = 0;
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = requestUrl(input);
      if (url === HOSTS_URL) {
        hostsCalls += 1;
        return Promise.resolve(okWithHosts());
      }
      if (url === VALIDATION_URL) return okWithProfile();
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    await service.fetchRegisteredHosts();
    expect(hostsCalls).toBe(1);

    await service.fetchRegisteredHosts();
    // A call after the first settled is a genuinely new read, not served from
    // a memo — `directory.refresh()` on picker-open is a correctness path
    // that must be current at that instant.
    expect(hostsCalls).toBe(2);
  });

  it("does not pin a poisoned promise after a rejected request — the next caller gets a real retry", async () => {
    const service = await signedInService();
    let hostsCalls = 0;
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = requestUrl(input);
      if (url === HOSTS_URL) {
        hostsCalls += 1;
        if (hostsCalls === 1) {
          return Promise.reject(new Error("network blip"));
        }
        return Promise.resolve(okWithHosts());
      }
      if (url === VALIDATION_URL) return okWithProfile();
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    // `fetchRegisteredHostsViaHttp` collapses a thrown/rejected `fetch` into a
    // `network-error` outcome, which `performFetchRegisteredHosts` turns back
    // into a thrown `Error` for this caller — but the in-flight slot must
    // still clear once that rejection settles, not stay pinned to it.
    await expect(service.fetchRegisteredHosts()).rejects.toThrow(
      "Couldn't reach Traycer to load your hosts.",
    );
    expect(hostsCalls).toBe(1);

    const secondResult = await service.fetchRegisteredHosts();
    expect(hostsCalls).toBe(2);
    expect(secondResult?.hosts).toEqual([]);
  });

  it("coalesces THREE concurrent callers onto one request, all observing the same result", async () => {
    const service = await signedInService();
    let hostsCalls = 0;
    const pending: { resolve: ((response: Response) => void) | null } = {
      resolve: null,
    };
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = requestUrl(input);
      if (url === HOSTS_URL) {
        hostsCalls += 1;
        return new Promise<Response>((resolve) => {
          pending.resolve = resolve;
        });
      }
      if (url === VALIDATION_URL) return okWithProfile();
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    const calls = [
      service.fetchRegisteredHosts(),
      service.fetchRegisteredHosts(),
      service.fetchRegisteredHosts(),
    ];
    expect(hostsCalls).toBe(1);
    pending.resolve?.(okWithHosts());

    const results = await Promise.all(calls);
    expect(hostsCalls).toBe(1);
    expect(results.every((result) => result?.hosts.length === 0)).toBe(true);
  });
});
