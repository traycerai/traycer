import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  HostControllerStatus,
  IHostManagement,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import { SurfaceReadinessBoundary } from "@/components/layout/host-readiness-controller";
import { HostReadinessControllerProvider } from "@/components/layout/host-readiness-controller";
import {
  HostCompatibilityProvider,
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import type { HostDirectoryService } from "@/lib/host/host-directory-service";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { lastLocalHostIdKey, lastSelectedHostKey } from "@/lib/persist";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The blocker this file pins: `canProvision` used to be "the target is not
 * remote", which is TRUE for a target that has not resolved at all. A user
 * whose durable selection names a remote host - and whose directory row for
 * it has not arrived - therefore armed the real local-host lifecycle on the
 * machine in front of them: `convergeReady` fired, the removal-state sentinel
 * was read, the one-shot attempt latch was spent on an episode that belonged
 * to a different computer, and the surface said "Starting local Traycer
 * Host…" about a host nobody asked to start.
 *
 * The other half is the opposite mistake: refusing ALL unresolved targets
 * would silence a first-ever install, which has no directory row until
 * provisioning creates one. Both arms are asserted here against the real
 * provider chain, because the defect lived in the wiring between them.
 */

const LOCAL_HOST_ID = "desktop-pid-1";
const REMOTE_HOST_ID = "remote-host-x";

const localSnapshot: LocalHostSnapshot = {
  hostId: LOCAL_HOST_ID,
  availability: "available",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
};

const IDLE_CONTROLLER_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: localSnapshot.version,
  latestVersion: localSnapshot.version,
  stagedVersion: null,
  installedRuntimeVersion: null,
  runningRuntimeVersion: null,
  updateReady: false,
  activation: "activated",
  reachable: true,
  removedByUser: false,
  checkedAt: "2026-05-15T00:00:00Z",
};

interface ManagementSpy {
  readonly management: IHostManagement;
  readonly convergeReadyCalls: () => number;
  readonly removalStateCalls: () => number;
}

/**
 * A management surface that COUNTS the two calls this fix is about. Every
 * other member rejects: if the lifecycle reaches one of them the test should
 * fail loudly rather than quietly pass on a stub.
 */
function buildManagementSpy(): ManagementSpy {
  let convergeReadyCalls = 0;
  let removalStateCalls = 0;
  const notImplemented = (name: string) => () =>
    Promise.reject(new Error(`${name} must not run in this test`));
  const management: IHostManagement = {
    getHostControllerStatus: () => Promise.resolve(IDLE_CONTROLLER_STATUS),
    convergeReady: () => {
      convergeReadyCalls += 1;
      // `running: true` is the "converged" answer; a falsy `running` is how
      // the desktop reports "this host was removed by the user", which would
      // latch the removed surface instead of the install card.
      return Promise.resolve({
        kind: "ok",
        value: { running: true, version: localSnapshot.version },
      });
    },
    getRemovalState: () => {
      removalStateCalls += 1;
      return Promise.resolve({ removedByUser: false });
    },
    applyStaged: notImplemented("applyStaged"),
    activateInstalled: notImplemented("activateInstalled"),
    installVersion: notImplemented("installVersion"),
    uninstallHost: notImplemented("uninstallHost"),
    restartHost: notImplemented("restartHost"),
    uninstallTraycer: notImplemented("uninstallTraycer"),
    clearRemoval: () => Promise.resolve(),
    getHostLogs: notImplemented("getHostLogs"),
    runDoctor: notImplemented("runDoctor"),
    availableVersions: notImplemented("availableVersions"),
    installedRecord: () => Promise.resolve(null),
    registerService: notImplemented("registerService"),
    deregisterService: notImplemented("deregisterService"),
    registryCheck: notImplemented("registryCheck"),
    freePortAndRestart: (input) => Promise.resolve(input),
    cliManifest: () => Promise.resolve(null),
    getHostName: () =>
      Promise.resolve({
        systemName: localSnapshot.systemHostName,
        customName: null,
        effectiveName: localSnapshot.displayName,
      }),
    setHostName: (input) =>
      Promise.resolve({
        systemName: localSnapshot.systemHostName,
        customName: input.customName,
        effectiveName: input.customName ?? localSnapshot.systemHostName,
      }),
  };
  return {
    management,
    convergeReadyCalls: () => convergeReadyCalls,
    removalStateCalls: () => removalStateCalls,
  };
}

/**
 * A signed-in shell. The token store must hold a real session: without it the
 * runtime never mints a `RequestContext`, every readiness answer collapses to
 * `restoring-request-context`, and the arms under test are never reached.
 */
function buildRunnerHost(
  management: IHostManagement,
  startsWithLocalHost: boolean,
): MockRunnerHost {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: startsWithLocalHost ? localSnapshot : null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    hostManagement: management,
  });
  void runnerHost.tokenStore.signIn(
    { token: "test-token", refreshToken: "test-refresh-token" },
    { id: "user-1", email: "test@example.com", name: "Test User" },
  );
  return runnerHost;
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
 * The production chain, in production order (see traycer-app.tsx). The bug
 * lived in how `HostReadinessControllerProvider` drives
 * `HostProvisioningController`, so nothing between them may be stubbed.
 */
function mountRealChain(
  management: IHostManagement,
  startsWithLocalHost: boolean,
): MockRunnerHost {
  const runnerHost = buildRunnerHost(management, startsWithLocalHost);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory()}
          invalidator={null}
          requestId={null}
          // No remote rows: the persisted remote pick stays UNRESOLVED, which
          // is the whole scenario.
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="runtime-fallback">runtime loading</div>}
        >
          <HostCompatibilityProvider>
            <HostReadinessControllerProvider
              onConfigureShell={() => undefined}
              onOpenSettings={() => undefined}
            >
              <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
                <main>app</main>
              </SurfaceReadinessBoundary>
            </HostReadinessControllerProvider>
          </HostCompatibilityProvider>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
  return runnerHost;
}

/** The directory the runtime actually built - the live intent authority. */
function activeDirectory(): HostDirectoryService {
  const directory = getHostBindingSnapshot()?.directory ?? null;
  if (directory === null) throw new Error("expected a started host runtime");
  return directory;
}

/**
 * Storage that refuses every write, the way a full or blocked quota does.
 * `persistHostSelection` / `persistLocalHostId` swallow this by design - the
 * point of these tests is that intent survives it anyway.
 */
function breakStorageWrites(): void {
  const throwQuota = (): void => {
    throw new DOMException("QuotaExceededError", "QuotaExceededError");
  };
  // Two storage implementations exist across Node versions: real jsdom
  // Storage (methods live on Storage.prototype), and - when jsdom's
  // localStorage is unusable at setup, as under Node >= 26.5 - the suite
  // shim from test-browser-apis.ts, a plain object whose `setItem` is an OWN
  // property that a prototype spy never sees. Break whichever one is live.
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(throwQuota);
  if (Object.prototype.hasOwnProperty.call(window.localStorage, "setItem")) {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(throwQuota);
  }
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
        new Error(`unexpected fetch in host compatibility test: ${url}`),
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
  // BEFORE the store teardown, not after it. Two tests here install
  // `breakStorageWrites()`, which makes `Storage.prototype.setItem` throw;
  // `setSignedOut()` persists through that same setter, so restoring last
  // turned a passing test into a DOMException blamed on teardown.
  vi.restoreAllMocks();
  restoreFetch();
  window.localStorage.clear();
  useAuthStore.getState().setSignedOut();
});

describe("local-boot intent", () => {
  it("arms nothing local for an unresolved REMOTE selection", async () => {
    // The durable pick names a remote host; its directory row never arrives.
    window.localStorage.setItem(lastSelectedHostKey(), REMOTE_HOST_ID);
    window.localStorage.setItem(lastLocalHostIdKey(), LOCAL_HOST_ID);
    const spy = buildManagementSpy();

    mountRealChain(spy.management, false);

    // The surface settles on the non-local wait…
    await waitFor(() => {
      expect(screen.getByText("Connecting to Traycer Host…")).toBeTruthy();
    });
    // …and it must never claim this machine's host is starting, nor offer any
    // action against it.
    expect(screen.queryByText("Starting local Traycer Host…")).toBeNull();
    expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();
    expect(screen.queryByTestId("local-host-retry")).toBeNull();
    // The two calls the blocker was about: both belong to a machine the user
    // is not pointed at, and neither may run.
    expect(spy.convergeReadyCalls()).toBe(0);
    expect(spy.removalStateCalls()).toBe(0);
  });

  it("runs the local ensure and draws the install card for a first-ever start", async () => {
    // Nothing remembered and no local row yet: a genuine cold local start.
    // This is the arm that must NOT be sacrificed to close the one above -
    // the rich card is where install progress and the bootstrap.log path live
    // (traycer#862), and a first install is exactly when they are needed.
    const spy = buildManagementSpy();

    mountRealChain(spy.management, false);

    await waitFor(() => {
      expect(spy.convergeReadyCalls()).toBe(1);
    });
    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
    expect(screen.queryByText("Connecting to Traycer Host…")).toBeNull();
  });

  it("treats a durable selection naming this machine as a local start", async () => {
    // A restart/reinstall remembers the local hostId while the host is down.
    // The row may be missing or non-dialable; the intent is still local.
    window.localStorage.setItem(lastSelectedHostKey(), LOCAL_HOST_ID);
    window.localStorage.setItem(lastLocalHostIdKey(), LOCAL_HOST_ID);
    const spy = buildManagementSpy();

    mountRealChain(spy.management, false);

    await waitFor(() => {
      expect(spy.convergeReadyCalls()).toBe(1);
    });
    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
  });

  it("keeps a remote intent when persisting the selection FAILS", async () => {
    // The residual the first fix left behind. `persistHostSelection` swallows
    // write failures by design, so on a machine with blocked storage a live
    // remote pick reads back from storage as "nothing selected" - which is the
    // FIRST-INSTALL answer. Reading intent from the directory's memory instead
    // makes the failure inert: the user is still pointed at a remote host, and
    // the local machine is still left alone.
    const spy = buildManagementSpy();
    // The local host is UP at mount, so provisioning is not armed yet and the
    // counters below start from a clean zero.
    const runnerHost = mountRealChain(spy.management, true);
    await waitFor(() => {
      expect(getHostBindingSnapshot()).not.toBeNull();
    });

    breakStorageWrites();
    act(() => {
      // An explicit pick of a host the directory does not hold: the in-memory
      // intent records it, the persisted copy cannot.
      activeDirectory().selectById(REMOTE_HOST_ID);
    });
    expect(window.localStorage.getItem(lastSelectedHostKey())).toBeNull();

    act(() => {
      // …and now the local host goes down, which is what arms provisioning.
      runnerHost.setLocalHost(null);
    });

    await waitFor(() => {
      expect(screen.getByText("Connecting to Traycer Host…")).toBeTruthy();
    });
    expect(spy.convergeReadyCalls()).toBe(0);
    expect(spy.removalStateCalls()).toBe(0);
  });

  it("still provisions a remembered-local restart when the local-id write FAILS", async () => {
    // The inverse failure, and the reason this cannot be fixed by simply
    // failing closed: with the local-id write broken, storage says "the
    // selection names some id I know nothing about" and a storage-reading
    // implementation classifies a legitimate local restart as remote - which
    // silently blocks the provisioning that would bring the host back.
    window.localStorage.setItem(lastSelectedHostKey(), LOCAL_HOST_ID);
    // Broken BEFORE the runtime starts, so the local id this machine
    // announces is adopted in memory while its persisted copy never lands.
    breakStorageWrites();
    const spy = buildManagementSpy();
    const runnerHost = mountRealChain(spy.management, true);
    await waitFor(() => {
      expect(getHostBindingSnapshot()).not.toBeNull();
    });

    act(() => {
      activeDirectory().selectById(LOCAL_HOST_ID);
    });
    // The id this machine published is held in memory; only its persisted
    // copy was lost.
    expect(window.localStorage.getItem(lastLocalHostIdKey())).toBeNull();
    expect(activeDirectory().readSelectionIntent()).toEqual({
      selectedHostId: LOCAL_HOST_ID,
      localHostId: LOCAL_HOST_ID,
    });

    act(() => {
      runnerHost.setLocalHost(null);
    });

    await waitFor(() => {
      expect(spy.convergeReadyCalls()).toBe(1);
    });
    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
  });
});
