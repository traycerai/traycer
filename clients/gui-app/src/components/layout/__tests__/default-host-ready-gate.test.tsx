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
// Deliberately the ROUTE-FACING name, not `DefaultHostReadyGate` underneath it.
// Asserting on the inner component leaves the wiring unpinned: reverting
// `HostReadyGate` to `return props.children` would restore the regression with
// every test still green.
import { HostReadyGate } from "@/components/layout/host-ready-gate";
import { HOST_BOOT_CARD_SURFACE } from "@/components/centered-card";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import { appLogger } from "@/lib/logger";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
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

// The reader flags are DERIVED from `data`, never set beside it. The attempt
// panel (`LocalBootstrapAttempts`) refuses a cached snapshot and refuses the
// one a failed refetch retained, so it reads `isFetchedAfterMount` and
// `isSuccess` as well - and a seam that let a fixture assert `isSuccess` while
// `data` was `undefined` would be a state the real hook cannot produce, which
// is how a mock ends up testing itself. `success` means "there is a snapshot"
// here exactly as it does there. The fresh-read behaviour itself is exercised
// against the real hook in `local-bootstrap-attempts.test.tsx`; this seam is
// only about what the surfaces do with a snapshot once they legitimately have
// one.
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

/**
 * `renderGate` with the shell's CLI stated. The default harness models a shell
 * with NO CLI, where the bootstrap-log disclosure structurally cannot render
 * (see `BootstrapLogDisclosure`) - so a fixture that asserts `Show details`
 * PRESENT has to pass a real one, or it is asserting against nothing.
 */
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
  // THE LATCH LIVES IN THE PROVIDER NOW, so this harness has to model it.
  //
  // It used to be `useState` inside the gate, and simply rendering `ready` once
  // set it. It moved to `HostReadinessController` because the window modal needs
  // to read it too (see `gateCardReadiness`), and this suite hand-supplies that
  // context - so a harness that always reported `false` would leave the gate
  // blocking for ever and every post-latch pin below would fail against a
  // correct gate.
  //
  // Modelled statefully rather than passed per call so the existing tests keep
  // their semantics - render `ready`, then flip - instead of each one having to
  // know about the flag. Monotonic, exactly like the provider: set once, never
  // cleared.
  //
  // What this harness therefore does NOT prove is that the REAL provider
  // latches. That is `app-stays-mounted-across-host-switch.test.tsx`, the only
  // suite in the tree mounting the production chain, where a broken latch
  // unmounts the app across a switch and reddens it.
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
  // Providers are stable across readiness flips so the latch survives re-renders -
  // remounting would reset it and the post-latch pins would pass vacuously
  // against a gate that still blocks.
  const view = render(tree(readiness, presentation));
  return {
    view,
    setReadiness: (next, nextPresentation) => {
      if (next.kind === "ready") hasBeenReady = true;
      view.rerender(tree(next, nextPresentation));
    },
  };
}

/**
 * The gate AND the window modal in one tree, which is the only arrangement that
 * can see them collide.
 *
 * `WindowHostModalHost` is a sibling of the gate rather than a child, exactly as
 * the app mounts it - inside it the gate would replace it during a cold start and
 * the co-render could never happen.
 */
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

  it("defers loading-host to the window narrator: draws the frame and no card of the KIND's own", () => {
    // The window narrator (D10) now speaks for this kind. The gate used to
    // draw the setup card itself (the host-boot view, wrapped in a max-w-md
    // shadowed Card); it now draws only the shared frame
    // (header + background) and leaves the card to the narrator, so the two
    // surfaces never describe the same fact twice.
    //
    // ASSERTED PER-KIND, not as "no Card anywhere". While the authority is
    // still DETACHED the narrator is structurally silent
    // (`deriveWindowNarration` returns silent on `attached: false`), and the
    // attach-pending card below covers that gap - so a blanket
    // `[data-slot="card"]` absence would forbid the one surface that keeps
    // the frame from being a blank page. What must not come back is the
    // gate's own readiness-kind card.
    renderGate({ kind: "loading-host" }, PRESENTATION);
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.narratedByWindowModal).toBe("true");
    expect(screen.queryByTestId("host-ready-gate-loading-host")).toBeNull();
  });

  it("defers unavailable-host (slow local start) to the window narrator: no kind card, no Retry here", () => {
    // The lockout this used to pin (a full-screen block with no recovery) is
    // now the window narrator's job - it carries its own Retry, wired through
    // `WindowHostModalHost` (see deliverable E). The gate itself must draw
    // nothing but the frame for this kind now, or the two surfaces would
    // offer two Retry buttons for one fact.
    renderGate({ kind: "unavailable-host" }, SLOW_PRESENTATION);
    const gate = screen.getByTestId("host-ready-gate");
    expect(gate.dataset.narratedByWindowModal).toBe("true");
    expect(screen.queryByTestId("host-ready-gate-unavailable-host")).toBeNull();
    expect(screen.queryByTestId("local-host-retry")).toBeNull();
    expect(screen.queryByText("This tab's host is unavailable.")).toBeNull();
  });

  describe("the attach gap - who speaks before the narrator can", () => {
    /**
     * The narrator is silent by CONSTRUCTION until the selection kernel
     * attaches, and for a narrator-owned kind the gate draws no card. Nothing
     * covered the interval between those two facts, so a launch showed a bare
     * header over an empty page for the whole attach latency - under a
     * `data-narrated-by-window-modal="true"` attribute asserting a narrator
     * that was provably not rendering yet.
     *
     * One speaker at every moment: this card shows only while the narrator
     * cannot speak, and yields the instant it can.
     */
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

  it("gives the provisioning-error card the failed attempt's diagnostics: the heading, the attempt panel with the bootstrap.log path, and Show details", () => {
    // This card WINS over the window narrator on the state it describes (see
    // `gateCardReadiness`), so the narrator's settled arm - the one place the
    // attempt panel and the log path lived - was unreachable on exactly the
    // launch that most needed them. A first launch whose install failed got
    // "boom" and a Retry, and no path to take the failure anywhere.
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
      // A real CLI: the disclosure self-hides without one, so its PRESENCE can
      // only be proved on the positive shell.
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
    // A WAIT, not a terminal, and it can sit between the attach cover and the
    // narrator's card on any launch. It used to be a bare "Restoring
    // authenticated session…" line with no spinner and no controls - a fourth
    // card shape in a launch that must have one. Now it is the same card, the
    // same idle sentence, the same bar and the same footer pair as the
    // surfaces on either side of it, so the hand-off is invisible. The
    // testids are the boot BODY's own (`local-host-loading-*`): the surface
    // is that body with no lane, not a look-alike.
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
    // The family's guarantee is one geometry by construction; this pins the
    // construction (the card's marker) rather than a class list, which would
    // pin the current spelling of the geometry instead of the sharing.
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
    // Per-kind, not "no Card anywhere" - see the loading-host pin above for
    // why the attach-pending cover is deliberately exempt.
    expect(screen.queryByTestId("host-ready-gate-unavailable-host")).toBeNull();
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

  /**
   * ONE NARRATOR PER SCOPE, tested where the two narrators can actually collide.
   *
   * `provisioning-error` and `removed-host` are gate-drawn - deliberately, they
   * are local lifecycle terminals - while the window modal is mounted OUTSIDE
   * this gate and derives its own verdict from the authority's leases rather
   * than from readiness. Two independent deciders, so nothing in either one's
   * types prevents both from speaking at once, and the tests above cannot see it
   * because they never mount the modal.
   *
   * Order is load-bearing. Both surfaces are proved renderable FIRST, in the
   * exact states the third case combines, because "they are never both present"
   * is satisfied completely by a tree where neither can render - and a harness
   * that silently fails to mount one of them is the likeliest way this suite
   * would go quietly vacuous.
   */
  describe("the gate and the window modal, when both could speak", () => {
    const DEAD_LOCAL_LEASE = {
      hostId: "local-host",
      status: "dead",
      dead: { reason: "offline" },
    } as HostLeaseSnapshot;

    /** The ∅ authority state: attached, nothing effective, local lease dead. */
    function applyEmptyFleet(): void {
      // Annotated rather than asserted: an annotation is CHECKED against the
      // type, so a field the kernel snapshot grows later is a compile error here
      // instead of a silently-missing input.
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
      // A NARRATED readiness kind, so the gate draws no card of its own and the
      // only thing being proved here is that the narrator reaches the DOM under
      // this provider stack. Without this, case C would pass on a harness where
      // `WindowHostModalHost` throws or silently returns null.
      //
      // The STARTUP CARD is what it renders here, not the dialog: `hasBeenReady`
      // is false, so the gate is still blocking and there is no app behind this
      // surface to trap pointers over. The dialog form is post-latch only.
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
      // Both conditions at once, which is a single-host account whose local
      // provision threw: readiness is `provisioning-error` (A's state) and the
      // authority has nothing effective (B's state). Before this was pinned the
      // user saw the modal floating at z-[60] behind its blur over the gate's
      // own centred card, each with its own copy and its own recovery actions -
      // the layering this epic exists to delete, rebuilt out of two deciders
      // that were each correct alone.
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
      // BOTH narrator presentations are queried. Which one the narrator would
      // reach for depends on whether the gate is blocking, and this case runs
      // with `hasBeenReady: false` - so querying the dialog testid alone would
      // assert the absence of a surface that could not have rendered here
      // anyway, and case C would go quietly vacuous while still passing.
      const narrator =
        screen.queryByTestId("window-host-modal") ??
        screen.queryByTestId("window-host-startup-card");
      // Stated as a count rather than as two absences: "not both" must not be
      // satisfiable by NEITHER. One of them has to be narrating this failure -
      // a state that produces silence is a worse bug than a state that produces
      // two cards.
      const narrators = [gateCard, narrator].filter((el) => el !== null);
      expect(narrators).toHaveLength(1);
    });

    it("D: the same holds for removed-host, the OTHER gate-drawn kind", () => {
      // The row next door. `removed-host` is gate-drawn for the same reason
      // `provisioning-error` is - a local lifecycle terminal - so it co-renders
      // identically, and a suppression written for one kind would leave this one
      // broken while a test named for the fix passed. That is the precise shape
      // of the half-fix this branch has already had to reopen once.
      //
      // Its card is NOT given `Open settings`, deliberately and unlike the
      // provisioning-error card: the user removed the host on purpose, Reinstall
      // is the direct remedy and Quit is a real exit, so there is no lockout to
      // relieve. That is a decision about actions; this test is about scope.
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
      // THE ZERO CASE, and the reason the assertions above count narrators
      // instead of asserting two absences.
      //
      // Post-latch the gate stops replacing the app and draws no card for these
      // kinds at all, so the modal is the only surface left that can say
      // anything. A suppression keyed on the readiness KIND rather than on the
      // latch would go silent here too - and "neither is present" would satisfy
      // a naive "they are never both present" assertion while shipping a failure
      // nobody narrates. Silence is strictly worse than two cards.
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
      // By TEXT, not by `getByRole("main")`, and the reason is worth keeping:
      // this modal is a Radix `modal` dialog, so it marks everything outside
      // itself `aria-hidden` and the app's `<main>` stops being reachable by
      // role. It is still mounted - which is the claim - and a role query here
      // fails for a reason that has nothing to do with the latch. The first
      // draft of this assertion did exactly that.
      expect(screen.getByText("app")).toBeTruthy();
    });

    /**
     * F: the stand-down leaves a trace, and only when it happens.
     *
     * A suppression is invisible by construction: the surface renders nothing,
     * so from a screenshot "the modal correctly deferred" and "the modal is
     * broken and missing" are the same picture. Without a line naming WHICH
     * card won and WHAT was suppressed, the first question triage asks about
     * this mechanism has no answer in the logs.
     *
     * Both halves are asserted, and the second is the one that makes the first
     * mean something: a log that fires on every render of this component -
     * including case E, where nothing is suppressed - would satisfy the
     * positive arm while telling a reader nothing. Existence, then absence.
     */
    it("F: records the stand-down, naming the card that won and what it silenced", () => {
      // `mockClear` is load-bearing, not hygiene. This suite has no mock reset
      // in `afterEach`, and `vi.spyOn` on an already-spied method hands back the
      // EXISTING spy with its accumulated calls - so without this, arms C and D
      // (which drive the same suppression) leak their lines into these counts.
      // The negative arm below caught exactly that, and read as a code defect
      // until the spy was checked.
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

      // The premise, asserted rather than assumed: this arm is only meaningful
      // while the modal is actually on screen. If it were absent the "no log"
      // assertion would pass for the wrong reason.
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
      expect(
        info.mock.calls.filter((call) => call[0].includes("stood down")),
      ).toEqual([]);
    });
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
