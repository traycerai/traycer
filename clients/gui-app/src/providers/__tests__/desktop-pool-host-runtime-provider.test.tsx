import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
  createFakeAuthorityClock,
  createTestAuthority,
} from "@traycer-clients/shared/host-selection/__tests__/selection-authority-harness";
import { createInProcessSelectionAuthorityClient } from "@traycer-clients/shared/host-selection/in-process-selection-authority";
import { silentAuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { poolSessionPresence } from "@traycer-clients/shared/host-transport/remote/pool-session-presence";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
} from "@/lib/host";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { HostCompatibilityProvider } from "@/lib/host/compatibility-provider";
import { HostReadinessControllerProvider } from "@/components/layout/host-readiness-controller";
import { HostReadyGate } from "@/components/layout/host-ready-gate";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { hashAppQueryKey } from "@/lib/query/query-key-hash";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { installAuthValidationFetch } from "../../../__tests__/test-browser-apis";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouterState: ({
      select,
    }: {
      readonly select: (state: {
        readonly location: { readonly pathname: string };
      }) => unknown;
    }) => select({ location: { pathname: "/" } }),
  };
});

vi.mock("@/components/layout/header/app-header", () => ({
  AppHeader: () => <header />,
}));

class DesktopPoolRunnerHost extends MockRunnerHost {
  override readonly poolBaseUrl = "wss://pool.test/v1/session";

  constructor() {
    super({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "https://authn.traycer.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: false,
      traycerCli: undefined,
    });
  }
}

const bindingsRef: { current: HostRuntimeBinding<HostRpcRegistry> | null } = {
  current: null,
};

function RuntimeBindingProbe() {
  const binding = useHostBinding();
  useEffect(() => {
    bindingsRef.current = binding;
  }, [binding]);
  return <div data-testid="runtime-published" />;
}

afterEach(() => {
  cleanup();
  bindingsRef.current = null;
  useAuthStore.getState().setSignedOut();
  useSelectionAuthorityStore.getState().reset();
});

describe("desktop pool build through the real host runtime provider", () => {
  it("opens the app when the attached authority reports that the pool serves it", async () => {
    const runnerHost = new DesktopPoolRunnerHost();
    await runnerHost.tokenStore.signIn(
      { token: "pool-test-token", refreshToken: "pool-test-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [],
      },
      initialIdentityKey: "user-1",
      clock: createFakeAuthorityClock(0),
      poolConfigured: true,
    });
    const authorityClient = createInProcessSelectionAuthorityClient(
      authority.engine,
      silentAuthorityLog,
    );
    Object.defineProperty(runnerHost, "selectionAuthority", {
      configurable: true,
      value: authorityClient,
    });
    const restoreValidation = installAuthValidationFetch();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, queryKeyHashFn: hashAppQueryKey },
        mutations: { retry: false },
      },
    });
    const sessionId = "desktop-pool-readiness-session";

    try {
      const view = render(
        <RunnerHostContext.Provider value={runnerHost}>
          <QueryClientProvider client={queryClient}>
            <HostRuntimeProvider
              registry={hostRpcRegistry}
              fallback={<div data-testid="provider-fallback" />}
              messengerFactory={null}
              invalidator={null}
              requestId={null}
              remoteFetcher={() =>
                Promise.resolve({ kind: "hosts", entries: [] })
              }
            >
              <RuntimeBindingProbe />
              <HostCompatibilityProvider>
                <HostReadinessControllerProvider
                  onConfigureShell={() => undefined}
                  onOpenSettings={() => undefined}
                >
                  <HostReadyGate>
                    <main data-testid="desktop-pool-ready">app</main>
                  </HostReadyGate>
                </HostReadinessControllerProvider>
              </HostCompatibilityProvider>
            </HostRuntimeProvider>
          </QueryClientProvider>
        </RunnerHostContext.Provider>,
      );

      const binding = await waitFor(() => {
        expect(screen.getByTestId("runtime-published")).toBeTruthy();
        expect(useSelectionAuthorityStore.getState().attached).toBe(true);
        expect(readProcessHostRpcTierPlan().pool?.hostId).toBe(POOL_HOST_ID);
        const publishedBinding = bindingsRef.current;
        if (publishedBinding === null)
          throw new Error("runtime binding was not published");
        return publishedBinding;
      });
      expect(binding.directory.findById(POOL_HOST_ID)?.websocketUrl).toBe(
        runnerHost.poolBaseUrl,
      );
      expect(screen.queryByTestId("desktop-pool-ready")).toBeNull();
      expect(screen.getByTestId("host-ready-gate")).toBeTruthy();

      act(() => {
        authority.fleet.publish(
          authority.identity.current().generation,
          null,
          [],
        );
        poolSessionPresence.sessionEstablished(POOL_HOST_ID, sessionId);
      });

      await waitFor(() => {
        expect(authority.engine.snapshot().servingPeer).toEqual({
          kind: "pool",
        });
        expect(useSelectionAuthorityStore.getState().servingPeer).toEqual({
          kind: "pool",
        });
        expect(screen.getByTestId("desktop-pool-ready")).toBeTruthy();
      });

      view.unmount();
      act(() => poolSessionPresence.sessionLost(POOL_HOST_ID, sessionId));
      queryClient.clear();
    } finally {
      act(() => poolSessionPresence.sessionLost(POOL_HOST_ID, sessionId));
      queryClient.clear();
      restoreValidation();
      authorityClient.dispose();
      authority.dispose();
    }
  });
});
