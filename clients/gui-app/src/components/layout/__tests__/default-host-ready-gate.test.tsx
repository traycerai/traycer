import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ITraycerCli } from "@traycer-clients/shared/platform/runner-host";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
// Asserting on the inner component leaves the wiring unpinned: reverting `HostReadyGate` to `return
// props.children` would restore the regression with every test still green.
import { HostReadyGate } from "@/components/layout/host-ready-gate";
import { HOST_BOOT_CARD_SURFACE } from "@/components/centered-card";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import { appLogger } from "@/lib/logger";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const routerState = vi.hoisted(() => ({ pathname: "/" }));

// Stubbing the query rather than a 15-method ITraycerCli keeps the seam at the boundary the component actually
// consumes.
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

// The reader flags are derived from `data`, never set beside it.
vi.mock("@/hooks/runner/use-runner-traycer-host-status-query", () => ({
  useRunnerTraycerHostStatusQuery: () => ({
    data: hostStatus.data,
    isFetchedAfterMount: hostStatus.data !== undefined,
    isSuccess: hostStatus.data !== undefined,
  }),
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
  hasBeenDefaultHostReady: boolean,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: presentation,
    hasBeenDefaultHostReady,
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
  return renderGateWithCli(readiness, presentation, undefined);
}

/** The default harness models a shell with NO CLI, where the bootstrap-log disclosure structurally cannot
 * render (see `BootstrapLogDisclosure`). */
function renderGateWithCli(
  readiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
  traycerCli: ITraycerCli | null | undefined,
): GateHarness {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Modelled statefully rather than passed per call so the existing tests keep their semantics - render `ready`,
  // then flip - instead of each one having to know about the flag.
  let hasBeenReady = readiness.kind === "ready";
  const tree = (
    next: SurfaceReadiness,
    nextPresentation: DefaultHostReadinessPresentation,
  ) => (
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider
          value={controllerFor(next, nextPresentation, hasBeenReady)}
        >
          <HostReadyGate>
            <main>app</main>
          </HostReadyGate>
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
  // Providers are stable across readiness flips so the latch survives re-renders - remounting would reset it and
  // the post-latch pins would pass vacuously against a gate that still blocks.
  const view = render(tree(readiness, presentation));
  return {
    view,
    setReadiness: (next, nextPresentation) => {
      if (next.kind === "ready") hasBeenReady = true;
      view.rerender(tree(next, nextPresentation));
    },
  };
}

/** `WindowHostModalHost` is a sibling of the gate rather than a child, exactly as the app mounts it - inside it
 * the gate would replace it during a cold start and the co-render could never happen. */
function renderGateWithModal(
  readiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
  withModal: boolean,
  hasBeenReady: boolean,
): RenderResult {
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
  return render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider
          value={controllerFor(readiness, presentation, hasBeenReady)}
        >
          <HostReadyGate>
            <main>app</main>
          </HostReadyGate>
          {withModal ? <WindowHostModalHost bypassed={false} /> : null}
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

/** The presentation each post-latch kind needs to render its own surface. */
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
    // Post-latch behaviour is covered below - this pin must not be loosened into "never blocks".
    renderGate({ kind: "loading-host" }, PRESENTATION);
    expect(screen.queryByRole("main")).toBeNull();
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.readiness).toBe("loading-host");
    expect(screen.getByRole("banner").dataset.variant).toBe("host-loading");
  });

  it("keeps the app mounted after latching for every non-splash non-ready kind", () => {
    // post-latch table: once the window has been ready, non-ready kinds must not unmount the shell.
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
    // The one post-latch splash exception: a mobile shell with no host at all has no app worth keeping mounted,
    // and is not reachable via a desktop host switch.
    const harness = renderGate({ kind: "ready" }, PRESENTATION);
    expect(screen.getByRole("main")).toBeTruthy();
    harness.setReadiness({ kind: "mobile-no-host" }, PRESENTATION);
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.getByTestId("host-ready-gate").dataset.readiness).toBe(
      "mobile-no-host",
    );
  });

  it("lets /settings through even while the host is not ready", () => {
    // Gating settings on a ready host would put the escape hatch behind the failure it exists to fix.
    routerState.pathname = "/settings/shell";
    renderGate({ kind: "loading-host" }, PRESENTATION);
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
  });

  it("never blocks a signed-out user", () => {
    // Only a signed-in user can have a ready default host, so a signed-out app would block forever - with the
    // sign-in surface it needs behind the block.
    useAuthStore.getState().setSignedOut();
    renderGate({ kind: "mobile-no-host" }, PRESENTATION);
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
  });

  it("defers loading-host to the window narrator: draws the frame and no card of the KIND's own", () => {
    // What must not come back is the gate's own readiness-kind card.
    renderGate({ kind: "loading-host" }, PRESENTATION);
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.narratedByWindowModal).toBe("true");
    expect(screen.queryByTestId("host-ready-gate-loading-host")).toBeNull();
  });

  it("defers unavailable-host (slow local start) to the window narrator: no kind card, no Retry here", () => {
    // The gate itself must draw nothing but the frame for this kind now, or the two surfaces would offer two Retry
    // buttons for one fact.
    renderGate({ kind: "unavailable-host" }, SLOW_PRESENTATION);
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.narratedByWindowModal).toBe("true");
    expect(screen.queryByTestId("host-ready-gate-unavailable-host")).toBeNull();
    expect(screen.queryByTestId("local-host-retry")).toBeNull();
    expect(screen.queryByText("This tab's host is unavailable.")).toBeNull();
  });

  describe("the attach gap - who speaks before the narrator can", () => {
    /** One speaker at every moment: this card shows only while the narrator cannot speak, and yields the instant it
     * can. */
    it("covers the frame while the authority is still DETACHED", () => {
      renderGate({ kind: "loading-host" }, PRESENTATION);
      expect(screen.getByTestId("host-gate-attach-pending")).toBeTruthy();
    });

    it("yields as soon as the authority attaches, so it can never double-speak with the narrator", () => {
      renderGate({ kind: "loading-host" }, PRESENTATION);
      expect(screen.getByTestId("host-gate-attach-pending")).toBeTruthy();

      act(() => {
        useSelectionAuthorityStore.getState().applyKernelSnapshot({
          attached: true,
          preferredHostId: null,
          targetHostId: "local-host",
          effectiveHostId: "local-host",
          leases: [
            {
              hostId: "local-host",
              status: "connecting",
              dead: null,
            },
          ],
          selectionRevision: 1,
        });
      });

      expect(screen.queryByTestId("host-gate-attach-pending")).toBeNull();
    });
  });

  it("no longer draws the bootstrap.log path/details itself - moved to the window modal, not dropped", () => {
    // The bootstrap.log PATH is the one thing that lets a user take a stuck startup somewhere else, and it must
    // survive this move even though it no longer lives on the gate.
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
    // The consolidated cards kept only the disable, so a retry in flight was indistinguishable from a dead button.
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
    // A distinct claim from the Retry pin above, not a wider version of it.
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

    // Unconditional, including mid-retry. Retry is disabled here (asserted elsewhere) - this must not be.
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

  it("gives the provisioning-error card the failed attempt's diagnostics: the heading, the attempt panel with the bootstrap.log path, and Show details", () => {
    // This card wins over the window narrator on the state it describes (see `gateCardReadiness`), so the
    // narrator's settled arm - the one place the attempt panel and the log path lived.
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
    renderGateWithCli(
      { kind: "provisioning-error" },
      { ...PRESENTATION, provisioningError: new Error("boom") },
      // A real CLI: the disclosure self-hides without one, so its presence can only be proved on the positive shell.
      new MockTraycerCli(),
    );

    // Existence first, so the assertions below cannot be satisfied by a card
    // that failed to render at all.
    const card = screen.getByTestId("host-ready-gate-provisioning-error");
    expect(card).toBeTruthy();
    // The same heading the narrator's settled cold-start face draws.
    expect(
      screen.getByRole("heading", { name: "Traycer Host didn't start" }),
    ).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    // The attempt panel, with the log path IN THE OPEN (not behind the toggle).
    expect(screen.getByTestId("local-host-bootstrap-details")).toBeTruthy();
    expect(
      screen.getByTestId("local-host-bootstrap-log-path").textContent,
    ).toBe("/Users/me/.traycer/bootstrap.log");
    // The disclosure, and NOT a second `Open settings` inside it: this card
    // has a real action row that already carries the escape hatch.
    expect(
      screen.getByTestId("local-host-loading-toggle-details"),
    ).toBeTruthy();
    expect(screen.queryByTestId("host-boot-open-settings")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Open settings" }),
    ).toHaveLength(1);
    // Nothing is starting: no spinner, no boot headline.
    expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();
    expect(screen.queryByText("Starting Traycer…")).toBeNull();
  });

  it("draws restoring-request-context as the shared boot surface: idle heading, spinner, indeterminate bar, Show details and Open settings", () => {
    // A wait, not a terminal, and it can sit between the attach cover and the narrator's card on any launch.
    renderGateWithCli(
      { kind: "restoring-request-context" },
      PRESENTATION,
      new MockTraycerCli(),
    );

    const card = screen.getByTestId(
      "host-ready-gate-restoring-request-context",
    );
    expect(card.getAttribute("data-surface")).toBe(HOST_BOOT_CARD_SURFACE);
    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
    expect(screen.getByTestId("local-host-loading-stage").textContent).toBe(
      "Starting Traycer…",
    );
    expect(
      screen.getByTestId("local-host-download-progress").dataset.indeterminate,
    ).toBe("true");
    expect(screen.queryByText("Restoring authenticated session…")).toBeNull();
    expect(
      screen.getByTestId("local-host-loading-toggle-details"),
    ).toBeTruthy();
    expect(screen.getByTestId("host-boot-open-settings")).toBeTruthy();
    // Still the gate's block: the app is not mounted behind it.
    expect(screen.queryByRole("main")).toBeNull();
  });

  it("draws every gate-owned terminal through the shared boot card, so a launch that ends badly does not change shape to say so", () => {
    // The family's guarantee is one geometry by construction; this pins the construction (the card's marker)
    // rather than a class list, which would pin the current spelling of the geometry instead of the sharing.
    for (const [readiness, presentation] of [
      [
        { kind: "provisioning-error" },
        { ...PRESENTATION, provisioningError: new Error("boom") },
      ],
      [{ kind: "removed-host" }, { ...PRESENTATION, removed: true }],
      [{ kind: "mobile-no-host" }, PRESENTATION],
    ] as const) {
      renderGate(readiness, presentation);
      const frame = screen.getByTestId(`host-ready-gate-${readiness.kind}`);
      expect(
        frame.querySelector(`[data-surface="${HOST_BOOT_CARD_SURFACE}"]`),
        readiness.kind,
      ).not.toBeNull();
      cleanup();
    }
  });

  it("defers the zero-dialable default-host card to the window modal too - no gate-drawn card, no tab wording", () => {
    // zero-dialable arm: default-host reaches unavailable-host only when nothing is dialable. This card (and its
    // copy, its report family) now belongs to the window modal - the gate draws only the frame.
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
    // Per-kind, not "no Card anywhere" - see the loading-host pin above for
    // why the attach-pending cover is deliberately exempt.
    expect(screen.queryByTestId("host-ready-gate-unavailable-host")).toBeNull();
    expect(screen.queryByText("Traycer Host is unavailable")).toBeNull();
    expect(screen.queryByText("This tab's host is unavailable.")).toBeNull();
    expect(screen.queryByTestId("local-host-retry")).toBeNull();
  });

  it("withholds retry/open-settings/report-issue from the gate on the zero-dialable card - the modal carries them now", () => {
    // The gate must not offer a second, competing copy of any of them.
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
    // The gate must not surface either arm's copy nor offer a Report-issue button of its own for this kind.
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

  /** Two independent deciders, so nothing in either one's types prevents both from speaking at once, and the
   * tests above cannot see it because they never mount the modal. */
  describe("the gate and the window modal, when both could speak", () => {
    const DEAD_LOCAL_LEASE = {
      hostId: "local-host",
      status: "dead",
      dead: { reason: "offline" },
    } as HostLeaseSnapshot;

    function applyEmptyFleet(): void {
      // Annotated rather than asserted: an annotation is checked against the type, so a field the kernel snapshot
      // grows later is a compile error here instead of a silently-missing input.
      const snapshot: SelectionKernelSnapshot = {
        attached: true,
        preferredHostId: null,
        targetHostId: "local-host",
        effectiveHostId: null,
        leases: [DEAD_LOCAL_LEASE],
        selectionRevision: 1,
      };
      act(() => {
        useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
      });
    }

    it("A (positive control): the gate's provisioning-error card CAN render", () => {
      renderGateWithModal(
        { kind: "provisioning-error" },
        { ...PRESENTATION, provisioningError: new Error("bootstrap exited 1") },
        false,
        false,
      );
      expect(
        screen.getByTestId("host-ready-gate-provisioning-error"),
      ).toBeTruthy();
      expect(
        screen.getByTestId("host-ready-gate").dataset.narratedByWindowModal,
      ).toBe("false");
    });

    it("B (positive control): the window narrator CAN render in this harness, on the ∅ authority state", () => {
      // Without this, case C would pass on a harness where `WindowHostModalHost` throws or silently returns null.
      applyEmptyFleet();
      renderGateWithModal(
        { kind: "unavailable-host" },
        SLOW_PRESENTATION,
        true,
        false,
      );
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
      expect(
        screen.queryByTestId("host-ready-gate-unavailable-host"),
      ).toBeNull();
    });

    it("C: with a provisioning error AND an empty fleet, only ONE of them narrates", () => {
      // Both conditions at once, which is a single-host account whose local provision threw: readiness is
      // `provisioning-error` (A's state) and the authority has nothing effective (B's state).
      applyEmptyFleet();
      renderGateWithModal(
        { kind: "provisioning-error" },
        { ...PRESENTATION, provisioningError: new Error("bootstrap exited 1") },
        true,
        false,
      );

      const gateCard = screen.queryByTestId(
        "host-ready-gate-provisioning-error",
      );
      // Which one the narrator would reach for depends on whether the gate is blocking, and this case runs with
      // `hasBeenReady: false`.
      const narrator =
        screen.queryByTestId("window-host-modal") ??
        screen.queryByTestId("window-host-startup-card");
      // Stated as a count rather than as two absences: "not both" must not be satisfiable by neither.
      const narrators = [gateCard, narrator].filter((el) => el !== null);
      expect(narrators).toHaveLength(1);
    });

    it("D: the same holds for removed-host, the OTHER gate-drawn kind", () => {
      // Its card is not given `Open settings`, deliberately and unlike the provisioning-error card.
      applyEmptyFleet();
      renderGateWithModal({ kind: "removed-host" }, PRESENTATION, true, false);

      const narrators = [
        screen.queryByTestId("host-ready-gate-removed-host"),
        // Both presentations, for the reason spelled out in case C.
        screen.queryByTestId("window-host-modal") ??
          screen.queryByTestId("window-host-startup-card"),
      ].filter((el) => el !== null);
      expect(narrators).toHaveLength(1);
      // Named, so a future change that silenced BOTH could not satisfy this by
      // cardinality alone: on this arm the survivor must be the gate's card.
      expect(screen.getByTestId("host-ready-gate-removed-host")).toBeTruthy();
      expect(screen.getByTestId("local-host-removed-reinstall")).toBeTruthy();
    });

    it("E: AFTER the gate latches, the modal narrates and is NOT suppressed", () => {
      // A suppression keyed on the readiness kind rather than on the latch would go silent here too.
      applyEmptyFleet();
      renderGateWithModal(
        { kind: "provisioning-error" },
        { ...PRESENTATION, provisioningError: new Error("bootstrap exited 1") },
        true,
        // The latch, which is the entire difference from case C.
        true,
      );

      // The gate has stepped aside completely - not even its frame.
      expect(screen.queryByTestId("host-ready-gate")).toBeNull();
      expect(
        screen.queryByTestId("host-ready-gate-provisioning-error"),
      ).toBeNull();
      // ...so the modal must be speaking, and the app stays mounted behind it.
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
      // It is still mounted - which is the claim - and a role query here fails for a reason that has nothing to do
      // with the latch.
      expect(screen.getByText("app")).toBeTruthy();
    });

    /** F: the stand-down leaves a trace, and only when it happens. Without a line naming which card won and what
     * was suppressed, the first question triage asks about this mechanism has no answer in the logs. */
    it("F: records the stand-down, naming the card that won and what it silenced", () => {
      // This suite has no mock reset in `afterEach`, and `vi.spyOn` on an already-spied method hands back the
      // existing spy with its accumulated calls.
      const info = vi.spyOn(appLogger, "info");
      info.mockClear();
      applyEmptyFleet();
      renderGateWithModal(
        { kind: "provisioning-error" },
        { ...PRESENTATION, provisioningError: new Error("bootstrap exited 1") },
        true,
        false,
      );

      const standDowns = info.mock.calls.filter((call) =>
        call[0].includes("stood down"),
      );
      expect(standDowns).toHaveLength(1);
      expect(standDowns[0][1]).toEqual({
        by: "provisioning-error",
        suppressedCause: "no-usable-host",
        suppressedVariant: "offline",
      });
    });

    it("F (negative): says nothing when there is nothing to suppress", () => {
      const info = vi.spyOn(appLogger, "info");
      info.mockClear();
      applyEmptyFleet();
      // Case E's state: post-latch, the gate draws no card and the modal is the
      // sole narrator. It did not stand down, so it must not claim to have.
      renderGateWithModal(
        { kind: "provisioning-error" },
        { ...PRESENTATION, provisioningError: new Error("bootstrap exited 1") },
        true,
        true,
      );

      // The premise, asserted rather than assumed: this arm is only meaningful while the modal is actually on
      // screen. If it were absent the "no log" assertion would pass for the wrong reason.
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
      expect(
        info.mock.calls.filter((call) => call[0].includes("stood down")),
      ).toEqual([]);
    });
  });

  it("still draws its own card for a NON-narrated kind (removed-host), pinning the deferral as selective, not blanket", () => {
    // Without this pin, a future change that made `windowNarratorOwns` return `true` for everything would still
    // pass every test above.
    renderGate({ kind: "removed-host" }, PRESENTATION);
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.narratedByWindowModal).toBe("false");
    expect(gate.querySelector('[data-slot="card"]')).not.toBeNull();
  });
});
