import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ITraycerCli } from "@traycer-clients/shared/platform/runner-host";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HOST_BOOT_CARD_SURFACE } from "@/components/centered-card";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useAuthStore } from "@/stores/auth/auth-store";

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

/**
 * The host controller's mutation lane, which is where ALL provisioning
 * narration comes from - never this renderer's own mutation observer.
 */
const controllerStatus = vi.hoisted(() => ({
  data: undefined as
    | {
        readonly mutation: {
          readonly kind: string;
          readonly progress: null;
          readonly startedAt: string;
        } | null;
      }
    | undefined,
}));

vi.mock("@/hooks/runner/use-runner-host-controller-status-query", () => ({
  useRunnerHostControllerStatusQuery: () => controllerStatus,
}));

// Pinned so the version-skew DIRECTION under test is a property of the
// fixture, not of whatever version this build happens to carry.
vi.mock("@/lib/app-version", () => ({
  getClientAppVersion: () => "1.5.0",
  getClientAppVersionLabel: () => "1.5.0",
}));

const LOCAL_HOST_ID = "local-host";
const REMOTE_HOST_ID = "remote-host";

function lease(overrides: Partial<HostLeaseSnapshot>): HostLeaseSnapshot {
  return {
    hostId: LOCAL_HOST_ID,
    status: "connecting",
    dead: null,
    ...overrides,
  } as HostLeaseSnapshot;
}

function deadLease(
  hostId: string,
  dead: HostLeaseSnapshot["dead"],
): HostLeaseSnapshot {
  return { hostId, status: "dead", dead } as HostLeaseSnapshot;
}

const EMPTY_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
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
  presentation: DefaultHostReadinessPresentation,
  readiness: SurfaceReadiness,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: presentation,
    hasBeenDefaultHostReady: false,
  };
}

/**
 * The gate is OPEN: an app is mounted behind the narrator.
 *
 * `ready` makes `gateBlocksApp` false, which is what selects the narrator's
 * DIALOG presentation - the blocking form, correct only when there is a live
 * app the ∅ verdict has to stop the user driving.
 */
const GATE_OPEN: SurfaceReadiness = { kind: "ready" };

/**
 * The gate is BLOCKING: a launch, with no app behind the narrator yet.
 *
 * A narrator-owned kind, so the gate draws no card of its own and hands the
 * words over - which selects the narrator's CARD presentation. This is the
 * state every cold-start fixture below is describing, and modelling it as
 * `ready` would have them assert the launch's action precedence against the
 * post-latch surface instead.
 */
const GATE_BLOCKING: SurfaceReadiness = { kind: "loading-host" };

/**
 * The narrator's surface, whichever presentation it chose.
 *
 * For fixtures whose subject is WHETHER the narrator speaks - the served
 * latch, the ∅ re-open - rather than which form it takes. Naming one testid
 * there would couple a latch test to a presentation rule and, worse, let it
 * pass vacuously the day the other form is the one that renders.
 */
function narratorSurface(): HTMLElement | null {
  return (
    screen.queryByTestId("window-host-modal") ??
    screen.queryByTestId("window-host-startup-card")
  );
}

function applySnapshot(overrides: Partial<SelectionKernelSnapshot>): void {
  const snapshot: SelectionKernelSnapshot = {
    attached: true,
    preferredHostId: null,
    targetHostId: null,
    effectiveHostId: null,
    leases: [],
    selectionRevision: 1,
    ...overrides,
  };
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
  });
}

function renderHost(
  presentation: DefaultHostReadinessPresentation,
  bypassed: boolean,
  // Required, not optional (`fn(x?: T)` is banned): every call site states
  // what it wants rather than inheriting a default that could drift. `undefined`
  // preserves the prior no-CLI shell for every existing fixture; only the
  // fixtures that specifically assert the bootstrap-log toggle pass a real one
  // - see `local-host-loading.test.tsx`'s own positive/negative control pair
  // for why a no-CLI shell can never prove that toggle's presence.
  traycerCli: ITraycerCli | null | undefined,
) {
  return renderHostWithGate(presentation, bypassed, traycerCli, GATE_OPEN);
}

/**
 * `renderHost` with the gate state stated explicitly. Used by the cold-start
 * fixtures, which are describing a LAUNCH and therefore need the blocking gate
 * (see {@link GATE_BLOCKING}).
 */
function renderHostWithGate(
  presentation: DefaultHostReadinessPresentation,
  bypassed: boolean,
  traycerCli: ITraycerCli | null | undefined,
  readiness: SurfaceReadiness,
) {
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
  return render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider
          value={controllerFor(presentation, readiness)}
        >
          <WindowHostModalHost bypassed={bypassed} />
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

const BOOTSTRAP_MARKERS = {
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

beforeEach(() => {
  hostStatus.data = undefined;
  controllerStatus.data = undefined;
  // `ReportIssueAction` gates on this store, defaulting to `false` - so every
  // fixture that checks Report issue's PRESENCE needs it true first, or the
  // absence would be satisfied by the store gate rather than by
  // `showReportIssue`. Fixtures asserting Report issue's ABSENCE stay
  // meaningful either way, since they are asserting the more restrictive of
  // two independently-sufficient gates.
  useDesktopDialogStore.getState().setReportIssueAvailable(true);
  // SIGNED IN, because production is: this component is mounted only for a
  // signed-in user (`useWindowNarration`'s latch doc leans on exactly that -
  // signing out unmounts it). It matters now that the narrator picks its
  // presentation from `gateBlocksApp`, whose first clause is `signedIn` - a
  // signed-out harness reports "the gate is not blocking", i.e. models a
  // window with a mounted app behind it, which is the opposite of the launch
  // every cold-start fixture below is describing.
  //
  // Only `status` is set: it is the sole field this tree reads, and the
  // store's profile invariant is about surfaces none of these fixtures mount.
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
  useDesktopDialogStore.getState().setReportIssueAvailable(false);
  useAuthStore.setState({ status: "signed-out" });
});

describe("<WindowHostModalHost />", () => {
  it("∅ (no-usable-host): settled failure — Retry, Report issue and Open settings(button) present; spinner + progress heading absent; attempt panel + log toggle present", async () => {
    // Previously asserted `local-host-loading-spinner` truthy on this arm -
    // THAT was the reported defect (B4): a live "starting" spinner drawn over
    // a state where nothing is starting, with Retry and Report issue beside
    // it as if a real attempt were in flight. Kept only as the negative
    // assertion below, with a comment recording why, so nobody restores it.
    hostStatus.data = BOOTSTRAP_MARKERS;
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
      },
      false,
      // A real CLI, not the no-CLI default: `local-host-loading-toggle-details`
      // structurally cannot render without one (see
      // `local-host-loading.test.tsx`'s own positive/negative control pair),
      // so proving it PRESENT needs the positive shell.
      new MockTraycerCli(),
    );

    // Existence before absence: a modal that failed to render at all would
    // also satisfy every "absent" assertion below, and that exact shape has
    // already bitten this branch three times.
    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-cause"),
    ).toBe("no-usable-host");
    const openSettings = screen.getByTestId("window-host-modal-open-settings");
    expect(openSettings).toBeTruthy();

    // Nothing is starting, so nothing narrates a start.
    expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();
    expect(screen.queryByText("Starting Traycer…")).toBeNull();

    // The attempt panel is what explains this state, and it is present...
    expect(
      screen.getByTestId("local-host-bootstrap-log-path").textContent,
    ).toBe("/Users/me/.traycer/bootstrap.log");
    expect(screen.getByTestId("local-host-bootstrap-details")).toBeTruthy();
    // ...and the log disclosure toggle survives onto this arm - it is the one
    // way to take a stuck startup elsewhere, and it is TRUE here.
    expect(
      screen.getByTestId("local-host-loading-toggle-details"),
    ).toBeTruthy();

    // This IS the settled failure: Retry, Report issue, and Open settings as
    // an equal-weight button, all present.
    expect(screen.getByTestId("window-host-modal-retry")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
    expect(openSettings.getAttribute("data-emphasis")).toBe("button");
  });

  it("a REMOTE-only fleet: no local bootstrap body, no bootstrap log path", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: REMOTE_HOST_ID,
      leases: [deadLease(REMOTE_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
      },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();
    expect(screen.queryByTestId("local-host-bootstrap-log-path")).toBeNull();
  });

  it("cold-start on a REMOTE target draws the SAME boot body as a local one: headline, spinner, inline Open settings, no action row", async () => {
    // THE REPORTED LAUNCH. A fresh install on an account that has remote hosts
    // derives a remote as effective until the local host registers (the
    // engine's third arm: no preference, no local row, first usable remote), so
    // for that whole window the target is REMOTE, its lease is `connecting`,
    // nothing has failed and nothing is slow. This arm used to withhold the
    // boot body for any non-local target and let the action row carry the
    // settings link on its own - which rendered as a card containing nothing
    // but "Open settings". Now the body is drawn whatever the target's kind:
    // same headline, same footer pair, same card as the two boot surfaces
    // before it.
    applySnapshot({
      attached: true,
      effectiveHostId: REMOTE_HOST_ID,
      targetHostId: REMOTE_HOST_ID,
      leases: [
        lease({ hostId: REMOTE_HOST_ID, status: "connecting", dead: null }),
      ],
    });

    renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
      },
      false,
      new MockTraycerCli(),
      GATE_BLOCKING,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    const card = screen.getByTestId("window-host-startup-card");
    expect(card.getAttribute("data-cause")).toBe("cold-start");
    // Drawn THROUGH the shared boot card, not merely resembling it.
    expect(card.getAttribute("data-surface")).toBe(HOST_BOOT_CARD_SURFACE);

    // The boot body: spinner + the family's idle heading (no lane is running,
    // and no machine has been named that a lane could describe).
    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
    expect(screen.getByTestId("local-host-loading-stage").textContent).toBe(
      "Starting Traycer…",
    );
    // The footer pair, exactly as the two surfaces before this one draw it:
    // `Show details` with `Open settings` INLINE beside it ...
    expect(
      screen.getByTestId("local-host-loading-toggle-details"),
    ).toBeTruthy();
    expect(screen.getByTestId("host-boot-open-settings").textContent).toContain(
      "Open settings",
    );
    // ... and NO action row of the card's own: nothing failed, nothing to
    // retry, so an equal-weight row would be the "something is wrong, pick
    // one" signal on a start that is fine.
    expect(screen.queryByTestId("window-host-modal-open-settings")).toBeNull();
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
    // And no title/description: the headline is the one line.
    expect(screen.queryByTestId("window-host-startup-card-title")).toBeNull();
    expect(
      screen.queryByTestId("window-host-startup-card-description"),
    ).toBeNull();
  });

  it("cold-start on a REMOTE target while this machine's lane runs: the lane heading in the boot headline and the bar, never the boxed lane line", async () => {
    // The second shape of the same launch: the desktop's reconciler is
    // installing the local host underneath while the derived target is still
    // the remote. The lane is real and it is this machine's, so the boot body
    // narrates it the way every other phase would - headline + progress bar -
    // instead of the bordered `LaneProgressLine` strip that titled faces use
    // under their own description. That strip under NO title was the
    // "weird-looking Setting up Traycer" card.
    controllerStatus.data = {
      mutation: {
        kind: "ensure",
        progress: null,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    applySnapshot({
      attached: true,
      effectiveHostId: REMOTE_HOST_ID,
      targetHostId: REMOTE_HOST_ID,
      leases: [
        lease({ hostId: REMOTE_HOST_ID, status: "connecting", dead: null }),
      ],
    });

    renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
      },
      false,
      undefined,
      GATE_BLOCKING,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    expect(screen.getByTestId("local-host-loading-stage").textContent).toBe(
      "Setting up Traycer Host…",
    );
    expect(screen.getByTestId("local-host-download-progress")).toBeTruthy();
    expect(screen.queryByTestId("window-host-modal-progress")).toBeNull();
    // Still the healthy footer, still no action row.
    expect(screen.getByTestId("host-boot-open-settings")).toBeTruthy();
    expect(screen.queryByTestId("window-host-modal-open-settings")).toBeNull();
  });

  it("∅ on a REMOTE-only fleet keeps this machine's diagnostics OFF the card: the settled arm is the one place the target still gates", async () => {
    // The counterweight to the two fixtures above. The healthy body lost its
    // target gate; the SETTLED body did not, and must not - an attempt panel
    // about a local install under "No host is available" on a fleet this
    // machine is not part of blames the wrong computer. Title + description +
    // actions are that arm's whole story.
    hostStatus.data = BOOTSTRAP_MARKERS;
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: REMOTE_HOST_ID,
      leases: [deadLease(REMOTE_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
      },
      false,
      new MockTraycerCli(),
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();
    expect(screen.queryByTestId("local-host-bootstrap-log-path")).toBeNull();
    expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();
    expect(
      screen.queryByTestId("local-host-loading-toggle-details"),
    ).toBeNull();
    expect(screen.getByTestId("window-host-modal-open-settings")).toBeTruthy();
  });

  it("cold-start, healthy (stage: loading, no provisioningError): Retry, Report issue absent; Open settings present as a link; spinner shown; no attempt summary", async () => {
    // The markers MUST be available for this assertion to mean anything. The
    // first version of this test left the status query empty, so the summary
    // was absent because there was nothing to summarise - it passed with the
    // cause guard deleted, and a kill probe is what caught it. Supplying
    // markers makes the guard the only reason the summary stays away.
    hostStatus.data = BOOTSTRAP_MARKERS;
    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        lease({ hostId: LOCAL_HOST_ID, status: "connecting", dead: null }),
      ],
    });

    renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
      },
      false,
      undefined,
      GATE_BLOCKING,
    );

    // A LAUNCH renders the card, not the dialog - there is no app behind it
    // to trap pointers over, and trapping them is what made every toast dead
    // for the whole of setup.
    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-startup-card").getAttribute("data-cause"),
    ).toBe("cold-start");
    // `Open settings` lives INLINE on the footer row beside `Show details`
    // here, not in an action row of its own - the same pair, in the same
    // place, as the two boot surfaces that precede this one. A row of its own
    // is what made the healthy card a four-line column of stray links.
    const openSettings = screen.getByTestId("host-boot-open-settings");
    expect(openSettings).toBeTruthy();
    expect(screen.queryByTestId("window-host-modal-open-settings")).toBeNull();

    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();

    // This is the reported defect's own state: a start with no failure of any
    // kind. Retry and Report issue must both be absent.
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    // ONE VOICE FOR THE EVENT. The card draws no title or description on a
    // healthy start, so the lane's own heading is the only line - the
    // "Setting up Traycer" / "Setting up Traycer Host…" / "Setting up…"
    // stack the user reported is structurally unbuildable here.
    expect(screen.queryByTestId("window-host-startup-card-title")).toBeNull();
    expect(
      screen.queryByTestId("window-host-startup-card-description"),
    ).toBeNull();

    // And the escape hatch survives the quiet: `AppHeader variant="host-loading"`
    // has `navDisabled`, so this link is the ONLY route to Settings on screen.
    // Dropping it for a tidier card is a lockout, not a simplification.
    expect(openSettings.textContent).toContain("Open settings");
  });

  it("cold-start, slow (stage: slow): Retry present, Report issue absent, Open settings present as a button", async () => {
    // The row most likely to get this wrong later: Retry and Report issue sit
    // adjacent in the same row and share the same underlying state, so it is
    // easy for a change that means to unlock Retry to unlock both.
    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        lease({ hostId: LOCAL_HOST_ID, status: "connecting", dead: null }),
      ],
    });

    renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
        stage: "slow",
      },
      false,
      undefined,
      GATE_BLOCKING,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-startup-card").getAttribute("data-cause"),
    ).toBe("cold-start");
    const openSettings = screen.getByTestId("window-host-modal-open-settings");
    expect(openSettings).toBeTruthy();

    // Slow promotes Retry (nothing has FAILED, but the wait has outrun the
    // healthy band) without promoting Report issue - there is still no
    // failure for a report to describe.
    expect(screen.getByTestId("window-host-modal-retry")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
    expect(openSettings.getAttribute("data-emphasis")).toBe("button");
  });

  it("cold-start, settled failure (provisioningError set): Retry, Report issue and Open settings(button) present; spinner + stage line absent; attempt panel + log toggle present", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        lease({ hostId: LOCAL_HOST_ID, status: "connecting", dead: null }),
      ],
    });

    // The markers must be AVAILABLE for the body assertions below to mean
    // anything - the attempt panel is what replaces the spinner here, and
    // without markers it renders nothing and "no spinner" would be satisfied by
    // an empty body.
    hostStatus.data = BOOTSTRAP_MARKERS;

    renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
        provisioningError: new Error("bootstrap exited 1"),
      },
      false,
      new MockTraycerCli(),
      GATE_BLOCKING,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-startup-card").getAttribute("data-cause"),
    ).toBe("cold-start");
    const openSettings = screen.getByTestId("window-host-modal-open-settings");
    expect(openSettings).toBeTruthy();
    // A SETTLED failure gets its heading back - a crash report under no title
    // reads as debris. This is the one cold-start face that is titled.
    expect(
      screen.getByTestId("window-host-startup-card-title").textContent,
    ).toContain("Traycer Host didn't start");

    expect(screen.getByTestId("window-host-modal-retry")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
    expect(openSettings.getAttribute("data-emphasis")).toBe("button");

    // THE BODY, which this test used to say nothing about - and that silence was
    // worse than an omission. The row was enumerated, so it read as covered,
    // while the arm it covers went on drawing a live spinner and "Starting local
    // Traycer Host…" beside the Retry and Report issue asserted above. The ∅
    // test has had this negative assertion all along; the arm that was actually
    // broken did not.
    //
    // Positive first: the attempt panel is what this arm draws INSTEAD of the
    // spinner, so its presence is what makes the absences below meaningful
    // rather than vacuous.
    expect(screen.getByTestId("local-host-bootstrap-details")).toBeTruthy();
    expect(
      screen.getByTestId("local-host-loading-toggle-details"),
    ).toBeTruthy();

    expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();
    expect(screen.queryByTestId("local-host-loading-stage")).toBeNull();
    // The copy itself, not just the node: the stage line's fallback is the exact
    // sentence this arm must not say, and asserting the testid alone would pass
    // if the same string were reintroduced anywhere else in the card.
    expect(document.body.textContent).not.toContain("Starting Traycer…");
  });

  it("bypassed: true renders nothing at all", () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      { ...EMPTY_PRESENTATION, targetKind: "local", localBootIntent: true },
      true,
      undefined,
    );

    expect(screen.queryByTestId("window-host-modal")).toBeNull();
  });

  it("a plan-restricted fleet: no retry button", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: null,
      leases: [
        deadLease("host-a", { reason: "plan-restricted" }),
        deadLease("host-b", { reason: "plan-restricted" }),
      ],
    });

    renderHost(EMPTY_PRESENTATION, false, undefined);

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-variant"),
    ).toBe("plan-restricted");
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
  });

  it("closes by re-derivation: a later snapshot naming a ready effective host makes the modal disappear with no user interaction", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      { ...EMPTY_PRESENTATION, targetKind: "local", localBootIntent: true },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });

    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      preferredHostId: LOCAL_HOST_ID,
      leases: [lease({ hostId: LOCAL_HOST_ID, status: "ready", dead: null })],
      selectionRevision: 2,
    });

    await waitFor(() => {
      expect(screen.queryByTestId("window-host-modal")).toBeNull();
    });
  });

  it("stays gone after the host has served once, even when its lease goes back to connecting", async () => {
    // THE SERVED LATCH's own job, which the recovery test above cannot reach:
    // there, a ready lease keeps the modal away whether or not the latch
    // exists. Only a host that served and then stopped being ready
    // distinguishes them - and re-opening a window-wide modal there would be
    // the layered narration this epic deletes, because a host that goes quiet
    // after the app is working is the TILE's story, not the window's.
    // Asserted through `narratorSurface()`: the subject is the LATCH, so this
    // fixture must not care which presentation the narrator picked. The gate
    // state is held BLOCKING throughout because this harness's readiness is
    // static - in production it would open once the host served, and the
    // narrator would move from the card to the dialog with the latch
    // behaviour below unchanged.
    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [lease({ status: "connecting", dead: null })],
    });
    renderHostWithGate(
      { ...EMPTY_PRESENTATION, targetKind: "local", localBootIntent: true },
      false,
      undefined,
      GATE_BLOCKING,
    );
    await waitFor(() => {
      expect(narratorSurface()).toBeTruthy();
    });

    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [lease({ status: "ready", dead: null })],
      selectionRevision: 2,
    });
    await waitFor(() => {
      expect(narratorSurface()).toBeNull();
    });

    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [lease({ status: "connecting", dead: null })],
      selectionRevision: 3,
    });
    await waitFor(() => {
      expect(narratorSurface()).toBeNull();
    });

    // ...but ∅ still re-opens it. The latch silences the cold-start arm, not
    // the no-usable-host arm; conflating the two would strand a window whose
    // fleet died after it had been working.
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
      selectionRevision: 4,
    });
    await waitFor(() => {
      expect(narratorSurface()).toBeTruthy();
    });
  });

  it("narrates a NON-ensure mutation lane: the modal reads the lane's own kind", async () => {
    // Actor- AND kind-agnostic. Filtering the lane to `ensure` is the shape the
    // legacy install card used, and it is why a restart or an update running
    // under a window that nothing can serve rendered a silent card.
    controllerStatus.data = {
      mutation: {
        kind: "respawn",
        progress: null,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: REMOTE_HOST_ID,
      leases: [deadLease(REMOTE_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      { ...EMPTY_PRESENTATION, targetKind: "remote" },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal-progress").textContent,
    ).toContain("Restarting Traycer Host…");
  });

  it("update-host: offers Update host when the HOST is the outdated leg", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        deadLease(LOCAL_HOST_ID, {
          reason: "incompatible",
          detail: {
            code: "protocol-major-behind",
            hostVersion: "1.0.0",
            minSupportedVersion: "1.5.0",
            clientCompatibility: null,
          },
        }),
      ],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
      },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-variant"),
    ).toBe("update-host");
    expect(screen.getByTestId("window-host-modal-update-host")).toBeTruthy();
  });

  it("arm 3: a non-target incompatible host is named, and no local action is offered for it", async () => {
    // `deriveNoHostVariant` arm 3 - "some OTHER lease is dead because it is
    // incompatible", reached when the target is dead for an unrelated reason.
    // Arm 1 (target IS the incompatible host) is what the two tests around this
    // one cover, and on that arm the named host and the acted-on host are the
    // same machine, which is why `canManageHost` reads as a sufficient guard.
    // It is not: it asks "is the TARGET this machine", while the card names
    // whichever host is incompatible. Here those differ.
    const forceProvisioning = vi.fn();
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        // Target: this machine, dead but NOT incompatible - so arm 1 misses.
        deadLease(LOCAL_HOST_ID, { reason: "offline" }),
        // A different machine, and the incompatible one. Its version is what
        // the card will quote, which is how the assertions below tell which
        // lease the narration is about.
        deadLease(REMOTE_HOST_ID, {
          reason: "incompatible",
          detail: {
            code: "protocol-major-behind",
            hostVersion: "0.9.0",
            minSupportedVersion: "1.5.0",
            clientCompatibility: null,
          },
        }),
      ],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        // `canManageHost` is TRUE here, and legitimately so: the target is this
        // machine. That is exactly what makes the guard insufficient - it is
        // satisfied by a fact about the target while the card is about a
        // different host.
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
        forceProvisioning,
      },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });

    // Premise, positively: the narration really is arm 3 - `update-host`, and
    // quoting the REMOTE lease's version rather than the target's. Without
    // this the assertion below could pass on an arm-1 render.
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-variant"),
    ).toBe("update-host");
    expect(screen.getByTestId("window-host-modal").textContent).toContain(
      "0.9.0",
    );

    // Fixed: no button, because this machine's provisioning cannot fix that
    // machine's host. Asserted alongside a POSITIVE consequence - the card
    // still names the incompatible host and now explains the absence - so this
    // cannot pass on a build where the whole modal failed to render.
    expect(screen.queryByTestId("window-host-modal-update-host")).toBeNull();
    expect(
      screen.getByTestId("window-host-modal-description").textContent,
    ).toContain("can't be updated from here");
    expect(forceProvisioning).not.toHaveBeenCalled();
  });

  it("update-host: WITHHOLDS Update host when THIS APP is the outdated leg", async () => {
    // Updating the host cannot fix an outdated client, so offering it is an
    // action that could only fail. Same fleet, same variant, opposite skew -
    // the host version is now AHEAD of this app's pinned 1.5.0.
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        deadLease(LOCAL_HOST_ID, {
          reason: "incompatible",
          detail: {
            code: "protocol-major-ahead",
            hostVersion: "2.0.0",
            minSupportedVersion: "2.0.0",
            clientCompatibility: null,
          },
        }),
      ],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
      },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(screen.queryByTestId("window-host-modal-update-host")).toBeNull();
  });

  /**
   * F8's two STRUCTURAL claims, which is all of it jsdom can answer.
   *
   * The finding has a third, geometric half - the toggle centring itself in an
   * otherwise left-aligned card - and no assertion in this file touches it.
   * `self-center` is a resolved box position, and jsdom computes no layout at
   * all, so the only jsdom-visible form of that claim is "the class string does
   * not contain `self-center`", which pins the fix's SPELLING and would pass
   * happily on a build that re-centred the control by any other means. It is
   * measured in a real engine instead, by
   * `scripts/window-host-modal-alignment-browser.mjs`, and recorded as
   * browser-verified-only rather than left reading as covered here.
   *
   * TWO LIMITS OF THAT HARNESS, stated here because this is where a reader comes
   * looking for coverage:
   *
   *  1. It renders the COLD-START body only. Its existence check requires the
   *     spinner, the stage line, the lane detail and the progress bar - four
   *     members the ∅ body does not render - so pointing it at that arm makes it
   *     FAIL rather than measure. The ∅ arm has no rendered alignment
   *     measurement at all; the assertions below are its only coverage.
   *  2. It cannot distinguish the shipped fix from `self-start` +
   *     `justify-center`, which renders at the same left edge. Its own `PC4`
   *     asserts that blindness as a truth table rather than admitting it in
   *     prose, and the grep-style class guard is what actually pins it -
   *     `src/__tests__/local-bootstrap-alignment-lint.test.ts`, where that exact
   *     combination is one of the mutation proofs.
   *
   * WHY THE ∅ ARM HAS NO RENDERED MEASUREMENT, and what would make it need one.
   *
   * Deferred, not forgotten, and the argument is CONDITIONAL - which is the only
   * reason a deferral is a decision rather than a gap. Both arms now route through
   * the same `LocalHostBodyShell`, so alignment is shared BY CONSTRUCTION:
   * measuring the cold-start arm measures the shell, and the ∅ arm uses that
   * shell. A rendered ∅ measurement would be re-verifying one owner through a
   * second door, and building it faithfully needs the readiness controller mounted
   * in a browser fixture - approximating it would measure the fixture.
   *
   * ⚠ THE CONSTRUCTION ARGUMENT DIES the moment anyone gives the ∅ arm alignment
   * of its own - a second root, or centring on one of its children. At that point
   * the shared-owner reasoning no longer holds and the rendered measurement
   * becomes required. What the shell does NOT cover either way is a CHILD carrying
   * its own centring, which is precisely the `text-center` that survived on
   * `local-host-loading-empty-tail` in the one branch nothing measured; the class
   * guard covers its recurrence.
   */
  describe("the local-bootstrap body's structure", () => {
    it("gives BOTH local arms one body root, so alignment has an owner", async () => {
      // The defect class: both bodies were fragments, so their children became
      // direct children of the dialog's own column and each one carried its own
      // alignment or none. Asserted per arm because the two arms are built by
      // different branches of `buildBootBody` - fixing one and
      // leaving the other is exactly how they drift.
      hostStatus.data = BOOTSTRAP_MARKERS;
      applySnapshot({
        attached: true,
        effectiveHostId: LOCAL_HOST_ID,
        targetHostId: LOCAL_HOST_ID,
        leases: [
          lease({ hostId: LOCAL_HOST_ID, status: "connecting", dead: null }),
        ],
      });
      renderHostWithGate(
        { ...EMPTY_PRESENTATION, targetKind: "local", localBootIntent: true },
        false,
        new MockTraycerCli(),
        GATE_BLOCKING,
      );

      await waitFor(() => {
        expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
      });
      expect(
        screen
          .getByTestId("window-host-startup-card")
          .getAttribute("data-cause"),
      ).toBe("cold-start");

      // ONE root, not one per child: two roots would re-create the same defect
      // with the members regrouped.
      expect(screen.getAllByTestId("local-host-body")).toHaveLength(1);
      const coldStartBody = screen.getByTestId("local-host-body");
      // The root actually CONTAINS the body's members. Without this the
      // assertion above is satisfied by an empty div rendered beside them.
      expect(
        screen
          .getByTestId("local-host-loading-spinner")
          .closest('[data-testid="local-host-body"]'),
      ).toBe(coldStartBody);
      expect(
        screen
          .getByTestId("local-host-loading-toggle-details")
          .closest('[data-testid="local-host-body"]'),
      ).toBe(coldStartBody);

      cleanup();
      useSelectionAuthorityStore.getState().reset();

      // The ∅ arm, whose body is a different branch with different members.
      applySnapshot({
        attached: true,
        effectiveHostId: null,
        targetHostId: LOCAL_HOST_ID,
        leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
      });
      renderHost(
        {
          ...EMPTY_PRESENTATION,
          targetKind: "local",
          localBootIntent: true,
          canManageHost: true,
        },
        false,
        new MockTraycerCli(),
      );

      await waitFor(() => {
        expect(screen.getByTestId("window-host-modal")).toBeTruthy();
      });
      expect(
        screen.getByTestId("window-host-modal").getAttribute("data-cause"),
      ).toBe("no-usable-host");
      expect(screen.getAllByTestId("local-host-body")).toHaveLength(1);
      const emptyArmBody = screen.getByTestId("local-host-body");
      expect(
        screen
          .getByTestId("local-host-bootstrap-details")
          .closest('[data-testid="local-host-body"]'),
      ).toBe(emptyArmBody);
      expect(
        screen
          .getByTestId("local-host-loading-toggle-details")
          .closest('[data-testid="local-host-body"]'),
      ).toBe(emptyArmBody);
    });

    it("puts the ∅ arm's attempt panel ABOVE the log toggle, not below it", async () => {
      // Document order, deliberately anchored on the MODAL rather than on the
      // body root: this claim predates the root, so expressing it this way is
      // what lets it be controlled against the tree that actually had the
      // defect. Below the toggle, the panel reads as the toggle's own expanded
      // content - an open dropdown the user never opened.
      hostStatus.data = BOOTSTRAP_MARKERS;
      applySnapshot({
        attached: true,
        effectiveHostId: null,
        targetHostId: LOCAL_HOST_ID,
        leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
      });
      renderHost(
        {
          ...EMPTY_PRESENTATION,
          targetKind: "local",
          localBootIntent: true,
          canManageHost: true,
        },
        false,
        new MockTraycerCli(),
      );

      await waitFor(() => {
        expect(screen.getByTestId("window-host-modal")).toBeTruthy();
      });
      const panel = screen.getByTestId("local-host-bootstrap-details");
      const toggle = screen.getByTestId("local-host-loading-toggle-details");
      // Both present first: an ordering assertion over a missing node is the
      // vacuity this branch keeps catching.
      expect(panel).toBeTruthy();
      expect(toggle).toBeTruthy();
      expect(
        panel.compareDocumentPosition(toggle) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeGreaterThan(0);
    });
  });
});
