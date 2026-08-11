import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
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

// `traycer host status` is a CLI subprocess read. Stubbing the query rather
// than a 15-method ITraycerCli keeps the seam at the boundary the component
// actually consumes. `data: undefined` reproduces a shell with no CLI, where
// the query is disabled and the diagnostics correctly stay hidden.
const hostStatus = vi.hoisted(() => ({
  data: undefined as
    | {
        readonly bootstrapMarkers: ReadonlyArray<{
          readonly timestamp: string;
          readonly phase: string;
          readonly fields: Readonly<Partial<Record<string, string>>>;
        }>;
        readonly bootstrapLogPath: string;
        readonly bootstrapLogTail: string;
      }
    | undefined,
}));

vi.mock("@/hooks/runner/use-runner-traycer-host-status-query", () => ({
  useRunnerTraycerHostStatusQuery: () => hostStatus,
}));

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
    <header data-variant={props.variant} />
  ),
}));

const PRESENTATION: DefaultHostReadinessPresentation = {
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

function controllerFor(
  readiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: presentation,
  };
}

interface GateHarness {
  readonly view: RenderResult;
  readonly setReadiness: (
    readiness: SurfaceReadiness,
    presentation: DefaultHostReadinessPresentation,
  ) => void;
}

function renderGate(
  readiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
): GateHarness {
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
  // Providers are stable across readiness flips so the gate's latch (per-
  // window state, set once the first `ready` renders) survives re-renders -
  // remounting the gate would reset it and the post-latch pins would pass
  // vacuously against a gate that still blocks.
  const view = render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider
          value={controllerFor(readiness, presentation)}
        >
          <HostReadyGate>
            <main>app</main>
          </HostReadyGate>
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return {
    view,
    setReadiness: (next, nextPresentation) => {
      view.rerender(
        <QueryClientProvider client={client}>
          <RunnerHostProvider runnerHost={runnerHost}>
            <HostReadinessControllerContext.Provider
              value={controllerFor(next, nextPresentation)}
            >
              <HostReadyGate>
                <main>app</main>
              </HostReadyGate>
            </HostReadinessControllerContext.Provider>
          </RunnerHostProvider>
        </QueryClientProvider>,
      );
    },
  };
}

/**
 * The presentation each post-latch kind needs to render its own surface: the
 * provisioning-error card only exists while a converge error is live, and the
 * slow-local-host card only while the local host has actually gone
 * unavailable. Everything else is the plain fixture.
 */
function presentationForPostLatchKind(
  kind: SurfaceReadiness["kind"],
): DefaultHostReadinessPresentation {
  if (kind === "provisioning-error") {
    return { ...PRESENTATION, provisioningError: new Error("boom") };
  }
  if (kind === "unavailable-host") return SLOW_PRESENTATION;
  return PRESENTATION;
}

const SLOW_PRESENTATION: DefaultHostReadinessPresentation = {
  ...PRESENTATION,
  targetKind: "local",
  localHostState: "unavailable",
  stage: "slow",
};

beforeEach(() => {
  routerState.pathname = "/";
  hostStatus.data = undefined;
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
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
  });

  it("replaces the whole app - not just a surface - on a cold start before the host is ready", () => {
    // Cold-start only (D1). Before the gate has ever seen `ready` it still
    // replaces the shell: with only per-surface fallbacks the tab strip and
    // every host-dependent affordance in it stayed reachable during setup.
    // Post-latch behaviour is covered below - this pin must not be loosened
    // into "never blocks".
    renderGate({ kind: "loading-host" }, PRESENTATION);
    expect(screen.queryByRole("main")).toBeNull();
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.readiness).toBe("loading-host");
    expect(screen.getByRole("banner").dataset.variant).toBe("host-loading");
  });

  it("keeps the app mounted after latching for every non-splash non-ready kind", () => {
    // D1 post-latch table: once the window has been ready, non-ready kinds
    // must NOT unmount the shell. That unmount is what made every host switch
    // (and every transient probe failure on a host that was already running)
    // throw away editors, terminals, scroll, and popovers.
    const postLatchKinds: ReadonlyArray<SurfaceReadiness["kind"]> = [
      "loading-host",
      "compatibility-checking",
      "unavailable-host",
      "provisioning-error",
      "compatibility-error",
      "incompatible-host",
      "removed-host",
      "restoring-request-context",
    ];
    const harness = renderGate({ kind: "ready" }, PRESENTATION);
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();

    for (const kind of postLatchKinds) {
      harness.setReadiness({ kind }, presentationForPostLatchKind(kind));
      expect(screen.getByRole("main")).toBeTruthy();
      expect(screen.queryByTestId("host-ready-gate")).toBeNull();
    }
  });

  it("still full-screens mobile-no-host after the gate has latched", () => {
    // The one post-latch splash exception: a mobile shell with no host at all
    // has no app worth keeping mounted, and is not reachable via a desktop
    // host switch.
    const harness = renderGate({ kind: "ready" }, PRESENTATION);
    expect(screen.getByRole("main")).toBeTruthy();
    harness.setReadiness({ kind: "mobile-no-host" }, PRESENTATION);
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.getByTestId("host-ready-gate").dataset.readiness).toBe(
      "mobile-no-host",
    );
  });

  it("lets /settings through even while the host is not ready", () => {
    // The splash's own "Configure shell" button navigates to /settings/shell.
    // Gating settings on a ready host would put the escape hatch behind the
    // failure it exists to fix.
    routerState.pathname = "/settings/shell";
    renderGate({ kind: "loading-host" }, PRESENTATION);
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
  });

  it("never blocks a signed-out user", () => {
    // Only a signed-in user can have a ready default host, so a signed-out
    // app would block forever - with the sign-in surface it needs behind the
    // block. The readiness kinds themselves are not auth-aware on the host
    // arms, which is right for a surface fallback and wrong for a gate.
    useAuthStore.getState().setSignedOut();
    renderGate({ kind: "mobile-no-host" }, PRESENTATION);
    expect(screen.getByRole("main")).toBeTruthy();
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
      { ...PRESENTATION, targetKind: "remote" },
    );
    expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();
    expect(
      screen.getByText("Checking Traycer Host compatibility…"),
    ).toBeTruthy();
  });

  it("offers Retry when the local host failed to start", () => {
    // The lockout this pins. The gate used to call `fallbackContent` directly,
    // skipping the slow-local-host branch that only `SurfaceReadinessFallback`
    // had - so a full-screen block on a host that never came up rendered
    // "This tab's host is unavailable." with NO recovery at all, and copy that
    // called the whole app a tab.
    renderGate({ kind: "unavailable-host" }, SLOW_PRESENTATION);
    expect(screen.getByTestId("local-host-retry")).toBeTruthy();
    expect(screen.queryByText("This tab's host is unavailable.")).toBeNull();
  });

  it("shows what was tried and where the full log lives", () => {
    // The bootstrap.log PATH is the one thing that lets a user take a stuck
    // startup somewhere else. It lived on the old unavailable card and was
    // orphaned with it. Rendered outside the "Show details" disclosure - a
    // path you must expand a toggle to discover is a path most never find.
    hostStatus.data = {
      bootstrapMarkers: [
        {
          timestamp: "t0",
          phase: "starting",
          fields: { shell: "/bin/zsh", args: "-i -l -c traycer" },
        },
        { timestamp: "t1", phase: "crashed", fields: { code: "1" } },
      ],
      bootstrapLogPath: "/Users/me/.traycer/bootstrap.log",
      bootstrapLogTail: "",
    };
    renderGate({ kind: "unavailable-host" }, SLOW_PRESENTATION);

    expect(
      screen.getByTestId("local-host-bootstrap-log-path").textContent,
    ).toBe("/Users/me/.traycer/bootstrap.log");
    const details = screen.getByTestId("local-host-bootstrap-details");
    expect(details.textContent).toContain("/bin/zsh -i -l -c traycer");
    expect(details.textContent).toContain("Host crashed with code 1.");
  });

  it("keeps spawn diagnostics off a healthy start", () => {
    // Under a normally-progressing spinner there is no failed attempt to
    // explain, and shell/exit-code detail there reads as an error.
    hostStatus.data = {
      bootstrapMarkers: [
        { timestamp: "t0", phase: "starting", fields: { shell: "/bin/zsh" } },
      ],
      bootstrapLogPath: "/Users/me/.traycer/bootstrap.log",
      bootstrapLogTail: "",
    };
    renderGate({ kind: "loading-host" }, PRESENTATION);
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();
  });

  it("spins the Retry it disables", () => {
    // Pending work states itself with an inline spinner beside an unchanged
    // label everywhere else in this app. The consolidated cards kept only the
    // disable, so a retry in flight was indistinguishable from a dead button.
    renderGate(
      { kind: "provisioning-error" },
      {
        ...PRESENTATION,
        provisioningError: new Error("boom"),
        provisioning: true,
      },
    );
    expect(
      screen.getByTestId("local-host-provisioning-retry-spinner"),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Retry" }).disabled,
    ).toBe(true);
  });

  it("tells a user who removed Traycer how to finish", () => {
    // "Reinstall to start the host again" answered a question they were not
    // asking - they removed it deliberately and need the next step.
    renderGate({ kind: "removed-host" }, PRESENTATION);
    expect(screen.getByTestId("local-host-removed-quit").textContent).toContain(
      "Quit Traycer",
    );
    expect(
      screen.getByText(/drag it from Applications to the Trash/),
    ).toBeTruthy();
  });

  it("labels the incompatibility reason and keeps a restart error distinct", () => {
    // Both were flattened into one joined sentence, which read as noise: they
    // answer different questions - why the host is rejected, and why the last
    // attempt to fix it failed.
    renderGate(
      { kind: "incompatible-host" },
      {
        ...PRESENTATION,
        canManageHost: true,
        provisioningError: new Error("restart failed"),
        compatibility: {
          ...PRESENTATION.compatibility,
          status: "incompatible",
          errorMessage: "host 1.0.0 < required 1.1.0",
        },
      },
    );
    expect(
      screen.getByTestId("local-host-incompatible-reason").textContent,
    ).toContain("Reason: host 1.0.0 < required 1.1.0");
    expect(
      screen.getByTestId("local-host-incompatible-restart-error").textContent,
    ).toBe("restart failed");
    expect(
      screen.getByText(/not compatible with the running host/),
    ).toBeTruthy();
    expect(screen.getByTestId("local-host-incompatible-update")).toBeTruthy();
  });

  it("keeps recovery actions reachable inside the block", () => {
    // Blocking must not strand a user whose host cannot start: a full-screen
    // surface with no retry is the lockout shape traycer#738 exists to avoid.
    renderGate(
      { kind: "provisioning-error" },
      { ...PRESENTATION, provisioningError: new Error("boom") },
    );
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("names the zero-dialable default-host card without calling the app a tab", () => {
    // D7 zero-dialable arm: default-host reaches unavailable-host only when
    // nothing is dialable. The tab wording mislabelled the whole app; the
    // slow-local branch (localHostState unavailable + stage slow) is a
    // different card and must not be taken here.
    renderGate(
      { kind: "unavailable-host" },
      {
        ...PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
        localHostState: "unavailable",
        stage: "loading",
      },
    );
    expect(screen.getByText("Traycer Host is unavailable")).toBeTruthy();
    expect(screen.queryByText("This tab's host is unavailable.")).toBeNull();
    // Must not have been routed to the slow-local startup card.
    expect(screen.queryByTestId("local-host-retry")).toBeNull();
  });

  it("offers retry, switch host, open settings, and report-issue on the zero-dialable card", () => {
    // Pins the four affordances that ship with the zero-dialable card: re-read
    // the registry, open the picker, open settings, and report. Each used to
    // be missing (`actions: []`, `footer: null`) behind a full-screen block.
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const refreshDirectory = vi.fn();
    const openHostPicker = vi.fn();
    const openSettings = vi.fn();
    renderGate(
      { kind: "unavailable-host" },
      {
        ...PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
        localHostState: "unavailable",
        stage: "loading",
        anyHostDialable: false,
        refreshDirectory,
        openHostPicker,
        openSettings,
      },
    );

    fireEvent.click(screen.getByTestId("host-unavailable-retry"));
    fireEvent.click(screen.getByTestId("host-unavailable-switch-host"));
    fireEvent.click(screen.getByTestId("host-unavailable-open-settings"));
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    expect(openHostPicker).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
  });

  it("files HOST_NONE_DIALABLE when no host in the directory is dialable", () => {
    // Pins the report family chosen by a fact (`anyHostDialable`), not by
    // readiness kind alone - collapsing distinct causes into one code is the
    // triage failure these families exist to end.
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    renderGate(
      { kind: "unavailable-host" },
      {
        ...PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
        localHostState: "unavailable",
        stage: "loading",
        anyHostDialable: false,
      },
    );

    expect(
      screen.getByText(
        "Traycer can't reach this host right now, and no other host in the directory is reachable either.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Traycer can't reach this host right now. Another host is available - switch to it, or retry.",
      ),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    const context = useDesktopDialogStore.getState().reportIssueContext;
    expect(context?.code).toBe("HOST_NONE_DIALABLE");
    expect(context?.source).toBe("Host connection");
  });

  it("files HOST_SELECTED_UNREACHABLE when another host in the directory is dialable", () => {
    // Counterpart family: selected host dead but something else is reachable
    // (two-read wait before failover, or this machine booting while a remote
    // is listed). Detail copy must not silently converge with the zero-dialable
    // arm.
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    renderGate(
      { kind: "unavailable-host" },
      {
        ...PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
        localHostState: "unavailable",
        stage: "loading",
        anyHostDialable: true,
      },
    );

    expect(
      screen.getByText(
        "Traycer can't reach this host right now. Another host is available - switch to it, or retry.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Traycer can't reach this host right now, and no other host in the directory is reachable either.",
      ),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    const context = useDesktopDialogStore.getState().reportIssueContext;
    expect(context?.code).toBe("HOST_SELECTED_UNREACHABLE");
    expect(context?.source).toBe("Host connection");
  });
});
