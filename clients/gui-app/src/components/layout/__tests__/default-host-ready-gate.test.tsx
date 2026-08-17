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
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
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
    // Every non-ready kind EXCEPT `mobile-no-host`, which is the sole splash
    // exception below. Listed exhaustively rather than filtered from the union
    // so that adding a kind without deciding its post-latch behavior shows up
    // here as a missing row.
    const postLatchKinds: ReadonlyArray<SurfaceReadiness["kind"]> = [
      "loading-host",
      "unavailable-host",
      "provisioning-error",
      "provisioning-host",
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

  it("defers loading-host to the window modal: draws the frame, no card", () => {
    // The window narrator (D10) now speaks for this kind. The gate used to
    // draw the setup card itself (the host-boot view, wrapped in a max-w-md
    // shadowed Card); it now draws only the shared frame
    // (header + background) and leaves the card to the modal, so the two
    // surfaces never describe the same fact twice.
    renderGate({ kind: "loading-host" }, PRESENTATION);
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.narratedByWindowModal).toBe("true");
    expect(gate.querySelector('[data-slot="card"]')).toBeNull();
  });

  it("defers unavailable-host (slow local start) to the window modal: no card, no Retry here", () => {
    // The lockout this used to pin (a full-screen block with no recovery) is
    // now the window modal's job - it carries its own Retry, wired through
    // `WindowHostModalHost` (see deliverable E). The gate itself must draw
    // nothing but the frame for this kind now, or the two surfaces would
    // offer two Retry buttons for one fact.
    renderGate({ kind: "unavailable-host" }, SLOW_PRESENTATION);
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.narratedByWindowModal).toBe("true");
    expect(gate.querySelector('[data-slot="card"]')).toBeNull();
    expect(screen.queryByTestId("local-host-retry")).toBeNull();
    expect(screen.queryByText("This tab's host is unavailable.")).toBeNull();
  });

  it("no longer draws the bootstrap.log path/details itself - moved to the window modal, not dropped", () => {
    // The bootstrap.log PATH is the one thing that lets a user take a stuck
    // startup somewhere else, and it must survive this move even though it no
    // longer lives on the gate. Deliverable E pins that it still renders, on
    // the modal, via `WindowHostModalHost`'s `LocalBootstrapAttempts`.
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

    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.narratedByWindowModal).toBe("true");
    expect(screen.queryByTestId("local-host-bootstrap-log-path")).toBeNull();
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();
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

  it("offers Open settings on the provisioning-error card, and keeps it live while a retry is in flight", () => {
    // A DISTINCT claim from the Retry pin above, not a wider version of it.
    // Retry re-runs the thing that just failed; it can keep failing for a reason
    // only Settings ▸ Shell can fix, since that page edits the launch config
    // through the CLI with no running host involved. A card whose only action is
    // "try the failure again" is a dead end for exactly the user who is stuck,
    // and this card had no other exit.
    const openSettings = vi.fn();
    renderGate(
      { kind: "provisioning-error" },
      {
        ...PRESENTATION,
        provisioningError: new Error("boom"),
        openSettings,
      },
    );

    const escapeHatch = screen.getByTestId(
      "local-host-provisioning-open-settings",
    );
    expect(escapeHatch).toBeTruthy();
    // Wired, not merely present: a button that renders and does nothing is the
    // same dead end with extra steps.
    fireEvent.click(escapeHatch);
    expect(openSettings).toHaveBeenCalledTimes(1);

    cleanup();

    // UNCONDITIONAL, including mid-retry. A provision in flight is precisely
    // when someone wants to go and change the shell it is using, and gating the
    // escape hatch behind the failure it exists to fix is the lockout the window
    // modal states the same rule about. Retry is disabled here (asserted
    // elsewhere) - this must not be.
    renderGate(
      { kind: "provisioning-error" },
      {
        ...PRESENTATION,
        provisioningError: new Error("boom"),
        provisioning: true,
      },
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Open settings" })
        .disabled,
    ).toBe(false);
  });

  it("defers the zero-dialable default-host card to the window modal too - no gate-drawn card, no tab wording", () => {
    // D7 zero-dialable arm: default-host reaches unavailable-host only when
    // nothing is dialable. This card (and its copy, its report family) now
    // belongs to the window modal - the gate draws only the frame. The old
    // "tab" mislabelling pin still matters as a negative: neither the old nor
    // the new copy should ever come from the gate itself.
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
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.narratedByWindowModal).toBe("true");
    expect(gate.querySelector('[data-slot="card"]')).toBeNull();
    expect(screen.queryByText("Traycer Host is unavailable")).toBeNull();
    expect(screen.queryByText("This tab's host is unavailable.")).toBeNull();
    expect(screen.queryByTestId("local-host-retry")).toBeNull();
  });

  it("withholds retry/open-settings/report-issue from the gate on the zero-dialable card - the modal carries them now", () => {
    // These affordances (re-read the registry, open settings, report) moved
    // to `WindowHostModalHost` with the card itself. The gate must not offer
    // a second, competing copy of any of them.
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const refreshDirectory = vi.fn();
    const openSettings = vi.fn();
    renderGate(
      { kind: "unavailable-host" },
      {
        ...PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
        localHostState: "unavailable",
        stage: "loading",
        refreshDirectory,
        openSettings,
      },
    );

    expect(screen.queryByTestId("host-unavailable-retry")).toBeNull();
    expect(screen.queryByTestId("host-unavailable-open-settings")).toBeNull();
    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("no longer files HOST_NONE_DIALABLE itself - the report-code coverage moved to the window modal suite (deliverable E)", () => {
    // This report family (chosen by `anyHostDialable`, not by readiness kind
    // alone) is now the window modal's to file. The gate must not surface
    // either arm's copy nor offer a Report-issue button of its own for this
    // kind.
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
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

    expect(
      screen.queryByText(
        "Traycer can't reach this host right now, and no other host in the directory is reachable either.",
      ),
    ).toBeNull();
    expect(
      screen.queryByText(
        "Traycer can't reach this host right now. Another host is available - switch to it, or retry.",
      ),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("no longer files HOST_SELECTED_UNREACHABLE itself - the counterpart report family also moved to the window modal", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
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

    expect(
      screen.queryByText(
        "Traycer can't reach this host right now. Another host is available - switch to it, or retry.",
      ),
    ).toBeNull();
    expect(
      screen.queryByText(
        "Traycer can't reach this host right now, and no other host in the directory is reachable either.",
      ),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("still draws its own card for a NON-narrated kind (removed-host), pinning the deferral as selective, not blanket", () => {
    // The window narrator owns exactly three kinds. Everything else - here,
    // a user having removed the host - is still the gate's card to draw, with
    // `data-narrated-by-window-modal="false"`. Without this pin, a future
    // change that made `windowNarratorOwns` return `true` for everything
    // would still pass every test above.
    renderGate({ kind: "removed-host" }, PRESENTATION);
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.narratedByWindowModal).toBe("false");
    expect(gate.querySelector('[data-slot="card"]')).not.toBeNull();
  });
});
