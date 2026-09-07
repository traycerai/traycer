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
import { setMobileApp } from "@/lib/mobile-app";

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

/** The host controller's mutation lane, which is where all provisioning narration comes from - never this
 * renderer's own mutation observer. */
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

// Pinned so the version-skew direction under test is a property of the fixture, not of whatever version this
// build happens to carry.
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

/** `ready` makes `gateBlocksApp` false, which is what selects the narrator's dialog presentation - the blocking
 * form, correct only when there is a live app the ∅ verdict has to stop the user driving. */
const GATE_OPEN: SurfaceReadiness = { kind: "ready" };

/** The gate is blocking: a launch, with no app behind the narrator yet. */
const GATE_BLOCKING: SurfaceReadiness = { kind: "loading-host" };

/** For fixtures whose subject is whether the narrator speaks - the served latch, the ∅ re-open - rather than
 * which form it takes. */
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
  // `undefined` preserves the prior no-CLI shell for every existing fixture; only the fixtures that specifically
  // assert the bootstrap-log toggle pass a real one.
  traycerCli: ITraycerCli | null | undefined,
) {
  return renderHostWithGate(presentation, bypassed, traycerCli, GATE_OPEN);
}

/** `renderHost` with the gate state stated explicitly. Used by the cold-start fixtures, which are describing a
 * launch and therefore need the blocking gate (see GATE_BLOCKING). */
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
  // `ReportIssueAction` gates on this store, defaulting to `false`.
  useDesktopDialogStore.getState().setReportIssueAvailable(true);
  // Signed IN, because production is: this component is mounted only for a signed-in user
  // (`useWindowNarration`'s latch doc leans on exactly that - signing out unmounts it).
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
  useDesktopDialogStore.getState().setReportIssueAvailable(false);
  useAuthStore.setState({ status: "signed-out" });
  setMobileApp(false);
});

describe("<WindowHostModalHost />", () => {
  it("∅ (no-usable-host): settled failure — Retry, Report issue and Open settings(button) present; spinner + progress heading absent; attempt panel + log toggle present", async () => {
    // Kept only as the negative assertion below, with a comment recording why, so nobody restores it.
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
      // A real CLI, not the no-CLI default: `local-host-loading-toggle-details` structurally cannot render without
      // one (see `local-host-loading.test.tsx`'s own positive/negative control pair).
      new MockTraycerCli(),
    );

    // Existence before absence: a modal that failed to render at all would also satisfy every "absent" assertion
    // below, and that exact shape has already bitten this branch three times.
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
    // Now the body is drawn whatever the target's kind: same headline, same footer pair, same card as the two boot
    // surfaces before it.
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
    // Drawn through the shared boot card, not merely resembling it.
    expect(card.getAttribute("data-surface")).toBe(HOST_BOOT_CARD_SURFACE);

    // The boot body: spinner + the family's idle heading (no lane is running,
    // and no machine has been named that a lane could describe).
    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
    expect(screen.getByTestId("local-host-loading-stage").textContent).toBe(
      "Starting Traycer…",
    );
    // The footer pair, exactly as the two surfaces before this one draw it: `Show details` with `Open settings`
    // inline beside it...
    expect(
      screen.getByTestId("local-host-loading-toggle-details"),
    ).toBeTruthy();
    expect(screen.getByTestId("host-boot-open-settings").textContent).toContain(
      "Open settings",
    );
    // and NO action row of the card's own: nothing failed, nothing to retry, so an equal-weight row would be the
    // "something is wrong, pick one" signal on a start that is fine.
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
    // The lane is real and it is this machine's, so the boot body narrates it the way every other phase would -
    // headline + progress bar.
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
    // The healthy body lost its target gate; the settled body did not, and must not - an attempt panel about a
    // local install under "No host is available" on a fleet this machine is not part of blames the wrong computer.
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
    // The markers must be available for this assertion to mean anything. Supplying markers makes the guard the
    // only reason the summary stays away.
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

    // A launch renders the card, not the dialog - there is no app behind it to trap pointers over, and trapping
    // them is what made every toast dead for the whole of setup.
    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-startup-card").getAttribute("data-cause"),
    ).toBe("cold-start");
    // `Open settings` lives inline on the footer row beside `Show details` here, not in an action row of its own -
    // the same pair, in the same place, as the two boot surfaces that precede this one.
    const openSettings = screen.getByTestId("host-boot-open-settings");
    expect(openSettings).toBeTruthy();
    expect(screen.queryByTestId("window-host-modal-open-settings")).toBeNull();

    expect(screen.getByTestId("local-host-loading-spinner")).toBeTruthy();
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();

    // This is the reported defect's own state: a start with no failure of any
    // kind. Retry and Report issue must both be absent.
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    // The card draws no title or description on a healthy start, so the lane's own heading is the only line.
    expect(screen.queryByTestId("window-host-startup-card-title")).toBeNull();
    expect(
      screen.queryByTestId("window-host-startup-card-description"),
    ).toBeNull();

    // And the escape hatch survives the quiet: `AppHeader variant="host-loading"` has `navDisabled`, so this link
    // is the only route to Settings on screen. Dropping it for a tidier card is a lockout, not a simplification.
    expect(openSettings.textContent).toContain("Open settings");
  });

  it("cold-start, slow (stage: slow): Retry present, Report issue absent, Open settings present as a button", async () => {
    // The row most likely to get this wrong later: Retry and Report issue sit adjacent in the same row and share
    // the same underlying state, so it is easy for a change that means to unlock Retry to unlock both.
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

    // Slow promotes Retry (nothing has failed, but the wait has outrun the healthy band) without promoting Report
    // issue - there is still no failure for a report to describe.
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

    // The markers must be available for the body assertions below to mean anything.
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
    // A settled failure gets its heading back - a crash report under no title reads as debris. This is the one
    // cold-start face that is titled.
    expect(
      screen.getByTestId("window-host-startup-card-title").textContent,
    ).toContain("Traycer Host didn't start");

    expect(screen.getByTestId("window-host-modal-retry")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
    expect(openSettings.getAttribute("data-emphasis")).toBe("button");

    // Positive first: the attempt panel is what this arm draws instead of the spinner, so its presence is what
    // makes the absences below meaningful rather than vacuous.
    expect(screen.getByTestId("local-host-bootstrap-details")).toBeTruthy();
    expect(
      screen.getByTestId("local-host-loading-toggle-details"),
    ).toBeTruthy();

    expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();
    expect(screen.queryByTestId("local-host-loading-stage")).toBeNull();
    // The copy itself, not just the node: the stage line's fallback is the exact sentence this arm must not say,
    // and asserting the testid alone would pass if the same string were reintroduced anywhere else in the card.
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
    // Asserted through `narratorSurface`: the subject is the latch, so this fixture must not care which
    // presentation the narrator picked.
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

    // The latch silences the cold-start arm, not the no-usable-host arm; conflating the two would strand a window
    // whose fleet died after it had been working.
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
    // Actor- and kind-agnostic.
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
    // `deriveNoHostVariant` arm 3 - "some other lease is dead because it is incompatible", reached when the target
    // is dead for an unrelated reason.
    const forceProvisioning = vi.fn();
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        // Target: this machine, dead but NOT incompatible - so arm 1 misses.
        deadLease(LOCAL_HOST_ID, { reason: "offline" }),
        // A different machine, and the incompatible one.
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
        // That is exactly what makes the guard insufficient - it is satisfied by a fact about the target while the
        // card is about a different host.
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

    // Premise, positively: the narration really is arm 3 - `update-host`, and quoting the remote lease's version
    // rather than the target's. Without this the assertion below could pass on an arm-1 render.
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-variant"),
    ).toBe("update-host");
    expect(screen.getByTestId("window-host-modal").textContent).toContain(
      "0.9.0",
    );

    // Fixed: no button, because this machine's provisioning cannot fix that machine's host.
    expect(screen.queryByTestId("window-host-modal-update-host")).toBeNull();
    expect(
      screen.getByTestId("window-host-modal-description").textContent,
    ).toContain("can't be updated from here");
    expect(forceProvisioning).not.toHaveBeenCalled();
  });

  it("update-host: WITHHOLDS Update host when THIS APP is the outdated leg", async () => {
    // Updating the host cannot fix an outdated client, so offering it is an action that could only fail.
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

  /** `self-center` is a resolved box position, and jsdom computes no layout at all, so the only jsdom-visible
   * form of that claim is "the class string does not contain `self-center`". */
  describe("the local-bootstrap body's structure", () => {
    it("gives BOTH local arms one body root, so alignment has an owner", async () => {
      // Asserted per arm because the two arms are built by different branches of `buildBootBody` - fixing one and
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
      // The root actually contains the body's members. Without this the assertion above is satisfied by an empty div
      // rendered beside them.
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
      // Document order, deliberately anchored on the modal rather than on the body root: this claim predates the
      // root, so expressing it this way is what lets it be controlled against the tree that actually had the defect.
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

  /** The gesture is the phone's only history affordance, so the narration must not cost it. */
  describe("on the mobile app", () => {
    beforeEach(() => {
      setMobileApp(true);
    });

    function applyPostLatchEmptyFleet(): void {
      applySnapshot({
        attached: true,
        effectiveHostId: null,
        targetHostId: REMOTE_HOST_ID,
        leases: [deadLease(REMOTE_HOST_ID, { reason: "offline" })],
      });
    }

    it("post-latch ∅ narrates through the non-modal card, and raises no document barrier", async () => {
      applyPostLatchEmptyFleet();

      renderHost(
        { ...EMPTY_PRESENTATION, targetKind: "remote" },
        false,
        undefined,
      );

      // Existence before absence: a narrator that rendered nothing at all would
      // satisfy both negative assertions below.
      await waitFor(() => {
        expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
      });
      expect(
        screen
          .getByTestId("window-host-startup-card")
          .getAttribute("data-cause"),
      ).toBe("no-usable-host");
      // The words survive the presentation change - this is still the surface
      // that says a fleet is unreachable, and it still offers the escape hatch.
      expect(
        screen.getByTestId("window-host-modal-open-settings"),
      ).toBeTruthy();

      expect(screen.queryByTestId("window-host-modal")).toBeNull();
      expect(screen.queryByTestId("window-host-modal-overlay")).toBeNull();
      expect(document.body.style.pointerEvents).not.toBe("none");
    });

    // The novelty guard: a narrator that had simply stopped drawing the dialog everywhere would pass the case
    // above just as well as one that forks on the product signal.
    it("leaves the dialog in place on every other shell", async () => {
      setMobileApp(false);
      applyPostLatchEmptyFleet();

      renderHost(
        { ...EMPTY_PRESENTATION, targetKind: "remote" },
        false,
        undefined,
      );

      await waitFor(() => {
        expect(screen.getByTestId("window-host-modal")).toBeTruthy();
      });
      expect(screen.queryByTestId("window-host-startup-card")).toBeNull();
    });
  });
});
