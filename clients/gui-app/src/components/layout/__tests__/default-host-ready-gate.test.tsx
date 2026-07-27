import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
// Deliberately the ROUTE-FACING name, not `DefaultHostReadyGate` underneath it.
// Asserting on the inner component leaves the wiring unpinned: reverting
// `HostReadyGate` to `return props.children` would restore the regression with
// every test still green.
import { HostReadyGate } from "@/components/layout/host-ready-gate";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const routerState = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: routerState.pathname } }),
}));

// The real header mounts the tab strip, notifications and menus - none of which
// this gate is about, and all of which need their own provider stack.
vi.mock("@/components/layout/header/app-header", () => ({
  AppHeader: (props: { readonly variant: string }) => (
    <div data-testid="app-header" data-variant={props.variant} />
  ),
}));

const PRESENTATION: DefaultHostReadinessPresentation = {
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

function controllerFor(
  readiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: presentation,
  };
}

function renderGate(
  readiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
): void {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const children: ReactNode = <div data-testid="gated-app">app</div>;
  render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider
          value={controllerFor(readiness, presentation)}
        >
          <HostReadyGate>{children}</HostReadyGate>
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  routerState.pathname = "/";
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
  });
});

describe("<HostReadyGate />", () => {
  it("renders the app once the default host is ready", () => {
    renderGate({ kind: "ready" }, PRESENTATION);
    expect(screen.getByTestId("gated-app")).toBeTruthy();
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
  });

  it("replaces the whole app - not just a surface - while the host is not ready", () => {
    // The regression this pins: with only per-surface fallbacks the shell
    // stayed mounted, so the tab strip and every host-dependent affordance in
    // it remained reachable during setup.
    renderGate({ kind: "loading-host" }, PRESENTATION);
    expect(screen.queryByTestId("gated-app")).toBeNull();
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.readiness).toBe("loading-host");
    expect(screen.getByTestId("app-header").dataset.variant).toBe(
      "host-loading",
    );
  });

  it("lets /settings through even while the host is not ready", () => {
    // The splash's own "Configure shell" button navigates to /settings/shell.
    // Gating settings on a ready host would put the escape hatch behind the
    // failure it exists to fix.
    routerState.pathname = "/settings/shell";
    renderGate({ kind: "loading-host" }, PRESENTATION);
    expect(screen.getByTestId("gated-app")).toBeTruthy();
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
  });

  it("never blocks a signed-out user", () => {
    // Only a signed-in user can have a ready default host, so a signed-out
    // app would block forever - with the sign-in surface it needs behind the
    // block. The readiness kinds themselves are not auth-aware on the host
    // arms, which is right for a surface fallback and wrong for a gate.
    useAuthStore.getState().setSignedOut();
    renderGate({ kind: "mobile-no-host" }, PRESENTATION);
    expect(screen.getByTestId("gated-app")).toBeTruthy();
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
  });

  it("draws the setup card the standalone splash drew", () => {
    // This view predates the split work and the user asked for it unchanged.
    // The gate took over rendering it from `LocalHostLoading`, which wrapped
    // the body in a max-w-md shadowed Card; the shared frame's bare max-w-sm
    // column dropped that outline. Pinned because the frame is now shared with
    // the in-surface fallback, which must stay card-less.
    renderGate({ kind: "loading-host" }, PRESENTATION);
    const card = screen
      .getByTestId("host-ready-gate")
      .querySelector('[data-slot="card"]');
    if (card === null) throw new Error("Expected the setup card");
    expect(card.className).toContain("max-w-md");
    expect(card.className).toContain("shadow-sm");
  });

  it("keeps the same loading body through the compatibility probe", () => {
    // The old gate passed ONE `checking={props.loading}` node, so the probe
    // looked identical to the rest of startup. A probe-specific text-only
    // screen made the app drop from a spinner card to a bare line plus a
    // button mid-launch, which reads as a failure rather than progress.
    renderGate({ kind: "compatibility-checking" }, PRESENTATION);
    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
    expect(
      screen.queryByText("Checking Traycer Host compatibility…"),
    ).toBeNull();
  });

  it("still names the compatibility probe for a remote host", () => {
    // The local-bootstrap body (progress bar, bootstrap.log tail) would be
    // misleading for a remote target, so that arm keeps the plain message -
    // and must keep saying which wait it is.
    renderGate(
      { kind: "compatibility-checking" },
      { ...PRESENTATION, localTarget: false },
    );
    expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();
    expect(
      screen.getByText("Checking Traycer Host compatibility…"),
    ).toBeTruthy();
  });

  it("keeps recovery actions reachable inside the block", () => {
    // Blocking must not strand a user whose host cannot start: a full-screen
    // surface with no retry is the lockout shape traycer#738 exists to avoid.
    renderGate(
      { kind: "provisioning-error" },
      { ...PRESENTATION, provisioningError: new Error("boom") },
    );
    expect(screen.queryByTestId("gated-app")).toBeNull();
    expect(screen.getByTestId("local-host-provisioning-retry")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
  });
});
