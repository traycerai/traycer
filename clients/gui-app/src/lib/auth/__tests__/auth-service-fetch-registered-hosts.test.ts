/**
 * `AuthService.fetchRegisteredHosts()` in-flight coalescing — two independent
 * callers reach `GET /api/v3/hosts` (the globally-mounted `HostDirectoryService`
 * poll and the Settings liveness query), and their triggers genuinely coincide
 * (a window regaining focus fires both at once). This pins the coalescing
 * itself: callers that arrive together share ONE request; a caller that
 * arrives after it settles gets a real fetch; a rejected request does not pin
 * a poisoned promise for later callers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

    const callA = service.fetchRegisteredHosts(service.currentAuthEra());
    const callB = service.fetchRegisteredHosts(service.currentAuthEra());

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

    await service.fetchRegisteredHosts(service.currentAuthEra());
    expect(hostsCalls).toBe(1);

    await service.fetchRegisteredHosts(service.currentAuthEra());
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
    await expect(
      service.fetchRegisteredHosts(service.currentAuthEra()),
    ).rejects.toThrow("Couldn't reach Traycer to load your hosts.");
    expect(hostsCalls).toBe(1);

    const secondResult = await service.fetchRegisteredHosts(
      service.currentAuthEra(),
    );
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
      service.fetchRegisteredHosts(service.currentAuthEra()),
      service.fetchRegisteredHosts(service.currentAuthEra()),
      service.fetchRegisteredHosts(service.currentAuthEra()),
    ];
    expect(hostsCalls).toBe(1);
    pending.resolve?.(okWithHosts());

    const results = await Promise.all(calls);
    expect(hostsCalls).toBe(1);
    expect(results.every((result) => result?.hosts.length === 0)).toBe(true);
  });
});

/**
 * The boundary the same-bearer tests above cannot see: coalescing across an
 * AUTH IDENTITY change.
 *
 * The memo used to be a single unkeyed promise, and one `AuthService` outlives
 * an account switch. So signing out of A and into B while A's request was in
 * flight served B the answer to A's question — another account's host names,
 * ids and public keys rendered as B's own, until some later refresh happened
 * to correct it. Every test in the suite above passed throughout, because they
 * all ask about one identity.
 */
describe("AuthService.fetchRegisteredHosts — identity boundary", () => {
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

  function hostsResponseFor(hostId: string): Response {
    return new Response(
      JSON.stringify({
        hosts: [
          {
            hostId,
            displayName: hostId,
            platform: "Ubuntu",
            kind: "personal",
            publicKey: `pk-${hostId}`,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatePolicy: "manual",
            status: {
              connectivity: "connectable",
              viewerReachability: "unknown",
              clientCloud: "ok",
              updateState: "current",
              appVersion: "1.0.0",
              lastSeenAt: "2026-08-01T00:00:00.000Z",
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  it("never serves account A's in-flight host list to account B", async () => {
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "token-a", refreshToken: "token-a-refresh" },
      { id: "user-a", email: "a@example.com", name: "User A" },
    );
    await service.start();

    const bearersSeen: string[] = [];
    const pendingA: { resolve: ((response: Response) => void) | null } = {
      resolve: null,
    };
    restoreFetch();
    restoreFetch = installFetch((input, init) => {
      const url = requestUrl(input);
      if (url === HOSTS_URL) {
        const authorization = init?.headers?.["Authorization"] ?? "";
        bearersSeen.push(authorization);
        if (authorization === "Bearer token-a") {
          return new Promise<Response>((resolve) => {
            pendingA.resolve = resolve;
          });
        }
        return Promise.resolve(hostsResponseFor("host-of-b"));
      }
      if (url === VALIDATION_URL) return okWithProfile();
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    // A's background poll is in flight and deliberately left hanging.
    const callA = service.fetchRegisteredHosts(service.currentAuthEra());
    expect(bearersSeen).toEqual(["Bearer token-a"]);

    // The user signs into B in the same app lifetime — same `AuthService`.
    // Awaited to the point where the service has actually adopted B's bearer:
    // the reconcile validates the inbound token before switching, and a caller
    // that races that window is asking a question the service cannot yet
    // answer as B. What this test is about is what happens AFTER the switch,
    // with A's request still outstanding.
    await host.tokenStore.signIn(
      { token: "token-b", refreshToken: "token-b-refresh" },
      { id: "user-b", email: "b@example.com", name: "User B" },
    );
    await vi.waitFor(() => {
      expect(service.getCurrentSessionSnapshot().token).toBe("token-b");
    });

    const resultB = await service.fetchRegisteredHosts(
      service.currentAuthEra(),
    );

    // B got its OWN request, under its own bearer...
    expect(bearersSeen).toEqual(["Bearer token-a", "Bearer token-b"]);
    // ...and its own hosts. This is the assertion the bug failed: B saw
    // `host-of-a`.
    expect(resultB?.hosts.map((entry) => entry.hostId)).toEqual(["host-of-b"]);

    // A's request settling afterwards must not retroactively pin anything.
    pendingA.resolve?.(hostsResponseFor("host-of-a"));
    const resultA = await callA;
    expect(resultA?.hosts.map((entry) => entry.hostId)).toEqual(["host-of-a"]);

    // And the slot A's `finally` sees is B's, not its own — a third caller
    // still gets a real read rather than a cleared-then-stale memo.
    await service.fetchRegisteredHosts(service.currentAuthEra());
    expect(bearersSeen).toEqual([
      "Bearer token-a",
      "Bearer token-b",
      "Bearer token-b",
    ]);
  });
});
