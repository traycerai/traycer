import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  IHostManagement,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import {
  HostReadinessControllerContext,
  projectDefaultHostReadiness,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
} from "@/components/layout/host-readiness-controller-context";
import {
  DefaultHostReadyGate,
  HostReadinessControllerProvider,
  SurfaceReadinessFallback,
} from "@/components/layout/host-readiness-controller";
import {
  HostCompatibilityProvider,
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import {
  NO_LOCAL_HOST_DESKTOP_LEAD,
  NO_LOCAL_HOST_DESKTOP_TAIL,
  NO_LOCAL_HOST_INSTALL_COMMAND,
  NO_LOCAL_HOST_RUN_HERE_APPLIED,
  NO_LOCAL_HOST_RUN_HERE_LABEL,
} from "@/lib/host/host-lifecycle-copy";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useRouterState: () => "/" };
});

const DEFAULT_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "local",
  localBootIntent: true,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

describe("projectDefaultHostReadiness", () => {
  it("holds a local default host while provisioning", () => {
    expect(
      projectDefaultHostReadiness({
        readiness: { kind: "ready" },
        presentation: { ...DEFAULT_PRESENTATION, provisioning: true },
      }),
    ).toEqual({ kind: "provisioning-host" });
  });

  it("does not project local provisioning onto a remote default host", () => {
    expect(
      projectDefaultHostReadiness({
        readiness: { kind: "ready" },
        presentation: {
          ...DEFAULT_PRESENTATION,
          targetKind: "remote",
          localBootIntent: false,
          provisioning: true,
        },
      }),
    ).toEqual({ kind: "ready" });
  });

  // D13, P3.2: the compat verdict is a SELECTION input, and this projection is
  // where it used to be a readiness input instead. Every non-compatible verdict
  // is asserted, not just `incompatible`: `checking` held the window behind a
  // full-screen probe card and `failed` behind an error card, and re-adding any
  // one of the three would put a second narrator back on screen for a fact the
  // authority's lease already owns.
  //
  // Driven through the LOCAL arm on purpose. The remote arm returns early at
  // `presentsLocalHostLifecycle`, so a compat gate reintroduced below that
  // early return would sail past a remote-target assertion - the test would
  // pass because the input never reached the code under test, which is the
  // unreachable-premise trap, not coverage.
  const nonCompatibleVerdicts = ["checking", "failed", "incompatible"] as const;
  for (const status of nonCompatibleVerdicts) {
    it(`leaves a dialable local host READY when the compat verdict is ${status}`, () => {
      expect(
        projectDefaultHostReadiness({
          readiness: { kind: "ready" },
          presentation: {
            ...DEFAULT_PRESENTATION,
            compatibility: {
              ...DEFAULT_PRESENTATION.compatibility,
              status,
              unreachable: status === "failed",
            },
          },
        }),
      ).toEqual({ kind: "ready" });
    });
  }
});

/**
 * T1: `canProvision` in `host-readiness-controller.tsx` moved from
 * `authStatus === "signed-in"` to `admitsLocalPlane(authStatus)`. The removal
 * sentinel it arms (`useRunnerHostRemovalStateQuery`) is a purely local
 * question - "did this device's user remove Traycer's background components"
 * - so an `unverified` session (an identity on disk, no held `/api/v3/user`
 * verdict) must reach it exactly like a `signed-in` one. Before the fix that
 * read stayed unarmed for the whole `unverified` cohort, so a removed host on
 * an offline machine surfaced the generic "couldn't reach the host" card with
 * a Retry that could never succeed instead of the removed-host card that
 * tells the user what happened and offers Reinstall / Quit.
 */
describe("local-plane admission for the removal-sentinel read", () => {
  function buildManagementSpy(): {
    readonly management: IHostManagement;
    readonly removalStateCalls: () => number;
  } {
    let removalStateCalls = 0;
    const notImplemented = (name: string) => () =>
      Promise.reject(new Error(`${name} must not run in this test`));
    const management: IHostManagement = {
      getHostControllerStatus: () =>
        Promise.resolve({
          download: null,
          mutation: null,
          installedVersion: "1.2.3",
          latestVersion: "1.2.3",
          stagedVersion: null,
          installedRuntimeVersion: null,
          runningRuntimeVersion: null,
          updateReady: false,
          activation: "activated",
          reachable: true,
          removedByUser: false,
          checkedAt: "2026-05-15T00:00:00Z",
          localAttempt: null,
        }),
      convergeReady: notImplemented("convergeReady"),
      getRemovalState: () => {
        removalStateCalls += 1;
        return Promise.resolve({ removedByUser: true });
      },
      applyStaged: notImplemented("applyStaged"),
      activateInstalled: notImplemented("activateInstalled"),
      installVersion: notImplemented("installVersion"),
      uninstallHost: notImplemented("uninstallHost"),
      restartHost: notImplemented("restartHost"),
      uninstallTraycer: notImplemented("uninstallTraycer"),
      clearRemoval: notImplemented("clearRemoval"),
      getHostLogs: notImplemented("getHostLogs"),
      runDoctor: notImplemented("runDoctor"),
      availableVersions: notImplemented("availableVersions"),
      installedRecord: () => Promise.resolve(null),
      registerService: notImplemented("registerService"),
      deregisterService: notImplemented("deregisterService"),
      registryCheck: notImplemented("registryCheck"),
      freePortAndRestart: notImplemented("freePortAndRestart"),
      runDoctorRepairQueued: notImplemented("runDoctorRepairQueued"),
      freePortAndRestartIfIdle: notImplemented("freePortAndRestartIfIdle"),
      cliManifest: () => Promise.resolve(null),
      maintenanceUpdateCheck: notImplemented("maintenanceUpdateCheck"),
      maintenanceDoctor: notImplemented("maintenanceDoctor"),
      maintenanceInstallationInfo: notImplemented(
        "maintenanceInstallationInfo",
      ),
      maintenanceInstallVersion: notImplemented("maintenanceInstallVersion"),
      restartHostIfIdle: notImplemented("restartHostIfIdle"),
      restartHostServiceIfHostIdle: notImplemented(
        "restartHostServiceIfHostIdle",
      ),
      runDoctorRepairIfIdle: notImplemented("runDoctorRepairIfIdle"),
      getHostName: () =>
        Promise.resolve({
          systemName: "hardiks-macbook",
          customName: null,
          effectiveName: "hardiks-macbook",
        }),
      setHostName: (input) =>
        Promise.resolve({
          systemName: "hardiks-macbook",
          customName: input.customName,
          effectiveName: input.customName ?? "hardiks-macbook",
        }),
    };
    return { management, removalStateCalls: () => removalStateCalls };
  }

  function buildRunnerHost(
    management: IHostManagement,
    seedCredential: boolean,
  ): MockRunnerHost {
    // No local host up: `localHost: null` keeps `HostProvisioningController`'s
    // internal `state?.kind === "unavailable"`, which is the other half of
    // `useHostProvisioning`'s `enabled` gate this test needs armed alongside
    // `canProvision`.
    const runnerHost = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: true,
      traycerCli: undefined,
      hostManagement: management,
    });
    // THE credential-on-disk input. Withholding it is the only way to hold a
    // session at `signed-out` through mount - the restoration has nothing to
    // restore, so it never reaches for `/api/v3/user` at all.
    if (seedCredential) {
      void runnerHost.tokenStore.signIn(
        { token: "test-token", refreshToken: "test-refresh-token" },
        { id: "test-user", email: "test@example.com", name: "Test User" },
      );
    }
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
   * `userOutcome` is what makes the AuthStatus under test REAL rather than
   * asserted. Driving `useAuthStore` directly does not survive mount: the
   * runtime's own restoration runs during `HostRuntimeProvider` startup and
   * overwrites whatever the test set. So each arm stages the two production
   * inputs that actually determine the status and lets `AuthService` derive it:
   *
   *  - `ok` + a seeded credential  -> `signed-in`
   *  - `unreachable` + a seeded credential -> `unverified` (identity on disk,
   *    no verdict held - exactly the cohort this fix is for)
   *  - no seeded credential -> `signed-out`, and `/api/v3/user` is never called
   */
  function installAuthFetch(userOutcome: "ok" | "unreachable"): () => void {
    const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: (input: unknown): Promise<Response> => {
        const url = typeof input === "string" ? input : String(input);
        // "Unreachable" is a property of AUTHN, not of one endpoint. Answering
        // only `/api/v3/user` with a 5xx sends the validation into the locked
        // rotate, whose refresh then hits the unmocked fallback below and
        // fails terminally - clearing the session to `signed-out`, i.e. the
        // opposite of the cohort under test. Every authn call has to be down
        // together for the session to hold as `unverified`; a settled 5xx is
        // what `AuthService` classifies as `network-error`, never a thrown
        // fetch.
        if (userOutcome === "unreachable") {
          return Promise.reject(new Error("authn unreachable"));
        }
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
          new Error(`unexpected fetch in host readiness test: ${url}`),
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

  function mountGate(
    management: IHostManagement,
    seedCredential: boolean,
  ): void {
    const runnerHost = buildRunnerHost(management, seedCredential);
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
                  <main aria-label="mounted app" data-testid="app-mounted">
                    app
                  </main>
                </DefaultHostReadyGate>
              </HostReadinessControllerProvider>
            </HostCompatibilityProvider>
          </HostRuntimeProvider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );
  }

  let restoreFetch: () => void = () => undefined;

  // Installed PER ARM, not here. The whole point of these two tests is that
  // they run under different auth statuses, and the status is derived from
  // this fetch's answer plus the seeded credential - so a single shared
  // install silently collapses both arms onto `signed-in`, which is exactly
  // what it did.

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    restoreFetch();
    window.localStorage.clear();
    useAuthStore.getState().setSignedOut();
  });

  it("arms the removal-sentinel read for an unverified session and surfaces the removed-host card", async () => {
    // A credential on disk that authn cannot be reached to confirm. The status
    // is DERIVED from those two facts rather than written into the store,
    // because a written one does not survive the runtime's own restoration.
    restoreFetch = installAuthFetch("unreachable");
    const spy = buildManagementSpy();

    mountGate(spy.management, true);

    // The real `AuthService` restoration is several async hops (token-store
    // read -> validate -> classify -> apply), and `signed-out` is the store's
    // INITIAL value - so a short poll window reports the starting state and
    // reads exactly like a verdict of "signed-out". Same window the
    // `renderer-local-admission` integration suite uses for this transition.
    await waitFor(
      () => {
        expect(useAuthStore.getState().status).toBe("unverified");
      },
      { timeout: 5000, interval: 50 },
    );

    // `resolveSurfaceReadiness`'s `restoring-request-context` branch also
    // reads `admitsLocalPlane`, so the fix widens the same gate the whole
    // chain runs through before the removed-host card can ever appear -
    // this settle is itself part of what T1 is pinning down, not incidental
    // setup.
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Traycer was removed" }),
      ).not.toBeNull();
    });
    expect(useAuthStore.getState().status).toBe("unverified");
    expect(spy.removalStateCalls()).toBeGreaterThan(0);
    expect(screen.queryByRole("main", { name: "mounted app" })).toBeNull();
  });

  it("does not arm the removal-sentinel read for a signed-out session", async () => {
    // NO credential seeded - nothing to restore, so the session genuinely
    // stays `signed-out` and `/api/v3/user` is never reached. The `ok` answer
    // is staged anyway so that a regression which DOES call it produces a
    // signed-in session and fails this test loudly, rather than an unmocked
    // `fetch` throwing something unrelated.
    restoreFetch = installAuthFetch("ok");
    const spy = buildManagementSpy();

    mountGate(spy.management, false);

    // DEPTH FIRST, then the absence. `removalStateCalls() === 0` is true both
    // when admission correctly withholds the read AND when the harness never
    // got far enough to attempt it, so the second assertion is worthless
    // without the first: prove the host runtime actually bound (its fallback
    // is gone), which is the point past which `HostProvisioningController`
    // is mounted and `canProvision` has been evaluated.
    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });
    // And prove the harness did not re-authenticate us out of the state under
    // test before the predicate was read.
    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(spy.removalStateCalls()).toBe(0);
  });
});

/**
 * `SurfaceReadinessFallback`'s desktop-shaped `mobile-no-host` card - a
 * desktop launched in the `none` lifecycle mode (no local host of its own)
 * hits the same readiness kind mobile's zero-host case does, but must render
 * the desktop copy (`DesktopNoLocalHostFallback`) rather than the "connect a
 * host from this device" line that makes sense only on a phone.
 *
 * Rendered directly against the card rather than through the whole
 * `HostReadinessControllerProvider` stack: the card's own behavior depends
 * only on `runnerHost.hostLifecycle` and the readiness controller context, so
 * a lighter harness pins the card without re-deriving admission/auth/directory
 * wiring the earlier suite in this file already exercises.
 */
describe("SurfaceReadinessFallback - desktop no-local-host card", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  type SetResultBuilder = (
    request: HostLifecycleSetRequest,
    currentView: HostLifecycleView,
  ) => HostLifecycleSetResult;

  /**
   * `buildResult: null` answers every `set` with `applied` at the requested
   * mode. `notifyChange: false` withholds the `onChange` push, so the only
   * way a new view reaches the card is the mutation writing the RESULT's view
   * into the cache.
   */
  function createFakeHostLifecycleHost(
    initialMode: HostLifecycleView["desired"]["mode"],
    buildResult: SetResultBuilder | null,
    notifyChange: boolean,
  ): {
    readonly host: IHostLifecycleHost;
    readonly setRequests: () => readonly HostLifecycleSetRequest[];
  } {
    let view: HostLifecycleView = {
      desired: { mode: initialMode, rev: 1, updatedBy: null, updatedAt: null },
      applied: { localHostCapability: "none", supervisor: "not-running" },
      pending: "none",
    };
    const listeners = new Set<(view: HostLifecycleView) => void>();
    const setRequests: HostLifecycleSetRequest[] = [];
    const host: IHostLifecycleHost = {
      get: () => Promise.resolve(view),
      set: (request: HostLifecycleSetRequest) => {
        setRequests.push(request);
        const result: HostLifecycleSetResult =
          buildResult === null
            ? {
                kind: "applied",
                view: {
                  ...view,
                  desired: { ...view.desired, mode: request.mode },
                },
              }
            : buildResult(request, view);
        view = result.view;
        if (notifyChange) {
          for (const listener of listeners) listener(view);
        }
        return Promise.resolve(result);
      },
      onChange: (handler: (view: HostLifecycleView) => void) => {
        listeners.add(handler);
        return {
          dispose: () => {
            listeners.delete(handler);
          },
        };
      },
      quit: null,
    };
    return { host, setRequests: () => setRequests };
  }

  function renderNoHostFallback(runnerHost: IRunnerHost) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const controller: HostReadinessController = {
      readinessFor: () => ({ kind: "mobile-no-host" }),
      defaultHostPresentation: DEFAULT_PRESENTATION,
      hasBeenDefaultHostReady: false,
    };
    return render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <QueryClientProvider client={queryClient}>
          <HostReadinessControllerContext.Provider value={controller}>
            <SurfaceReadinessFallback readiness={{ kind: "mobile-no-host" }} />
          </HostReadinessControllerContext.Provider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );
  }

  it("renders the desktop copy with the install command in a <code> element when hostLifecycle is present", async () => {
    const { host } = createFakeHostLifecycleHost("none", null, true);
    const runnerHost = createFakeRunnerHost({
      hasLocalHost: false,
      hostLifecycle: host,
    });
    renderNoHostFallback(runnerHost);

    const card = await screen.findByTestId("desktop-no-local-host");
    expect(card.textContent).toContain(NO_LOCAL_HOST_DESKTOP_LEAD);
    expect(card.textContent).toContain(NO_LOCAL_HOST_DESKTOP_TAIL);
    const code = card.querySelector("code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe(NO_LOCAL_HOST_INSTALL_COMMAND);
    expect(
      screen.getByRole("button", { name: NO_LOCAL_HOST_RUN_HERE_LABEL }),
    ).toBeTruthy();
  });

  it("clicking 'Run a host here instead' calls hostLifecycle.set and fires host_lifecycle_mode_set with source no-host-card", async () => {
    const { host, setRequests } = createFakeHostLifecycleHost(
      "none",
      null,
      true,
    );
    const runnerHost = createFakeRunnerHost({
      hasLocalHost: false,
      hostLifecycle: host,
    });
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    renderNoHostFallback(runnerHost);

    const button = await screen.findByRole("button", {
      name: NO_LOCAL_HOST_RUN_HERE_LABEL,
    });
    // The button starts disabled until `useRunnerHostLifecycleQuery` resolves
    // its first `get()` read (`disabled: view === undefined || ...`) - wait
    // for that settle before clicking, else the click lands on a disabled
    // button and never reaches the mutation.
    await waitFor(() => {
      expect(button.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(setRequests()).toEqual([{ mode: "background", stop: null }]);
    });
    await waitFor(() => {
      expect(trackSpy).toHaveBeenCalledWith(
        AnalyticsEvent.HostLifecycleModeSet,
        { mode: "background", source: "no-host-card" },
      );
    });
  });

  it("shows the applied note and 'Quit Traycer' instead of the run-here button once desired.mode is no longer none", async () => {
    const { host } = createFakeHostLifecycleHost("background", null, true);
    const runnerHost = createFakeRunnerHost({
      hasLocalHost: false,
      hostLifecycle: host,
    });
    renderNoHostFallback(runnerHost);

    await waitFor(() => {
      expect(screen.getByTestId("desktop-no-local-host").textContent).toBe(
        NO_LOCAL_HOST_RUN_HERE_APPLIED,
      );
    });
    expect(screen.getByRole("button", { name: "Quit Traycer" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: NO_LOCAL_HOST_RUN_HERE_LABEL }),
    ).toBeNull();
  });

  it("a 'failed' result shows the message inline, keeps the run-here button, and fires no analytics", async () => {
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const { host } = createFakeHostLifecycleHost(
      "none",
      (_request, currentView) => ({
        kind: "failed",
        reason: "write-failed",
        message: "Couldn't write the policy file.",
        view: currentView,
      }),
      true,
    );
    const runnerHost = createFakeRunnerHost({
      hasLocalHost: false,
      hostLifecycle: host,
    });
    renderNoHostFallback(runnerHost);

    const button = await screen.findByRole("button", {
      name: NO_LOCAL_HOST_RUN_HERE_LABEL,
    });
    await waitFor(() => {
      expect(button.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByTestId("no-local-host-run-here-error").textContent,
      ).toBe("Couldn't write the policy file.");
    });
    expect(
      screen.getByRole("button", { name: NO_LOCAL_HOST_RUN_HERE_LABEL }),
    ).toBeTruthy();
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.HostLifecycleModeSet,
      expect.anything(),
    );
  });

  it("a 'superseded' result whose view is still desired.mode 'none' shows no error line and keeps the run-here button, no analytics", async () => {
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const { host, setRequests } = createFakeHostLifecycleHost(
      "none",
      (_request, currentView) => ({ kind: "superseded", view: currentView }),
      true,
    );
    const runnerHost = createFakeRunnerHost({
      hasLocalHost: false,
      hostLifecycle: host,
    });
    renderNoHostFallback(runnerHost);

    const button = await screen.findByRole("button", {
      name: NO_LOCAL_HOST_RUN_HERE_LABEL,
    });
    await waitFor(() => {
      expect(button.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(setRequests()).toHaveLength(1);
    });
    expect(screen.queryByTestId("no-local-host-run-here-error")).toBeNull();
    expect(
      screen.getByRole("button", { name: NO_LOCAL_HOST_RUN_HERE_LABEL }),
    ).toBeTruthy();
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.HostLifecycleModeSet,
      expect.anything(),
    );
  });

  it("a 'superseded' result whose view has desired.mode 'linked' switches the card to the applied note and Quit Traycer, driven by the result's view", async () => {
    const { host } = createFakeHostLifecycleHost(
      "none",
      (_request, currentView) => ({
        kind: "superseded",
        view: {
          ...currentView,
          desired: {
            mode: "linked",
            rev: currentView.desired.rev + 1,
            updatedBy: "cli",
            updatedAt: null,
          },
        },
      }),
      // No `onChange` push: only the result's own view can move the card.
      false,
    );
    const runnerHost = createFakeRunnerHost({
      hasLocalHost: false,
      hostLifecycle: host,
    });
    renderNoHostFallback(runnerHost);

    const button = await screen.findByRole("button", {
      name: NO_LOCAL_HOST_RUN_HERE_LABEL,
    });
    await waitFor(() => {
      expect(button.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByTestId("desktop-no-local-host").textContent).toBe(
        NO_LOCAL_HOST_RUN_HERE_APPLIED,
      );
    });
    expect(screen.getByRole("button", { name: "Quit Traycer" })).toBeTruthy();
  });

  // `stop-refused` is unreachable from this card: it always sends
  // `stop: null` (never `"if-idle"`/`"force"`), and that result arm is only
  // produced by the host in response to a stop request. No test for it here.

  it("renders the unchanged mobile copy (no desktop testid) when hostLifecycle is null", async () => {
    const runnerHost = createFakeRunnerHost({
      hasLocalHost: false,
      hostLifecycle: null,
    });
    renderNoHostFallback(runnerHost);

    expect(await screen.findByTestId("mobile-no-host")).toBeTruthy();
    expect(screen.queryByTestId("desktop-no-local-host")).toBeNull();
  });
});
