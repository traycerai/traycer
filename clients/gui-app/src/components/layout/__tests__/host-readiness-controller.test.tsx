import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostReadinessControllerContext,
  postLatchSurfaceFor,
  projectDefaultHostReadiness,
  resolveSurfaceReadiness,
  type HostReadinessController,
  type HostReadinessScope,
  type DefaultHostReadinessPresentation,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import { SurfaceReadinessBoundary } from "@/components/layout/host-readiness-controller";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

afterEach(() => {
  cleanup();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
  });
});

const DEFAULT_HOST_PRESENTATION: DefaultHostReadinessPresentation = {
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
  openHostPicker: () => undefined,
  openSettings: () => undefined,
  anyHostDialable: false,
  requestRespawn: () => undefined,
  respawnPending: false,
  compatibility: {
    status: "compatible",
    errorMessage: null,
    retrying: false,
    retry: () => undefined,
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

function readinessController(
  states: Readonly<Record<string, SurfaceReadiness>>,
): HostReadinessController {
  return {
    readinessFor: (scope: HostReadinessScope, tabHostId: string | null) =>
      states[`${scope}:${tabHostId ?? ""}`] ?? { kind: "ready" },
    defaultHostPresentation: DEFAULT_HOST_PRESENTATION,
  };
}

function Member(props: { readonly id: string }) {
  return <div data-testid={`member-${props.id}`}>{props.id}</div>;
}

function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

/**
 * `SurfaceReadinessFallback` now renders `LocalHostLoadingContent` for the
 * `loading-host`/`provisioning-host`/slow-`unavailable-host` kinds, which
 * reads `useRunnerHost()` and issues a query - the same ancestor providers
 * the real `HostReadinessControllerProvider` sits under in production
 * (`RunnerHostProvider` -> `QueryClientProvider` -> ... ->
 * `HostReadinessControllerProvider`, see traycer-app.tsx). Tests that render
 * one of those kinds need these two providers even though they stub the
 * readiness controller itself.
 */
function renderWithProviders(
  controller: HostReadinessController,
  children: ReactNode,
  runnerHost: MockRunnerHost,
): void {
  render(
    <QueryClientProvider client={buildQueryClient()}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider value={controller}>
          {children}
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function buildRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

describe("<SurfaceReadinessBoundary />", () => {
  it("distinguishes request restoration, mobile no-host, and tab-host reachability", () => {
    expect(
      resolveSurfaceReadiness({
        scope: "none",
        tabHostId: null,
        authStatus: "signed-in",
        activeHostId: null,
        requestContextUserId: null,
        directoryEntries: [],
        hasLocalHost: false,
        hasMobileNoHost: true,
        hasReadySessionFor: () => false,
      }),
    ).toEqual({ kind: "ready" });
    expect(
      resolveSurfaceReadiness({
        scope: "default-host",
        tabHostId: null,
        authStatus: "signed-in",
        activeHostId: "host-a",
        requestContextUserId: null,
        directoryEntries: [],
        hasLocalHost: true,
        hasMobileNoHost: false,
        hasReadySessionFor: () => false,
      }),
    ).toEqual({ kind: "restoring-request-context" });
    expect(
      resolveSurfaceReadiness({
        scope: "default-host",
        tabHostId: null,
        authStatus: "signed-in",
        activeHostId: null,
        requestContextUserId: "user-a",
        directoryEntries: [],
        hasLocalHost: false,
        hasMobileNoHost: true,
        hasReadySessionFor: () => false,
      }),
    ).toEqual({ kind: "mobile-no-host" });
    expect(
      resolveSurfaceReadiness({
        scope: "tab-host",
        tabHostId: "host-b",
        authStatus: "signed-in",
        activeHostId: "host-a",
        requestContextUserId: "user-a",
        directoryEntries: [
          {
            hostId: "host-b",
            label: "Bound host",
            kind: "remote",
            websocketUrl: "ws://host-b",
            version: "1.0.0",
            transportDialability: "dialable",
          },
        ],
        hasLocalHost: true,
        hasMobileNoHost: false,
        hasReadySessionFor: () => false,
      }),
    ).toEqual({ kind: "ready" });
    expect(
      resolveSurfaceReadiness({
        scope: "tab-host",
        tabHostId: "missing-host",
        authStatus: "signed-in",
        activeHostId: "host-a",
        requestContextUserId: "user-a",
        directoryEntries: [],
        hasLocalHost: true,
        hasMobileNoHost: false,
        hasReadySessionFor: () => false,
      }),
    ).toEqual({ kind: "unavailable-host" });
    // The ready-session input must actually reach the refusal gate: the same
    // registry-refused tab host flips to ready when this client holds a live
    // session to it (firsthand evidence outranks the cloud verdict), and the
    // gate reads the CALLER-supplied reactive answer, not the pull-only cache.
    const refusedTabArgs = {
      scope: "tab-host",
      tabHostId: "host-b",
      authStatus: "signed-in",
      activeHostId: "host-a",
      requestContextUserId: "user-a",
      directoryEntries: [
        {
          hostId: "host-b",
          label: "Bound host",
          kind: "remote",
          websocketUrl: "ws://host-b",
          version: "1.0.0",
          transportDialability: "not-dialable",
        },
      ],
      hasLocalHost: true,
      hasMobileNoHost: false,
    } as const;
    expect(
      resolveSurfaceReadiness({
        ...refusedTabArgs,
        hasReadySessionFor: () => false,
      }),
    ).toEqual({ kind: "unavailable-host" });
    expect(
      resolveSurfaceReadiness({
        ...refusedTabArgs,
        hasReadySessionFor: (hostId) => hostId === "host-b",
      }),
    ).toEqual({ kind: "ready" });
    expect(
      resolveSurfaceReadiness({
        scope: "default-host",
        tabHostId: null,
        authStatus: "signed-in",
        activeHostId: "host-a",
        requestContextUserId: "user-a",
        directoryEntries: [
          {
            hostId: "host-a",
            label: "Default host",
            kind: "local",
            websocketUrl: null,
            version: "1.0.0",
            transportDialability: "not-dialable",
          },
        ],
        hasLocalHost: true,
        hasMobileNoHost: false,
        hasReadySessionFor: () => false,
      }),
    ).toEqual({ kind: "unavailable-host" });
    expect(
      resolveSurfaceReadiness({
        scope: "default-host",
        tabHostId: null,
        authStatus: "signed-in",
        activeHostId: "host-a",
        requestContextUserId: "user-a",
        directoryEntries: [
          {
            hostId: "host-a",
            label: "Default host",
            kind: "local",
            websocketUrl: "ws://host-a",
            version: "1.0.0",
            transportDialability: "dialable",
          },
        ],
        hasLocalHost: true,
        hasMobileNoHost: false,
        hasReadySessionFor: () => false,
      }),
    ).toEqual({ kind: "ready" });
  });

  it("projects provisioning and compatibility lifecycle states into one default-host slot", () => {
    const retry = vi.fn();
    const checking: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      compatibility: {
        ...DEFAULT_HOST_PRESENTATION.compatibility,
        status: "checking",
      },
    };
    expect(
      projectDefaultHostReadiness({
        readiness: { kind: "ready" },
        presentation: checking,
      }),
    ).toEqual({ kind: "compatibility-checking" });
    const errorPresentation: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      provisioningError: new Error("ensure failed"),
      retryProvisioning: retry,
    };
    const controller = readinessController({
      "default-host:": projectDefaultHostReadiness({
        readiness: { kind: "unavailable-host" },
        presentation: errorPresentation,
      }),
    });
    const errorController = {
      ...controller,
      defaultHostPresentation: errorPresentation,
    };

    render(
      <HostReadinessControllerContext.Provider value={errorController}>
        <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
          <Member id="epic" />
        </SurfaceReadinessBoundary>
      </HostReadinessControllerContext.Provider>,
    );

    fireEvent.click(screen.getByTestId("local-host-provisioning-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("holds a dialable local host until ensure and compatibility settle, but leaves a remote target alone", () => {
    const provisioning: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      provisioning: true,
    };
    expect(
      projectDefaultHostReadiness({
        readiness: { kind: "ready" },
        presentation: provisioning,
      }),
    ).toEqual({ kind: "provisioning-host" });

    const remoteIncompatible: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      targetKind: "remote",
      localBootIntent: false,
      provisioning: true,
      removed: true,
      provisioningError: new Error("local ensure failed"),
      compatibility: {
        ...DEFAULT_HOST_PRESENTATION.compatibility,
        status: "incompatible",
      },
    };
    expect(
      projectDefaultHostReadiness({
        readiness: { kind: "ready" },
        presentation: remoteIncompatible,
      }),
    ).toEqual({ kind: "ready" });
  });

  it("passes an unknown target through without local-bootstrap projection", () => {
    // D4: an unresolved directory entry must never inherit local
    // host-management actions (respawn Retry, bootstrap body, compat
    // projection) - unless the app is genuinely booting THIS machine's host,
    // which is the arm below. That misattribution is what turned a
    // still-dialing remote switch into a full-screen local-bootstrap card.
    const unknownProvisioning: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      targetKind: "unknown",
      // No local-boot intent: the durable selection names another machine.
      localBootIntent: false,
      provisioning: true,
      removed: true,
      provisioningError: new Error("local ensure failed"),
      compatibility: {
        ...DEFAULT_HOST_PRESENTATION.compatibility,
        status: "checking",
      },
    };
    expect(
      projectDefaultHostReadiness({
        readiness: { kind: "ready" },
        presentation: unknownProvisioning,
      }),
    ).toEqual({ kind: "ready" });
    expect(
      projectDefaultHostReadiness({
        readiness: { kind: "unavailable-host" },
        presentation: {
          ...unknownProvisioning,
          compatibility: {
            ...DEFAULT_HOST_PRESENTATION.compatibility,
            status: "failed",
            unreachable: true,
          },
        },
      }),
    ).toEqual({ kind: "unavailable-host" });

    const controller = {
      ...readinessController({
        "default-host:": { kind: "unavailable-host" },
      }),
      defaultHostPresentation: {
        ...DEFAULT_HOST_PRESENTATION,
        targetKind: "unknown" as const,
        localBootIntent: false,
        localHostState: "unavailable" as const,
        stage: "slow" as const,
      },
    };

    renderWithProviders(
      controller,
      <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
        <Member id="epic" />
      </SurfaceReadinessBoundary>,
      buildRunnerHost(),
    );

    // Unbound target must not paint local-bootstrap UI (retry / spinner).
    expect(screen.queryByTestId("local-host-retry")).toBeNull();
    expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();
    expect(
      screen.getByTestId("surface-readiness-unavailable-host"),
    ).toBeTruthy();
  });

  it("keeps the local lifecycle for an unresolved target that IS a local boot", () => {
    // The other half of the tri-state, and the reason it is not simply
    // "resolved-local only": a first-ever install has no directory row until
    // provisioning creates one. Refusing it there would replace the install
    // card - progress, bootstrap.log path, the traycer#862 diagnostics - with
    // a bare line for the whole first run.
    const localBoot: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      targetKind: "unknown",
      localBootIntent: true,
      provisioning: true,
    };
    expect(
      projectDefaultHostReadiness({
        readiness: { kind: "ready" },
        presentation: localBoot,
      }),
    ).toEqual({ kind: "provisioning-host" });

    const controller = {
      ...readinessController({ "default-host:": { kind: "loading-host" } }),
      defaultHostPresentation: localBoot,
    };
    renderWithProviders(
      controller,
      <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
        <Member id="epic" />
      </SurfaceReadinessBoundary>,
      buildRunnerHost(),
    );
    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
  });

  it("classifies every readiness kind against D1's post-latch surface table", () => {
    // One exhaustive map, shared by the gate and the strip: a new kind must
    // land here or the gate and strip will disagree about whether it is a
    // splash, an amber strip, a red strip, or the app alone.
    //
    // A `Record` keyed by the union, NOT a list of pairs. As a list, adding a
    // kind and forgetting it here still compiled and still passed - the loop
    // only visits what is written down, so the "must land here" above was a
    // request rather than a rule. Missing an entry is now a type error.
    const table: Record<
      SurfaceReadiness["kind"],
      "app" | "switching" | "error" | "splash"
    > = {
      ready: "app",
      "compatibility-checking": "switching",
      "loading-host": "switching",
      "provisioning-host": "switching",
      "unavailable-host": "switching",
      "restoring-request-context": "switching",
      "compatibility-error": "error",
      "incompatible-host": "error",
      "provisioning-error": "error",
      "removed-host": "error",
      "mobile-no-host": "splash",
    };
    for (const [kind, surface] of Object.entries(table)) {
      expect(postLatchSurfaceFor(kind as SurfaceReadiness["kind"])).toBe(
        surface,
      );
    }
  });

  it("keeps local slow-start and busy recovery scoped to the default host", () => {
    const retry = vi.fn();
    const force = vi.fn();
    const busy: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      hostBusy: true,
      canManageHost: true,
      provisioningError: new Error("restart failed"),
      retryProvisioning: retry,
      forceProvisioning: force,
      compatibility: {
        ...DEFAULT_HOST_PRESENTATION.compatibility,
        status: "incompatible",
        errorMessage: "version mismatch",
      },
    };
    const controller = {
      ...readinessController({
        "default-host:": { kind: "incompatible-host" },
        "tab-host:host-b": { kind: "unavailable-host" },
      }),
      defaultHostPresentation: busy,
    };

    render(
      <HostReadinessControllerContext.Provider value={controller}>
        <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
          <Member id="local" />
        </SurfaceReadinessBoundary>
        <SurfaceReadinessBoundary scope="tab-host" tabHostId="host-b">
          <Member id="tab" />
        </SurfaceReadinessBoundary>
      </HostReadinessControllerContext.Provider>,
    );

    expect(
      screen.getByTestId("local-host-incompatible-busy-refresh"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("local-host-incompatible-busy-force-update"),
    ).toBeTruthy();
    expect(screen.getByText(/restart failed/)).toBeTruthy();
    expect(
      screen.getAllByTestId("surface-readiness-unavailable-host"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByTestId("local-host-incompatible-busy-refresh"));
    fireEvent.click(
      screen.getByTestId("local-host-incompatible-busy-force-update"),
    );
    expect(retry).toHaveBeenCalledTimes(1);
    expect(force).toHaveBeenCalledTimes(1);
  });

  it("draws no setup card on an in-surface fallback", () => {
    // The full-screen host-boot splash restores its max-w-md Card through the
    // same `FallbackFrame`. Putting that Card in the shared frame instead of
    // behind the splash variant would nest a second card inside every tab's
    // own frame - so the splash's card test alone does not pin this.
    const controller = readinessController({
      "default-host:": { kind: "loading-host" },
    });

    renderWithProviders(
      controller,
      <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
        <Member id="default" />
      </SurfaceReadinessBoundary>,
      buildRunnerHost(),
    );

    expect(
      screen
        .getByTestId("surface-readiness-loading-host")
        .querySelector('[data-slot="card"]'),
    ).toBeNull();
  });

  it("projects independent default-host and tab-host fallbacks from one controller", () => {
    const controller = readinessController({
      "default-host:": { kind: "loading-host" },
      "tab-host:host-b": { kind: "unavailable-host" },
    });

    renderWithProviders(
      controller,
      <>
        <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
          <Member id="default" />
        </SurfaceReadinessBoundary>
        <SurfaceReadinessBoundary scope="tab-host" tabHostId="host-b">
          <Member id="bound" />
        </SurfaceReadinessBoundary>
      </>,
      buildRunnerHost(),
    );

    expect(screen.queryByTestId("member-default")).toBeNull();
    expect(screen.queryByTestId("member-bound")).toBeNull();
    expect(screen.getByTestId("surface-readiness-loading-host")).toBeTruthy();
    expect(
      screen.getByTestId("surface-readiness-unavailable-host"),
    ).toBeTruthy();
  });

  it("keeps a no-host Settings member usable beside an unavailable partner", () => {
    const controller = readinessController({
      "default-host:": { kind: "loading-host" },
    });

    renderWithProviders(
      controller,
      <>
        <SurfaceReadinessBoundary scope="none" tabHostId={null}>
          <Member id="settings" />
        </SurfaceReadinessBoundary>
        <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
          <Member id="epic" />
        </SurfaceReadinessBoundary>
      </>,
      buildRunnerHost(),
    );

    expect(screen.getByTestId("member-settings")).toBeTruthy();
    expect(screen.queryByTestId("member-epic")).toBeNull();
  });

  it("preserves the ready partner key through ready → unavailable → ready", () => {
    const ready = readinessController({});
    const unavailable = readinessController({
      "default-host:": { kind: "unavailable-host" },
    });
    const view = render(
      <HostReadinessControllerContext.Provider value={ready}>
        <div data-testid="partner" key="partner">
          retained partner
        </div>
        <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
          <Member id="epic" />
        </SurfaceReadinessBoundary>
      </HostReadinessControllerContext.Provider>,
    );
    const partner = screen.getByTestId("partner");

    view.rerender(
      <HostReadinessControllerContext.Provider value={unavailable}>
        <div data-testid="partner" key="partner">
          retained partner
        </div>
        <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
          <Member id="epic" />
        </SurfaceReadinessBoundary>
      </HostReadinessControllerContext.Provider>,
    );

    expect(screen.getByTestId("partner")).toBe(partner);
    expect(screen.queryByTestId("member-epic")).toBeNull();

    view.rerender(
      <HostReadinessControllerContext.Provider value={ready}>
        <div data-testid="partner" key="partner">
          retained partner
        </div>
        <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
          <Member id="epic" />
        </SurfaceReadinessBoundary>
      </HostReadinessControllerContext.Provider>,
    );

    expect(screen.getByTestId("partner")).toBe(partner);
    expect(screen.getByTestId("member-epic")).toBeTruthy();
  });
});

describe("<SurfaceReadinessBoundary /> restored default-host detail (MED7)", () => {
  afterEach(() => cleanup());

  it("renders the bootstrap-log disclosure, a working Configure shell, and a Retry wired to the controller-owned respawn on a slow default-host slot", async () => {
    const cli = new MockTraycerCli();
    cli.hostStatusSnapshot = {
      ...cli.hostStatusSnapshot,
      bootstrapLogTail: "starting zsh -i -l -c ...",
    };
    const runnerHost = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: cli,
    });
    const requestRespawn = vi.fn();
    const configureShell = vi.fn();
    const presentation: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      localHostState: "unavailable",
      stage: "slow",
      configureShell,
      requestRespawn,
      respawnPending: false,
    };
    const controller: HostReadinessController = {
      readinessFor: () => ({ kind: "unavailable-host" }),
      defaultHostPresentation: presentation,
    };

    renderWithProviders(
      controller,
      <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
        <Member id="epic" />
      </SurfaceReadinessBoundary>,
      runnerHost,
    );

    expect(
      screen.getByTestId("surface-readiness-unavailable-host"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("local-host-loading-slow-copy").textContent,
    ).toContain("longer than expected");

    // Retry routes through the controller-owned respawn, not a fresh
    // useRunnerRequestHostRespawn() call inside the slot - a second call
    // there would recreate the MED6 per-slot duplicate-respawn bug.
    fireEvent.click(screen.getByTestId("local-host-retry"));
    expect(requestRespawn).toHaveBeenCalledTimes(1);
    expect(runnerHost.requestHostRespawnCalls).toBe(0);

    // Bootstrap-log disclosure is collapsed by default; opening it reveals
    // the live log tail and the "Configure shell…" shortcut.
    expect(screen.queryByTestId("local-host-loading-log-tail")).toBeNull();
    fireEvent.click(screen.getByTestId("local-host-loading-toggle-details"));
    const tail = await screen.findByTestId("local-host-loading-log-tail");
    expect(tail.textContent).toContain("starting zsh -i -l -c");

    fireEvent.click(screen.getByTestId("local-host-open-shell-settings"));
    expect(configureShell).toHaveBeenCalledTimes(1);
  });

  it("renders a Report Issue affordance on the provisioning-error default-host fallback", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const presentation: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      provisioningError: new Error("ensure failed"),
    };
    const controller: HostReadinessController = {
      readinessFor: () => ({ kind: "provisioning-error" }),
      defaultHostPresentation: presentation,
    };

    renderWithProviders(
      controller,
      <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
        <Member id="epic" />
      </SurfaceReadinessBoundary>,
      buildRunnerHost(),
    );

    const reportButton = screen.getByRole("button", {
      name: /Report issue/i,
    });
    fireEvent.click(reportButton);
    expect(useDesktopDialogStore.getState().activeDialog).toBe("report-issue");
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Could not start Traycer Host",
      message:
        "Traycer Host could not start. Host health: host unknown, compat compatible.",
      code: "HOST_PROVISIONING_FAILED",
      source: "Host startup",
    });
  });

  it("renders a Report Issue affordance on the incompatible-host default-host fallback", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const presentation: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      canManageHost: false,
      compatibility: {
        ...DEFAULT_HOST_PRESENTATION.compatibility,
        status: "incompatible",
        errorMessage: "version mismatch",
      },
    };
    const controller: HostReadinessController = {
      readinessFor: () => ({ kind: "incompatible-host" }),
      defaultHostPresentation: presentation,
    };

    renderWithProviders(
      controller,
      <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
        <Member id="epic" />
      </SurfaceReadinessBoundary>,
      buildRunnerHost(),
    );

    const reportButton = screen.getByRole("button", {
      name: /Report issue/i,
    });
    fireEvent.click(reportButton);
    expect(useDesktopDialogStore.getState().activeDialog).toBe("report-issue");
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Host update required",
      message:
        "Traycer Host requires an update. Host health: host unknown, compat incompatible.",
      code: "HOST_INCOMPATIBLE",
      source: "Host compatibility",
    });
  });

  // traycer#858 / #860 / #862: three field reports, one template, three
  // unrelated causes. The pre-filled report must name the family it was filed
  // from, and carry the state the shell already knew.
  it("files an unreachable-host report, not a compatibility one, when the probe never reached the host", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const presentation: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      localHostState: "ready",
      hostBusy: true,
      compatibility: {
        ...DEFAULT_HOST_PRESENTATION.compatibility,
        status: "failed",
        errorMessage: "fetch failed",
        unreachable: true,
      },
    };
    const controller: HostReadinessController = {
      readinessFor: () => ({ kind: "compatibility-error" }),
      defaultHostPresentation: presentation,
    };

    renderWithProviders(
      controller,
      <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
        <Member id="epic" />
      </SurfaceReadinessBoundary>,
      buildRunnerHost(),
    );

    expect(screen.getByText("Traycer Host is not responding.")).toBeTruthy();
    expect(screen.getByText("fetch failed")).toBeTruthy();
    expect(
      screen.queryByText(/Could not verify host compatibility/),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Report issue/i }));
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Traycer Host is not responding",
      message:
        "The app could not reach Traycer Host. Host health: host ready, compat unreachable, busy.",
      code: "HOST_UNREACHABLE",
      source: "Host connection",
    });
  });

  it("keeps compatibility wording when the host itself rejected the handshake", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const presentation: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      localHostState: "ready",
      compatibility: {
        ...DEFAULT_HOST_PRESENTATION.compatibility,
        status: "failed",
        errorMessage: "status probe failed",
        unreachable: false,
      },
    };
    const controller: HostReadinessController = {
      readinessFor: () => ({ kind: "compatibility-error" }),
      defaultHostPresentation: presentation,
    };

    renderWithProviders(
      controller,
      <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
        <Member id="epic" />
      </SurfaceReadinessBoundary>,
      buildRunnerHost(),
    );

    expect(
      screen.getByText("Could not verify host compatibility."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Report issue/i }));
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Could not verify Traycer Host compatibility",
      message:
        "Traycer Host rejected the compatibility handshake. Host health: host ready, compat rejected.",
      code: "HOST_COMPAT_PROBE_REJECTED",
      source: "Host connection",
    });
  });

  // traycer#860 / #4747: a host that answered host.status as busy-serving
  // turns must not read like one that never started. The pre-filled report
  // health line carries the host's own busy session count.
  it("names the host's busy sessions in the provisioning-error report health line", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const presentation: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      provisioningError: new Error("ensure failed"),
      compatibility: {
        ...DEFAULT_HOST_PRESENTATION.compatibility,
        hostStatus: {
          busy: true,
          busySessionCount: 3,
          hostVersion: "x",
        },
      },
    };
    const controller: HostReadinessController = {
      readinessFor: () => ({ kind: "provisioning-error" }),
      defaultHostPresentation: presentation,
    };

    renderWithProviders(
      controller,
      <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
        <Member id="epic" />
      </SurfaceReadinessBoundary>,
      buildRunnerHost(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Report issue/i }));
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Could not start Traycer Host",
      message:
        "Traycer Host could not start. Host health: host unknown, compat compatible, busy 3 sessions.",
      code: "HOST_PROVISIONING_FAILED",
      source: "Host startup",
    });
  });

  it("singularizes the busy session count in the report health line", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const presentation: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      provisioningError: new Error("ensure failed"),
      compatibility: {
        ...DEFAULT_HOST_PRESENTATION.compatibility,
        hostStatus: {
          busy: true,
          busySessionCount: 1,
          hostVersion: "x",
        },
      },
    };
    const controller: HostReadinessController = {
      readinessFor: () => ({ kind: "provisioning-error" }),
      defaultHostPresentation: presentation,
    };

    renderWithProviders(
      controller,
      <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
        <Member id="epic" />
      </SurfaceReadinessBoundary>,
      buildRunnerHost(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Report issue/i }));
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Could not start Traycer Host",
      message:
        "Traycer Host could not start. Host health: host unknown, compat compatible, busy 1 session.",
      code: "HOST_PROVISIONING_FAILED",
      source: "Host startup",
    });
  });

  // traycer#862: once the provisioning mutation settles, live `progress` is
  // null. The report must still name the last observed stage via lastProgress.
  it("falls back to lastProgress in the provisioning-error report when live progress is null", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const presentation: DefaultHostReadinessPresentation = {
      ...DEFAULT_HOST_PRESENTATION,
      progress: null,
      lastProgress: {
        stage: "extract",
        percent: 80,
        bytes: null,
        totalBytes: null,
        message: null,
      },
      provisioningError: new Error("ensure failed"),
    };
    const controller: HostReadinessController = {
      readinessFor: () => ({ kind: "provisioning-error" }),
      defaultHostPresentation: presentation,
    };

    renderWithProviders(
      controller,
      <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
        <Member id="epic" />
      </SurfaceReadinessBoundary>,
      buildRunnerHost(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Report issue/i }));
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Could not start Traycer Host",
      message:
        "Traycer Host could not start. Host health: host unknown, compat compatible, last progress extract 80%.",
      code: "HOST_PROVISIONING_FAILED",
      source: "Host startup",
    });
  });

  // The retained stage outlives the attempt that produced it (cleared only by
  // a new attempt or a successful settle), so a host that failed to install,
  // came up by some other route, and later stopped answering the probe would
  // otherwise append a dead install stage to a #860-shaped report - pointing
  // triage at provisioning, the exact wrong place. Only the provisioning-error
  // card, which renders only while its own converge error is live, may use it.
  it.each([
    {
      name: "unreachable-host",
      readiness: { kind: "compatibility-error" } as const,
      compatibility: {
        status: "failed" as const,
        errorMessage: "fetch failed",
        unreachable: true,
      },
      expected: {
        title: "Traycer Host is not responding",
        message:
          "The app could not reach Traycer Host. Host health: host ready, compat unreachable.",
        code: "HOST_UNREACHABLE",
        source: "Host connection",
      },
    },
    {
      name: "incompatible-host",
      readiness: { kind: "incompatible-host" } as const,
      compatibility: {
        status: "incompatible" as const,
        errorMessage: null,
        unreachable: false,
      },
      expected: {
        title: "Host update required",
        message:
          "Traycer Host requires an update. Host health: host ready, compat incompatible.",
        code: "HOST_INCOMPATIBLE",
        source: "Host compatibility",
      },
    },
  ])(
    "keeps a settled install stage out of the $name report",
    ({ readiness, compatibility, expected }) => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
      const presentation: DefaultHostReadinessPresentation = {
        ...DEFAULT_HOST_PRESENTATION,
        localHostState: "ready",
        progress: null,
        // Left over from an install that died long before this failure.
        lastProgress: {
          stage: "extract",
          percent: 80,
          bytes: null,
          totalBytes: null,
          message: null,
        },
        compatibility: {
          ...DEFAULT_HOST_PRESENTATION.compatibility,
          ...compatibility,
        },
      };
      const controller: HostReadinessController = {
        readinessFor: () => readiness,
        defaultHostPresentation: presentation,
      };

      renderWithProviders(
        controller,
        <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
          <Member id="epic" />
        </SurfaceReadinessBoundary>,
        buildRunnerHost(),
      );

      fireEvent.click(screen.getByRole("button", { name: /Report issue/i }));
      const context = useDesktopDialogStore.getState().reportIssueContext;
      expect(context).toEqual(expected);
      expect(context?.message).not.toContain("last progress");
    },
  );
});

describe("<SurfaceReadinessBoundary /> single respawn owner (MED6)", () => {
  afterEach(() => cleanup());

  function slowController(
    requestRespawn: () => void,
    respawnPending: boolean,
  ): HostReadinessController {
    return {
      readinessFor: () => ({ kind: "unavailable-host" }),
      defaultHostPresentation: {
        ...DEFAULT_HOST_PRESENTATION,
        localHostState: "unavailable",
        stage: "slow",
        requestRespawn,
        respawnPending,
      },
    };
  }

  function TwoSlots(props: { readonly controller: HostReadinessController }) {
    return (
      <QueryClientProvider client={buildQueryClient()}>
        <RunnerHostProvider runnerHost={buildRunnerHost()}>
          <HostReadinessControllerContext.Provider value={props.controller}>
            <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
              <Member id="a" />
            </SurfaceReadinessBoundary>
            <SurfaceReadinessBoundary scope="default-host" tabHostId={null}>
              <Member id="b" />
            </SurfaceReadinessBoundary>
          </HostReadinessControllerContext.Provider>
        </RunnerHostProvider>
      </QueryClientProvider>
    );
  }

  it("issues exactly one respawn from two slow default-host slots", () => {
    const requestRespawn = vi.fn();
    render(<TwoSlots controller={slowController(requestRespawn, false)} />);
    const retries = screen.getAllByTestId("local-host-retry");
    expect(retries).toHaveLength(2);
    fireEvent.click(retries[0]);
    expect(requestRespawn).toHaveBeenCalledTimes(1);
  });

  it("disables Retry in every slow slot while the shared respawn is pending", () => {
    render(<TwoSlots controller={slowController(vi.fn(), true)} />);
    const retries = screen.getAllByTestId("local-host-retry");
    expect(retries).toHaveLength(2);
    for (const retry of retries) {
      expect(retry.hasAttribute("disabled")).toBe(true);
    }
  });
});
