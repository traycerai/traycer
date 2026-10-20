/**
 * The grant cache is keyed by minter object, and the real minter is the one
 * `AuthService` for the whole app run: it stays the same object across a
 * sign-out and the next sign-in. A grant is "the session's" (see
 * `executable-write-grant.ts`), so a grant minted before a sign-out must not be
 * sent after signing in again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AuthService } from "@/lib/auth/auth-service";
import { resolveExecutableWriteGrant } from "@/lib/environment/executable-write-grant";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";

// The identity route the sign-in validation hits; the fixture answers it.
const VALIDATION_URL = "http://localhost:5005/api/v3/user/negotiated";
const BEARER = "user-token";
const HOST_ID = "host-1";
const NOW = 1_000;

const trackedServices: AuthService[] = [];

function installFetch(
  handler: (input: unknown) => Promise<Response>,
): () => void {
  const originalFetch = globalThis.fetch;
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

async function signIn(host: MockRunnerHost): Promise<void> {
  await host.tokenStore.signIn(
    { token: BEARER, refreshToken: "user-token-refresh" },
    { id: "user-1", email: "test@example.com", name: "Test User" },
  );
}

describe("resolveExecutableWriteGrant across a sign-out on the same AuthService", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    restoreFetch = installFetch((input) => {
      if (String(input) === VALIDATION_URL) return okWithProfile();
      return Promise.resolve(new Response(null, { status: 500 }));
    });
  });

  afterEach(() => {
    while (trackedServices.length > 0) {
      trackedServices.pop()?.dispose();
    }
    useAuthStore.getState().setSignedOut();
    restoreFetch();
    vi.restoreAllMocks();
  });

  it("a grant minted before a sign-out is not reused after signing in again on the same service", async () => {
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
    await signIn(host);
    await service.start();

    let minted = 0;
    const mint = vi
      .spyOn(host, "mintExecutableWriteGrant")
      .mockImplementation(() => {
        minted += 1;
        return Promise.resolve({
          kind: "ok",
          grant: `grant-${minted}`,
          expiresInSeconds: 600,
        });
      });
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
      },
    });
    const now = (): number => NOW;

    await expect(
      resolveExecutableWriteGrant(service, client, now),
    ).resolves.toBe("grant-1");

    await service.signOut();
    await signIn(host);
    await service.start();

    await expect(
      resolveExecutableWriteGrant(service, client, now),
    ).resolves.toBe("grant-2");
    expect(mint).toHaveBeenCalledTimes(2);
  });
});
