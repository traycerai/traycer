import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  useHostClient,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * THE UNSTATED PREMISE THIS FILE PINS: readiness freshness in this app rests
 * on an identity transition moving the selection store, which is what
 * re-creates the effective requester every dependent memoizes on.
 * `useHostClient()` (`runtime.ts`) memoizes on `[spine, effectiveHostId]`, so
 * a consumer that reads its host id off the client it was handed only ever
 * re-reads because a NEW requester was minted - and nothing mints one unless
 * `effectiveHostId` actually changes identity in the store.
 *
 * Every other suite in this area hand-supplies that wake by writing straight
 * into `useSelectionAuthorityStore` (e.g. `applyKernelSnapshot` in
 * `host-switch-keeps-app-mounted.test.tsx` /
 * `host-compatibility-provider.test.tsx`), so none of them can verify the
 * PRODUCER of that wake. This suite drives the real producer end to end: the
 * mock's `selectionIdentity` port (`InMemoryAuthorityIdentitySource`) into the
 * real `createInProcessSelectionAuthority` engine - the SAME engine desktop
 * runs, with `RotatingSelectionAuthorityClient` rotating the client on
 * `reattachRequired` - through the real `mountSelectionAuthorityBridge` and
 * into the store `useEffectiveHostId()` reads.
 *
 * SCOPE LIMIT, not a defect to fix: this proves movement off a NON-NULL
 * effective host (host A). A transition starting from ∅ (`effectiveHostId`
 * already null) moves other store fields - `preferredHostId`, `leases`,
 * `attached` - while `effectiveHostId` itself stays `null`, and a memo keyed
 * on that value alone does not re-create for that case. That starting
 * condition is not exercised here.
 */

const LOCAL_HOST_ID = "desktop-pid-1";

const localSnapshot: LocalHostSnapshot = {
  hostId: LOCAL_HOST_ID,
  availability: "available",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
};

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useRouterState: () => "/" };
});

/**
 * The runtime hydrates the signed-in user before it publishes a binding; an
 * unanswered `/api/v3/user` leaves the whole chain on its loading fallback,
 * which would make every assertion below vacuous. Copied verbatim in spirit
 * from `local-boot-intent.test.tsx`.
 */
function installAuthFetch(): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/v3/user")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user: {
                id: "test-user",
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
                userID: "test-user",
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
            { status: 200 },
          ),
        );
      }
      return Promise.reject(
        new Error(`unexpected fetch in identity-transition test: ${url}`),
      );
    },
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

function messengerFactory(): MessengerFactory<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => "req-1",
      handlers: {},
    });
}

/**
 * Records the requester `useHostClient()` returns on every commit.
 *
 * Deliberately NOT claiming to fire only when the identity changed - `props`
 * is a fresh object each render, so this effect runs on every commit and the
 * log holds duplicates. That costs nothing here because the ASSERTION is on
 * object identity (`not.toBe`), which is the fact under test: `useHostClient()`
 * memoizes on `[spine, effectiveHostId]`, so a different object in this log
 * means that memo re-created rather than continuing to serve the old
 * requester. Filtering the log would make the effect's dependency list carry
 * the claim instead of the assertion, which is the weaker place for it.
 */
function ClientIdentityProbe(props: {
  readonly onClient: (client: HostClient<HostRpcRegistry>) => void;
}): ReactNode {
  const client = useHostClient();
  useEffect(() => {
    props.onClient(client);
  }, [client, props]);
  return null;
}

function buildRunnerHost(): MockRunnerHost {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: localSnapshot,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  void runnerHost.tokenStore.signIn(
    { token: "test-token", refreshToken: "test-refresh-token" },
    { id: "user-1", email: "test@example.com", name: "Test User" },
  );
  return runnerHost;
}

let restoreFetch: () => void = () => undefined;

beforeEach(() => {
  restoreFetch = installAuthFetch();
  window.localStorage.clear();
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "test-user", userName: "Test User", email: "test@example.com" },
      { userId: "test-user", username: "Test User" },
      [],
    );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restoreFetch();
  window.localStorage.clear();
  useAuthStore.getState().setSignedOut();
  useSelectionAuthorityStore.getState().reset();
});

describe("an identity transition moves the selection store", () => {
  it("leaves host A and mints a new useHostClient() requester after selectionIdentity advances", async () => {
    const runnerHost = buildRunnerHost();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const clients: HostClient<HostRpcRegistry>[] = [];

    render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <QueryClientProvider client={queryClient}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={messengerFactory()}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="runtime-fallback">runtime loading</div>}
          >
            <ClientIdentityProbe
              onClient={(client) => {
                clients.push(client);
              }}
            />
          </HostRuntimeProvider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );

    // 1. Settle on a NON-NULL effective host (host A). A store that never
    // reached one would make every assertion below vacuous, so fail loudly
    // here rather than let a later assertion misreport why it failed.
    await waitFor(() => {
      expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
        LOCAL_HOST_ID,
      );
    });
    await waitFor(() => {
      expect(clients.length).toBeGreaterThan(0);
    });
    const requesterBeforeTransition = clients[clients.length - 1];
    expect(requesterBeforeTransition.getActiveHostId()).toBe(LOCAL_HOST_ID);

    // 2 & 3. Drive the REAL producer: advance the mock's identity source, the
    // same port `createInProcessSelectionAuthority` mounted this engine
    // against. This runs the engine's `applyIdentity` -> `runIdentityTransition`
    // synchronously, which is why the advance is wrapped in `act`.
    act(() => {
      runnerHost.selectionIdentity.set("user-b");
    });

    // 4(a). The store LEFT host A.
    await waitFor(() => {
      expect(useSelectionAuthorityStore.getState().effectiveHostId).not.toBe(
        LOCAL_HOST_ID,
      );
    });

    // 4(b). The probe recorded a NEW requester identity after the transition -
    // the proof that `useHostClient()`'s memo actually re-created rather than
    // continuing to serve the pre-transition requester.
    await waitFor(() => {
      expect(clients[clients.length - 1]).not.toBe(requesterBeforeTransition);
    });
  });
});
