// `HostControllerStatus.lastEnsureFailure` (a failed ensure's own
// message, set by desktop main on every failed converge - launch or Retry -
// and cleared on the next ok ensure or once the host is reachable) must reach
// the DOM verbatim in exactly one element, `host-ensure-failure-message`, in
// each of the three settled-failure bodies of THIS machine's host. It must
// never show while an ensure is in flight.
//
// Real provider chains throughout (per the brief): `HostControllerStatus`
// travels from the mocked `IHostManagement.getHostControllerStatus()` through
// the REAL `HostProvisioningController` / `HostReadinessControllerProvider` /
// `DefaultHostReadyGate` / `WindowHostModalHost` stack, exactly as
// `local-boot-intent.test.tsx` and `host-readiness-controller.test.tsx` do it.
// A hand-built `DefaultHostReadinessPresentation` would not see this field at
// all - the fix reads it inside the provisioning lifecycle, not at a seam a
// hand-built object could stand in for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  ConvergeReadyOk,
  HostControllerStatus,
  HostEnsureFailure,
  IHostManagement,
  LocalHostSnapshot,
  MutationOutcome,
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
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useRouterState: () => "/" };
});

const SENTENCE =
  "the Traycer Host task is disabled in Task Scheduler; enable it or run `traycer host service install`";
const ENSURE_FAILURE: HostEnsureFailure = {
  message: SENTENCE,
  code: "E_SERVICE_REGISTRATION_DISABLED",
};

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
  localAttempt: null,
  removedByUser: false,
  checkedAt: "2026-05-15T00:00:00Z",
  lastEnsureFailure: null,
  updateDeferral: null,
};

interface ManagementSpy {
  readonly management: IHostManagement;
  readonly convergeReadyCalls: () => number;
}

/**
 * Same shape as `local-boot-intent.test.tsx`'s `buildManagementSpy`, widened
 * to take the controller-status and convergeReady answers this file's rows
 * each need, so `getHostControllerStatus` can carry a `lastEnsureFailure`
 * fixture without every row re-declaring the whole `IHostManagement` surface.
 */
function buildManagementSpy(options: {
  readonly getHostControllerStatus: () => Promise<HostControllerStatus>;
  readonly convergeReady: () => Promise<MutationOutcome<ConvergeReadyOk>>;
}): ManagementSpy {
  let convergeReadyCalls = 0;
  const notImplemented = (name: string) => () =>
    Promise.reject(new Error(`${name} must not run in this test`));
  const management: IHostManagement = {
    getHostControllerStatus: options.getHostControllerStatus,
    convergeReady: () => {
      convergeReadyCalls += 1;
      return options.convergeReady();
    },
    getRemovalState: () => Promise.resolve({ removedByUser: false }),
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
    freePortAndRestart: (input) =>
      Promise.resolve({ kind: "applied" as const, ...input }),
    runDoctorRepairQueued: () => Promise.resolve({ kind: "applied" as const }),
    freePortAndRestartIfIdle: () =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "ok" as const, value: null },
      }),
    cliManifest: () => Promise.resolve(null),
    maintenanceUpdateCheck: notImplemented("maintenanceUpdateCheck"),
    maintenanceDoctor: notImplemented("maintenanceDoctor"),
    maintenanceInstallationInfo: notImplemented("maintenanceInstallationInfo"),
    maintenanceInstallVersion: notImplemented("maintenanceInstallVersion"),
    restartHostIfIdle: notImplemented("restartHostIfIdle"),
    restartHostServiceIfHostIdle: notImplemented(
      "restartHostServiceIfHostIdle",
    ),
    runDoctorRepairIfIdle: notImplemented("runDoctorRepairIfIdle"),
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
  return { management, convergeReadyCalls: () => convergeReadyCalls };
}

interface EnableServiceManagementSpy {
  readonly management: IHostManagement;
  readonly registerServiceCalls: () => readonly {
    readonly expectedHostId: string;
  }[];
}

/**
 * Same shape as {@link buildManagementSpy}, plus a working
 * `runDoctorRepairQueued` so the Enable-service tests below can click the
 * button and read back what it dispatched.
 */
function buildManagementSpyWithRegisterService(
  ensureFailure: HostEnsureFailure,
): EnableServiceManagementSpy {
  const calls: { readonly expectedHostId: string }[] = [];
  const spy = buildManagementSpy({
    getHostControllerStatus: () =>
      Promise.resolve({
        ...IDLE_CONTROLLER_STATUS,
        reachable: false,
        lastEnsureFailure: ensureFailure,
      }),
    convergeReady: () =>
      Promise.reject(new Error("convergeReady must not run in this test")),
  });
  const management: IHostManagement = {
    ...spy.management,
    runDoctorRepairQueued: (input) => {
      if (input.repair === "register-service") {
        calls.push({ expectedHostId: input.expectedHostId });
      }
      return Promise.resolve({ kind: "applied" as const });
    },
  };
  return { management, registerServiceCalls: () => calls };
}

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
 * The production chain, in production order, WITH the window narrator: the
 * narrator is the reader for the settled cold-start card and the post-latch
 * `no-usable-host` dialog, so a chain without it can only ever reach the
 * gate's own `provisioning-error` card.
 */
interface MountedRealChain {
  readonly runnerHost: MockRunnerHost;
  readonly queryClient: QueryClient;
}

function mountRealChainWithNarrator(
  management: IHostManagement,
  startsWithLocalHost: boolean,
): MountedRealChain {
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
              <WindowHostModalHost bypassed={false} />
            </HostReadinessControllerProvider>
          </HostCompatibilityProvider>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
  return { runnerHost, queryClient };
}

function installAuthFetch(): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/v3/user/negotiated")) {
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
            {
              status: 200,
              headers: { "x-traycer-user-record-version": "2.0" },
            },
          ),
        );
      }
      return Promise.reject(
        new Error(`unexpected fetch in host ensure failure test: ${url}`),
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

function narratorSurface(): HTMLElement | null {
  return (
    screen.queryByTestId("window-host-modal") ??
    screen.queryByTestId("window-host-startup-card")
  );
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

describe("host-ensure-failure-message", () => {
  it("the automatic launch's settled failure is shown verbatim, before the renderer ever calls convergeReady", async () => {
    const spy = buildManagementSpy({
      getHostControllerStatus: () =>
        Promise.resolve({
          ...IDLE_CONTROLLER_STATUS,
          reachable: false,
          lastEnsureFailure: ENSURE_FAILURE,
        }),
      convergeReady: () =>
        Promise.reject(new Error("convergeReady must not run in this test")),
    });

    mountRealChainWithNarrator(spy.management, false);

    await waitFor(() => {
      expect(narratorSurface()).not.toBeNull();
    });
    const messageEl = screen.queryByTestId("host-ensure-failure-message");
    expect(messageEl).not.toBeNull();
    expect(messageEl?.textContent).toBe(SENTENCE);
    expect(messageEl?.className ?? "").toContain("line-clamp-4");
    expect(messageEl?.className ?? "").toContain("select-text");
    expect(spy.convergeReadyCalls()).toBe(0);
  });

  it("the settled-only guard - the message is withheld while an ensure is in flight", async () => {
    const spy = buildManagementSpy({
      getHostControllerStatus: () =>
        Promise.resolve({
          ...IDLE_CONTROLLER_STATUS,
          reachable: false,
          lastEnsureFailure: ENSURE_FAILURE,
          mutation: {
            kind: "ensure",
            progress: null,
            startedAt: "2026-05-15T00:00:00Z",
          },
        }),
      convergeReady: () =>
        Promise.reject(new Error("convergeReady must not run in this test")),
    });

    mountRealChainWithNarrator(spy.management, false);

    await waitFor(() => {
      expect(narratorSurface()).not.toBeNull();
    });
    expect(screen.queryByTestId("host-ensure-failure-message")).toBeNull();
  });

  // Dropped: `provisioningError.message` rendering verbatim on the
  // gate's card is already pinned by
  // `default-host-ready-gate.test.tsx:671-675` and `:745-759`
  // (`getByText("boom")`), and is untouched by `lastEnsureFailure` - a
  // duplicate not worth its ~10s real-timer wait.

  it("after a user Retry, the pushed failure shows SENTENCE again; withheld while the retry is in flight", async () => {
    // A holder, not a `let`: TypeScript does not see the executor's
    // assignment and would narrow a `let` to `null` where it is called.
    const converge: {
      resolve:
        | ((value: {
            kind: "failed";
            message: string;
            errorCode: string | null;
          }) => void)
        | null;
    } = { resolve: null };
    const convergePromise = new Promise<{
      kind: "failed";
      message: string;
      errorCode: string | null;
    }>((resolve) => {
      converge.resolve = resolve;
    });
    const failedFixture: HostControllerStatus = {
      ...IDLE_CONTROLLER_STATUS,
      reachable: false,
      lastEnsureFailure: ENSURE_FAILURE,
    };
    const spy = buildManagementSpy({
      getHostControllerStatus: () => Promise.resolve(failedFixture),
      convergeReady: () => convergePromise,
    });

    const { queryClient } = mountRealChainWithNarrator(spy.management, false);

    // Step 1, RED at head: the fixture is already settled at mount (no
    // renderer-driven ensure has even run yet), so this element should show
    // SENTENCE immediately. At head nothing reads `lastEnsureFailure`, so the
    // element does not exist.
    await waitFor(() => {
      expect(narratorSurface()).not.toBeNull();
    });
    expect(
      screen.queryByTestId("host-ensure-failure-message")?.textContent,
    ).toBe(SENTENCE);

    // Step 2: click Retry, and while it is in flight the message must never
    // show - the same settled-only guard pinned above, exercised here across a
    // user-initiated ensure instead of the automatic one.
    const retryButton = await screen.findByTestId("window-host-modal-retry");
    fireEvent.click(retryButton);
    await waitFor(() => {
      expect(spy.convergeReadyCalls()).toBe(1);
    });
    expect(screen.queryByTestId("host-ensure-failure-message")).toBeNull();

    // Step 3: the retry resolves failed, and desktop main pushes a fresh
    // status carrying the fixture again. This suite mounts no
    // `HostControllerStatusListener` (the earlier cases don't need one either), so -
    // per the brief - that push is modelled directly as a `setQueryData` on
    // the exact key the real listener writes into
    // (`host-controller-status-listener.tsx`'s `onChange` handler).
    converge.resolve?.({
      kind: "failed",
      message: SENTENCE,
      errorCode: null,
    });
    act(() => {
      queryClient.setQueryData(
        runnerQueryKeys.hostControllerStatus(spy.management),
        failedFixture,
      );
    });

    // Step 4: the message is back - wherever it renders. A settled ∅ can
    // hand the state to the gate's own `provisioning-error` card instead of
    // the narrator (`NarratingWindowHostModal`'s `gateDrawn` precedence), so
    // this resolves the element by testid rather than assuming which surface
    // still owns it.
    await waitFor(() => {
      expect(
        screen.queryByTestId("host-ensure-failure-message")?.textContent,
      ).toBe(SENTENCE);
    });
  });

  // R5 §G cleanup: the Enable-background-service repair, gated on the
  // ensure failure's code AND a known local host - neither alone is enough.
  describe("the Enable background service repair", () => {
    it("shows for E_SERVICE_REGISTRATION_DISABLED with a local host known, and clicking it dispatches register-service for that host", async () => {
      const spy = buildManagementSpyWithRegisterService(ENSURE_FAILURE);

      mountRealChainWithNarrator(spy.management, true);

      const enableButton = await screen.findByTestId(
        "host-ensure-failure-enable-service",
      );
      fireEvent.click(enableButton);

      await waitFor(() => {
        expect(spy.registerServiceCalls()).toEqual([
          { expectedHostId: LOCAL_HOST_ID },
        ]);
      });
    });

    it("does not show for E_SERVICE_REGISTRATION_DISABLED with no local host known", async () => {
      const spy = buildManagementSpyWithRegisterService(ENSURE_FAILURE);

      mountRealChainWithNarrator(spy.management, false);

      await waitFor(() => {
        expect(
          screen.queryByTestId("host-ensure-failure-message")?.textContent,
        ).toBe(SENTENCE);
      });
      expect(
        screen.queryByTestId("host-ensure-failure-enable-service"),
      ).toBeNull();
    });

    it("does not show for a different code (E_SERVICE_TASK_NOT_OWNED), even with a local host known", async () => {
      const notOwnedFailure: HostEnsureFailure = {
        message: "not this account's task",
        code: "E_SERVICE_TASK_NOT_OWNED",
      };
      const spy = buildManagementSpyWithRegisterService(notOwnedFailure);

      mountRealChainWithNarrator(spy.management, true);

      await waitFor(() => {
        expect(
          screen.queryByTestId("host-ensure-failure-message")?.textContent,
        ).toBe(notOwnedFailure.message);
      });
      expect(
        screen.queryByTestId("host-ensure-failure-enable-service"),
      ).toBeNull();
    });
  });
});
