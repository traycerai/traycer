import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  HostControllerStatus,
  IHostManagement,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import {
  DefaultHostReadyGate,
  HostReadinessControllerProvider,
} from "@/components/layout/host-readiness-controller";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import {
  HostCompatibilityProvider,
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useRouterState: () => "/" };
});

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
              <DefaultHostReadyGate>
                <main>app</main>
              </DefaultHostReadyGate>
            </HostReadinessControllerProvider>
          </HostCompatibilityProvider>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
  return runnerHost;
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
  vi.restoreAllMocks();
  restoreFetch();
  window.localStorage.clear();
  useAuthStore.getState().setSignedOut();
});

describe("local-boot intent", () => {
  it("arms nothing local for an unresolved REMOTE selection", async () => {
    // The intent is the selection AUTHORITY's derived effective host now
    // (redesign P1.2), not a persisted key `resolveLocalBootIntent` reads
    // from storage. `lastSelectedHostKey` had no production reader at all and
    // is deleted; `lastLocalHostIdKey` is still LIVE - read by
    // `host-directory-service.ts:22,46` - so this comment used to assert a
    // deadness that was true of one key and false of the other. Registering the remote host in the
    // authority's fleet (so derivation can name it effective) while the
    // DIRECTORY's own remoteFetcher still returns nothing for it reproduces
    // "the directory row never arrives"; with no local host up and no other
    // fleet member, the derivation's third arm makes it effective without
    // an explicit Activate.
    const spy = buildManagementSpy();
    const runnerHost = buildRunnerHost(spy.management, false);
    runnerHost.setHosts([
      {
        hostId: REMOTE_HOST_ID,
        label: "remote",
        kind: "remote",
        websocketUrl: "wss://relay.test.invalid/remote",
        version: "1.2.3",
        transportDialability: "dialable",
      },
    ]);
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
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="runtime-fallback">runtime loading</div>}
          >
            <HostCompatibilityProvider>
              <HostReadinessControllerProvider
                onConfigureShell={() => undefined}
                onOpenSettings={() => undefined}
              >
                <DefaultHostReadyGate>
                  <main>app</main>
                </DefaultHostReadyGate>
                {/* The gate no longer draws "Connecting to Traycer Host…"
                    itself for this kind (the window narrator, D10, owns it
                    now) - see default-host-ready-gate.test.tsx deliverable D.
                    Mounted here as the settle anchor: the modal appearing
                    with NO local bootstrap body is the positive proof this
                    surface reached its settled non-local state, which the
                    negative assertions below then get to run after. */}
                <WindowHostModalHost bypassed={false} />
              </HostReadinessControllerProvider>
            </HostCompatibilityProvider>
          </HostRuntimeProvider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );

    // The surface settles on the non-local wait: the window narrator comes up
    // - the positive proof this reached its non-local settled state.
    //
    // EITHER presentation counts as the anchor. This stack mounts the real
    // gate, so which form the narrator takes depends on whether the gate is
    // still blocking - a detail this fixture is not about, and pinning one
    // testid here would turn a settle anchor into an accidental presentation
    // assertion that goes vacuous when the other form renders.
    await waitFor(() => {
      expect(
        screen.queryByTestId("window-host-modal") ??
          screen.queryByTestId("window-host-startup-card"),
      ).toBeTruthy();
    });
    // WHAT THIS FENCE IS ABOUT, and what it is not. It is about ARMING: the
    // local lifecycle's two calls below belong to a machine the user is not
    // pointed at, and neither may run. It is NOT about the card. An earlier
    // version of this fixture also pinned the card as bodiless for a remote
    // target - no spinner, no "Starting Traycer…" - and that pin was the
    // reported launch: the narrator's card rendering as nothing but the
    // `Open settings` link for exactly this selection, while the two boot
    // surfaces before it (which cannot know the target) drew the full card.
    // The card is drawn now, whatever the target: the same idle heading the
    // surfaces before it use, which names no machine.
    // What the card must still NOT do is offer a host-management action
    // against this machine: nothing has failed and nothing is slow, so there
    // is no Retry of any kind on it.
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
    expect(screen.queryByTestId("local-host-provisioning-retry")).toBeNull();
    // The two calls the blocker was about: both belong to a machine the user
    // is not pointed at, and neither may run.
    expect(spy.convergeReadyCalls()).toBe(0);
    expect(spy.removalStateCalls()).toBe(0);
  });

  it("the AUTHORITY's ensure reaches host management - the port is not a stub", async () => {
    // The counterpart to the negative arm above, and the pin for a fidelity
    // property that is otherwise invisible. `MockRunnerHost` composes the
    // authority's `LocalHostEnsurePort`, and an earlier version of it answered
    // `ok` directly instead of routing to `convergeReady` the way the real
    // `createDesktopLocalHostEnsurePort` does. That satisfied the engine while
    // making the provisioning unobservable to anything watching the
    // controller: an ensure that "succeeded" without the host ever being asked
    // to converge. Nothing failed, because no test looked.
    //
    // Here the local host EXISTS in the fleet and has never been dialed, which
    // is exactly when D14 wants it, so the authority requests the ensure and
    // it must arrive at management. The remote-preferred test above is the
    // negative arm of the same mechanism: derivation that does NOT want local
    // must leave the controller alone.
    const spy = buildManagementSpy();

    mountRealChain(spy.management, true);

    await waitFor(() => {
      expect(spy.convergeReadyCalls()).toBe(1);
    });
  });

  it("does NOT provision a first-ever start from the RENDERER - that actor moved to main", async () => {
    // Nothing preferred and no local row yet: a genuine cold local start.
    //
    // THE ACTOR MOVED, and this test moved with it. It used to assert that
    // the renderer ran the ensure and drew the install card, because
    // the local-host gate fired a once-per-mount `convergeReady`. P1.3
    // retired that - two process actors for one host is what made the ∅
    // definition undecidable - so the renderer must now install NOTHING, and
    // asserting otherwise would be pinning the defect the retirement removed.
    //
    // First install did not disappear with it: it is
    // `armLocalHostBootOnSignIn` in the desktop's launch reconciler
    // (`electron-main/startup/host-launch-converge.ts`), sign-in gated,
    // removal-sentinel gated and retrying, and it is proven THERE - in the
    // process that actually performs it - by that module's own suite. This
    // chain does not mount main, so a renderer test asserting a main-process
    // action could only ever be theatre. What is genuinely this layer's to
    // promise is that it does not act, and does not lie about the host while
    // it waits.
    const spy = buildManagementSpy();

    mountRealChain(spy.management, false);

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });
    expect(spy.convergeReadyCalls()).toBe(0);
    // Still the local surface rather than the remote one - the window knows
    // this is a local boot, it simply is not the thing booting it.
    expect(screen.queryByText("Connecting to Traycer Host…")).toBeNull();
  });
});
