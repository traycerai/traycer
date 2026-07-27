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
  localTarget: true,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  requestRespawn: () => undefined,
  respawnPending: false,
  compatibility: {
    status: "compatible",
    errorMessage: null,
    retrying: false,
    retry: () => undefined,
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
            status: "available",
          },
        ],
        hasLocalHost: true,
        hasMobileNoHost: false,
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
            websocketUrl: null,
            version: "1.0.0",
            status: "unavailable",
          },
        ],
        hasLocalHost: true,
        hasMobileNoHost: false,
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
            status: "available",
          },
        ],
        hasLocalHost: true,
        hasMobileNoHost: false,
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
      localTarget: false,
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
      message: "Traycer Host could not start.",
      code: null,
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
      message: "Traycer Host requires an update.",
      code: null,
      source: "Host startup",
    });
  });
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
