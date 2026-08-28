import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  DefaultHostReadyGate,
  HostReadinessControllerProvider,
} from "@/components/layout/host-readiness-controller";
import { useHostReadinessController } from "@/components/layout/host-readiness-controller-context";
import {
  hostRpcRegistry,
  HostCompatibilityProvider,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * WHY THIS FILE EXISTS. The acceptance line "the app stays mounted across a
 * host switch" had no proving suite. `host-switch-keeps-app-mounted.test.tsx`
 * was proven vacuous in both directions: it hand-supplies
 * `HostReadinessControllerContext` from a hand-made `controllerFor(...)`, so
 * the readiness controller never mounts and a host move has no path to the
 * subject (see that file's own retitled description). It is left exactly as
 * it is - its sentinel pattern (an uncontrolled input + a mount counter, the
 * only way to tell "never unmounted" from "unmounted and rebuilt
 * identically") is reused here, borrowed rather than imported.
 *
 * This is the only suite in the tree that mounts the REAL
 * `HostReadinessControllerProvider` + `DefaultHostReadyGate`, in the
 * production chain and production order (see `traycer-app.tsx`):
 * `RunnerHostProvider` -> `QueryClientProvider` -> `HostRuntimeProvider` ->
 * `HostCompatibilityProvider` -> `HostReadinessControllerProvider` ->
 * `DefaultHostReadyGate` -> app body. Both other readiness suites hand-supply
 * the context instead.
 */

const LOCAL_HOST_ID = "desktop-pid-1";
const REMOTE_HOST_ID = "remote-host-b";

const localSnapshot: LocalHostSnapshot = {
  hostId: LOCAL_HOST_ID,
  availability: "available",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
};

const remoteHostB: HostDirectoryEntry = {
  hostId: REMOTE_HOST_ID,
  label: "Remote Host B",
  kind: "remote",
  websocketUrl: "wss://relay.test.invalid/remote-b",
  version: "1.2.3",
  transportDialability: "dialable",
};

type HostStatusResponse = ResponseOfMethod<HostRpcRegistry, "host.status">;

const compatibleHostStatus: HostStatusResponse = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
  busy: false,
  busySessionCount: 0,
  updateProgress: null,
  busyBreakdown: null,
};

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useRouterState: () => "/" };
});

/**
 * Presence assertions cannot tell "never unmounted" from "unmounted and
 * rebuilt identically" - borrowed from
 * `host-switch-keeps-app-mounted.test.tsx:91-120`. State React does not own
 * (an uncontrolled input written directly into the DOM) plus an independent
 * mount counter: a remount replaces the node and drops the value, a rebuilt
 * DOM node is a NEW node even if it looks identical.
 */
const sentinelMounts = { count: 0 };

function AppSentinel(): ReactNode {
  useEffect(() => {
    sentinelMounts.count += 1;
  }, []);
  return (
    <main data-testid="app-shell">
      <input data-testid="app-scratch" defaultValue="" />
    </main>
  );
}

function readScratch(): string {
  return screen.getByTestId<HTMLInputElement>("app-scratch").value;
}

function typeIntoScratch(text: string): void {
  screen.getByTestId<HTMLInputElement>("app-scratch").value = text;
}

/**
 * REQUIREMENT (ii): a readout derived from the REAL mounted controller that
 * CHANGES across the switch - proof the move actually reached the subject,
 * not just the store. `defaultHostPresentation.targetKind` is the
 * controller's own per-render classification of what the default-host
 * surface is currently pointed at (`resolveHostTargetKind`, keyed off the
 * requester's resolved directory entry), so it genuinely differs between a
 * local host and a remote one - unlike the store fields, which this file does
 * not merely reread.
 */
function TargetKindReadout(): ReactNode {
  const controller = useHostReadinessController();
  return (
    <div data-testid="target-kind-readout">
      {controller.defaultHostPresentation.targetKind}
    </div>
  );
}

function readTargetKind(): string | null {
  return screen.getByTestId("target-kind-readout").textContent;
}

function messengerFactory(): MessengerFactory<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
      handlers: {
        "host.status": () => compatibleHostStatus,
      },
    });
}

/**
 * The runtime hydrates the signed-in user before it publishes a binding; an
 * unanswered `/api/v3/user` leaves the whole chain on its loading fallback,
 * which would make every assertion below vacuous.
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
        new Error(`unexpected fetch in app-stays-mounted test: ${url}`),
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

/**
 * Moves the app-wide pointer the way the real selection-authority bridge
 * would land it (`host-compatibility-provider.test.tsx:812-848`): writing a
 * fresh kernel snapshot directly into the store `useHostClient()` /
 * `useEffectiveHostId()` derive from. That file proves the real bridge - fully
 * mounted here too, via `HostRuntimeProvider` - does not stomp this write.
 */
function setEffectiveHost(hostId: string, revision: number): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: hostId,
    targetHostId: hostId,
    effectiveHostId: hostId,
    leases: [],
    selectionRevision: revision,
  });
}

let restoreFetch: () => void = () => undefined;

beforeEach(() => {
  restoreFetch = installAuthFetch();
  window.localStorage.clear();
  sentinelMounts.count = 0;
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

describe("the app stays mounted across an effective-host switch", () => {
  it("keeps the same app DOM node and reflects the switch in the real controller's target kind", async () => {
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
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <QueryClientProvider client={queryClient}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={messengerFactory()}
            invalidator={null}
            requestId={null}
            // B is a real directory row from the start: `findHostById`
            // (what `createRequesterForHostId` resolves through) is wired
            // straight to `directory.findById`, so a switch to an id the
            // directory has never listed resolves to an unbound requester
            // rather than "B".
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [remoteHostB] })
            }
            fallback={<div data-testid="runtime-fallback">runtime loading</div>}
          >
            <HostCompatibilityProvider>
              <HostReadinessControllerProvider
                onConfigureShell={() => undefined}
                onOpenSettings={() => undefined}
              >
                <DefaultHostReadyGate>
                  <TargetKindReadout />
                  <AppSentinel />
                </DefaultHostReadyGate>
              </HostReadinessControllerProvider>
            </HostCompatibilityProvider>
          </HostRuntimeProvider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );

    // Reach `ready` for the LOCAL host A first (cold-start latch).
    await waitFor(() => {
      expect(screen.getByTestId("app-shell")).toBeTruthy();
    });
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
    await waitFor(() => {
      expect(readTargetKind()).toBe("local");
    });
    const shellBefore = screen.getByTestId("app-shell");
    typeIntoScratch("work-in-progress");
    expect(sentinelMounts.count).toBe(1);

    act(() => {
      setEffectiveHost(REMOTE_HOST_ID, 1);
    });

    await waitFor(() => {
      expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
        REMOTE_HOST_ID,
      );
    });

    // (ii) IS ASSERTED FIRST, and the order is load-bearing rather than
    // stylistic. A readout derived from the REAL mounted controller must have
    // CHANGED across the switch - proof the move reached the subject, not just
    // the store this file wrote to directly. `targetKind` is the controller's
    // own classification of the resolved target entry, and B is a directory
    // row of `kind: "remote"`.
    //
    // Waiting for it BEFORE the no-remount assertions is what makes those
    // assertions mean "did not remount" rather than "has not remounted YET":
    // the store moving is not evidence the controller has re-rendered off it,
    // so a remount scheduled a tick later would land after a check made on the
    // store alone. This suite exists because the previous one asserted against
    // a subject the move never reached; asserting stillness before the subject
    // has provably moved is the same mistake in a smaller window.
    await waitFor(() => {
      expect(readTargetKind()).toBe("remote");
    });

    // (i) MANDATORY - same app DOM node across the switch, the typed-in
    // scratch value preserved, mount count still 1, no full-screen gate.
    expect(screen.getByTestId("app-shell")).toBe(shellBefore);
    expect(readScratch()).toBe("work-in-progress");
    expect(sentinelMounts.count).toBe(1);
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
  });
});
