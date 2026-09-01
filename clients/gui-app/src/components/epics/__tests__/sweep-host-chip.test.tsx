import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { EpicSweepWorktreeRow } from "@/hooks/epic/use-epic-sweep-worktree-candidates-query";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { SweepWorktreesFlow } from "@/components/epics/sweep-worktrees-flow";

/**
 * The host as a CONTROL inside the confirmation - the whole of what replaced
 * the standalone "which host?" step.
 *
 * These cases drive the REAL dialog, because every claim here is about the two
 * halves being one surface: the chip names the machine the census in front of
 * it was taken on, switching it re-proves against the other machine's client,
 * and the popover's worktree-count pill is a live question asked of every
 * other selectable host. The flow's own latch and its fallbacks are asserted
 * separately, against a captured dialog, in `sweep-worktrees-flow.test.tsx`.
 *
 * Everything is asserted against the client's HOST ID rather than against
 * copy: "the census moved" means the candidates query ran on the other
 * machine's client, which is the only thing that makes a sweep safe.
 */

interface SweepCensusClient {
  readonly getActiveHostId: () => string | null;
}

interface SweepHostWorktreeCountInput {
  readonly client: SweepCensusClient | null;
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly enabled: boolean;
}

const state = vi.hoisted(() => ({
  connectableHostIds: ["host-a", "host-b"] as readonly string[],
  unresolvableHostIds: [] as readonly string[],
  /** Worktree paths this host would report for the selected Task. */
  pathsByHost: { "host-a": ["/wt/a"], "host-b": ["/wt/b"] } as Record<
    string,
    readonly string[]
  >,
  /** Paths whose sweep is already streaming, from any surface. */
  sweepingPaths: [] as readonly string[],
  refreshing: false,
  /** Rows the classifier could not prove landed — the route to Review. */
  unproven: false,
  /** The directory has said what the fleet is. */
  fleetResolved: true,
  /**
   * What `useSweepHostWorktreeCount` reports for a NON-censused host, keyed
   * by the client's host id. A missing key answers `null`, matching the real
   * hook's "not known" answer.
   */
  countByHost: {} as Record<string, number | null>,
}));

const captured = vi.hoisted<{
  censusHostIds: (string | null)[];
  openChanges: boolean[];
}>(() => ({ censusHostIds: [], openChanges: [] }));

vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({
    hostIds: state.connectableHostIds,
    resolved: state.fleetResolved,
  }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null): SweepCensusClient | null =>
    hostId === null || state.unresolvableHostIds.includes(hostId)
      ? null
      : { getActiveHostId: () => hostId },
}));

vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHostsPollLiveness: () => undefined,
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: hostOptions(),
    activeHostId: "host-a",
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
  }),
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktree-candidates-query", () => ({
  useEpicSweepWorktreeCandidatesForClient: (
    client: SweepCensusClient | null,
    epicIds: ReadonlyArray<string> | null,
  ) => {
    const hostId = client?.getActiveHostId() ?? null;
    captured.censusHostIds.push(hostId);
    const rows =
      epicIds === null || hostId === null
        ? []
        : (state.pathsByHost[hostId] ?? []).map(sweepRow);
    // A refresh/prove that never settles is how "mid-refresh" is held open:
    // the spinner hook stays `refreshing` until this resolves.
    const proveOrRefresh = (): Promise<ReadonlyArray<EpicSweepWorktreeRow>> =>
      state.refreshing
        ? new Promise<ReadonlyArray<EpicSweepWorktreeRow>>(() => undefined)
        : Promise.resolve(rows);
    return {
      hostId,
      rows,
      isPending: false,
      isError: false,
      checkedAt: 1_700_000_000_000,
      canRefresh: true,
      refresh: proveOrRefresh,
      prove: proveOrRefresh,
    };
  },
}));

vi.mock("@/hooks/epic/use-sweep-host-worktree-count-query", () => ({
  useSweepHostWorktreeCount: (
    input: SweepHostWorktreeCountInput,
  ): number | null => {
    if (!input.enabled) return null;
    const hostId = input.client?.getActiveHostId() ?? null;
    if (hostId === null) return null;
    return state.countByHost[hostId] ?? null;
  },
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktrees-mutation", () => ({
  useEpicSweepWorktrees: () => ({ isPending: false, mutate: () => undefined }),
  useSweepingWorktreePaths: () => new Set(state.sweepingPaths),
}));

vi.mock("@/components/settings/panels/use-worktree-task-titles", () => ({
  useWorktreeTaskTitles: () => new Map<string, string>(),
}));

vi.mock("@/lib/worktree/teardown-agent-names", () => ({
  useTeardownAgentNames: () => new Map<string, string>(),
}));

vi.mock("@/components/worktree/worktree-pr-metadata", () => ({
  WorktreePrPills: () => null,
}));

/**
 * Three hosts, covering every row class the popover must draw at once: the one
 * being censused, a dialable one the Task has agents on, and a dead one that
 * must still be LISTED.
 */
function hostOptions(): readonly HostScopeOption[] {
  return [
    hostScopeOptionFixture({
      hostId: "host-a",
      name: "Laptop",
      isLocalMachine: true,
      isActive: true,
    }),
    hostScopeOptionFixture({
      hostId: "host-b",
      name: "Studio",
      isLocalMachine: false,
      isActive: false,
    }),
    hostScopeOptionFixture({
      hostId: "host-c",
      name: "Retired box",
      isLocalMachine: false,
      isActive: false,
      connectable: false,
      health: {
        state: "offline",
        label: "Offline",
        detail: null,
        tone: "idle",
        live: false,
      },
    }),
  ];
}

function sweepRow(worktreePath: string): EpicSweepWorktreeRow {
  const entry: WorktreeHostEntryV14 = {
    worktreePath,
    branch: `branch${worktreePath.replaceAll("/", "-")}`,
    repoLabel: "traycerai/traycer",
    repoIdentifier: { owner: "traycerai", repo: "traycer" },
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    owners: [],
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: true,
    resolvedAt: 1_700_000_000_000,
  };
  if (state.unproven) {
    return {
      entry,
      tier: "review",
      defaultChecked: false,
      disabled: false,
      note: "not-landed",
      holders: [],
      holdersStatus: "none",
      holdersRevision: undefined,
    };
  }
  return {
    entry,
    tier: "at-base-commit",
    defaultChecked: true,
    disabled: false,
    note: null,
    holders: [],
    holdersStatus: "none",
    holdersRevision: undefined,
  };
}

/**
 * Built through a typed factory rather than a cast, matching
 * `landing-placement.test.ts`: the ban on `as any` / `as unknown` applies in
 * tests too.
 */
function clientAddressing(hostId: string): HostClient<HostRpcRegistry> {
  const client: Pick<HostClient<HostRpcRegistry>, "getActiveHostId"> = {
    getActiveHostId: () => hostId,
  };
  return client as HostClient<HostRpcRegistry>;
}

/** The client the surface already speaks on. */
const SURFACE_CLIENT = clientAddressing("host-a");

interface SurfaceHost {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
}

const SURFACE_ON_A: SurfaceHost = { client: SURFACE_CLIENT, hostId: "host-a" };

function renderSweep() {
  return render(sweep(SURFACE_ON_A));
}

/** The same flow with the Sweep shut, so a re-open can be driven. */
function closedSweep() {
  return (
    <SweepWorktreesFlow
      epicIds={null}
      surfaceHostClient={SURFACE_CLIENT}
      surfaceHostId="host-a"
      taskTitle="Ship it"
      onOpenChange={(open) => captured.openChanges.push(open)}
    />
  );
}

function sweep(surface: SurfaceHost) {
  return (
    <SweepWorktreesFlow
      epicIds={["epic-1"]}
      surfaceHostClient={surface.client}
      surfaceHostId={surface.hostId}
      taskTitle="Ship it"
      onOpenChange={(open) => captured.openChanges.push(open)}
    />
  );
}

function openHostPopover(): HTMLElement {
  fireEvent.click(screen.getByTestId("sweep-host-chip"));
  return screen.getByTestId("sweep-host-popover");
}

function lastCensusHostId(): string | null {
  return captured.censusHostIds.at(-1) ?? null;
}

describe("Sweep host chip", () => {
  beforeEach(() => {
    state.connectableHostIds = ["host-a", "host-b"];
    state.unresolvableHostIds = [];
    state.pathsByHost = { "host-a": ["/wt/a"], "host-b": ["/wt/b"] };
    state.sweepingPaths = [];
    state.refreshing = false;
    state.unproven = false;
    state.fleetResolved = true;
    state.countByHost = {};
    captured.censusHostIds = [];
    captured.openChanges = [];
  });
  afterEach(() => {
    cleanup();
  });

  it("renders no host control at all on a single-host fleet", () => {
    state.connectableHostIds = ["host-a"];
    state.pathsByHost = { "host-a": [] };
    renderSweep();

    // The hard requirement: a single-host install sees byte-for-byte the Sweep
    // it had before multi-host Sweep existed - no chip, and the same empty
    // sentence, even though a record names another machine.
    expect(screen.queryByTestId("sweep-host-chip")).toBeNull();
    expect(screen.getByTestId("sweep-worktrees-empty").textContent).toBe(
      "No worktrees on this host for the selected tasks.",
    );
  });

  it("names the host the census in front of it was taken on", () => {
    renderSweep();

    expect(screen.getByTestId("sweep-host-chip").textContent).toContain(
      "on Laptop",
    );
    expect(lastCensusHostId()).toBe("host-a");
  });

  it("lists every host flat, with a worktree-count pill for hosts holding some", () => {
    state.pathsByHost = { "host-a": ["/wt/a"], "host-b": ["/wt/b"] };
    state.countByHost = { "host-b": 3 };
    renderSweep();
    const popover = openHostPopover();

    // Flat: every host is its own row, with no grouping or disclosure between
    // the censused host and the rest of the fleet.
    const rows = within(popover).getAllByRole("button", {
      name: /Laptop|Studio|Retired box/,
    });
    expect(rows).toHaveLength(3);
    expect(
      within(popover).queryByRole("button", { name: /Other hosts/ }),
    ).toBeNull();

    // The censused host's pill comes from the dialog's OWN rows (one row on
    // screen already), never a re-ask of the machine it is already on.
    const laptopRow = within(popover).getByRole("button", { name: /Laptop/ });
    expect(within(laptopRow).getByTestId("sweep-host-count").textContent).toBe(
      "1 worktree",
    );

    // Every other selectable host's pill comes from the count hook, asked
    // live while the popover is open.
    const studioRow = within(popover).getByRole("button", { name: /Studio/ });
    expect(within(studioRow).getByTestId("sweep-host-count").textContent).toBe(
      "3 worktrees",
    );

    // A host with no proven count (here, an inert one nothing can dial) shows
    // no pill at all - never a claimed zero.
    const deadRow = within(popover).getByRole("button", {
      name: /Retired box/,
    });
    expect(within(deadRow).queryByTestId("sweep-host-count")).toBeNull();
  });

  it("re-proves against the picked host's client when the host changes", () => {
    renderSweep();
    expect(screen.getByText("branch-wt-a")).toBeTruthy();

    const popover = openHostPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Studio/ }));

    // The census moved, judged by the client the query ran on - not by what
    // the chip says.
    expect(lastCensusHostId()).toBe("host-b");
    expect(screen.getByTestId("sweep-host-chip").textContent).toContain(
      "on Studio",
    );
    expect(screen.getByText("branch-wt-b")).toBeTruthy();
    expect(screen.queryByText("branch-wt-a")).toBeNull();
  });

  it("asks before a host change discards checks made by hand", () => {
    renderSweep();
    // A hand-made deselection - exactly the state a silent retarget would eat.
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    expect(screen.getByTestId("sweep-worktrees-count").textContent).toContain(
      "0 of 1",
    );

    const popover = openHostPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Studio/ }));

    // Nothing has moved yet: the question is the point.
    expect(
      screen.getByTestId("sweep-host-switch-confirm").textContent,
    ).toContain("Changing hosts clears this selection.");
    expect(lastCensusHostId()).toBe("host-a");

    fireEvent.click(screen.getByTestId("sweep-host-switch-keep"));
    expect(lastCensusHostId()).toBe("host-a");
    expect(screen.getByTestId("sweep-worktrees-count").textContent).toContain(
      "0 of 1",
    );
  });

  it("clears the selection and re-proves once that change is confirmed", () => {
    renderSweep();
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));

    const popover = openHostPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Studio/ }));
    fireEvent.click(screen.getByTestId("sweep-host-switch-confirm-action"));

    expect(lastCensusHostId()).toBe("host-b");
    // The new host's rows are at THEIR default, not carrying host-a's
    // deselection across a machine boundary.
    expect(screen.getByTestId("sweep-worktrees-count").textContent).toContain(
      "1 of 1",
    );
  });

  it("switches nothing, and asks nothing, when the current host's own row is clicked", () => {
    renderSweep();
    // With a hand-made selection on screen, so the no-op has something to
    // threaten: picking the host you are already on is not a host change, and
    // warning that it would clear the list is a lie the popover must not tell.
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    const popover = openHostPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Laptop/ }));

    expect(screen.queryByTestId("sweep-host-switch-confirm")).toBeNull();
    expect(lastCensusHostId()).toBe("host-a");
    expect(screen.getByTestId("sweep-worktrees-count").textContent).toContain(
      "0 of 1",
    );
  });

  it("leaves a host whose client cannot be built inert, and stays put", () => {
    // `connectable` is a directory fact and stays TRUE here: the client fails
    // to build for a reason the route knows nothing about (no request context
    // / no bound user). Without the row asking for itself, the row stays
    // enabled and every click re-enters the same unresolved pick in silence.
    state.unresolvableHostIds = ["host-b"];
    renderSweep();
    const popover = openHostPopover();

    const row = within(popover).getByRole("button", { name: /Studio/ });
    expect(row.hasAttribute("disabled")).toBe(true);
    expect(row.textContent).toContain("unavailable");
    fireEvent.click(row);
    expect(lastCensusHostId()).toBe("host-a");
  });

  it("asks no count query, and shows no pill, for an inert host row", () => {
    // A truthy mocked count is set on purpose: if the row asked for it anyway,
    // the pill would show up. It must not, because the row cannot be picked.
    state.unresolvableHostIds = ["host-b"];
    state.countByHost = { "host-b": 5 };
    renderSweep();
    const popover = openHostPopover();

    const row = within(popover).getByRole("button", { name: /Studio/ });
    expect(within(row).queryByTestId("sweep-host-count")).toBeNull();
  });

  it("puts the chip out of reach while a sweep of these rows is streaming", () => {
    state.sweepingPaths = ["/wt/a"];
    renderSweep();

    // The host is not a live question while this machine is mid-teardown.
    expect(screen.getByTestId("sweep-host-chip").hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("puts the chip out of reach while the census is being re-proved", () => {
    state.refreshing = true;
    renderSweep();
    fireEvent.click(screen.getByTestId("sweep-worktrees-refresh"));

    expect(screen.getByTestId("sweep-host-chip").hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("freezes the host read-only in review, with Back as the only route", async () => {
    state.unproven = true;
    renderSweep();
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));

    // Review is a receipt for ONE machine's proof; there is no control on it
    // that could aim that receipt somewhere else.
    expect(
      (await screen.findByTestId("sweep-review-host")).textContent,
    ).toContain("On Laptop");
    expect(screen.queryByTestId("sweep-host-chip")).toBeNull();
    expect(screen.getByTestId("sweep-worktrees-back")).toBeTruthy();
  });

  it("keeps a reviewed session when the SURFACE's own host fails over", async () => {
    state.unproven = true;
    const view = renderSweep();
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(
      (await screen.findByTestId("sweep-review-host")).textContent,
    ).toContain("On Laptop");

    // History's surface props are the app-wide effective host. Laptop dies,
    // selection fails over to Studio, and the props this dialog was opened
    // with now describe a different machine.
    view.rerender(
      sweep({
        client: clientAddressing("host-b"),
        hostId: "host-b",
      }),
    );

    // Following that would move the dialog's session key, and
    // `applySelectionRetarget` would throw away a proof somebody is part-way
    // through confirming - with no gesture from anybody.
    expect(screen.getByTestId("sweep-review-host").textContent).toContain(
      "On Laptop",
    );
    expect(lastCensusHostId()).toBe("host-a");
  });

  it("says it cannot reach a settled host, rather than that it is clean", () => {
    const view = renderSweep();
    const popover = openHostPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Studio/ }));
    expect(lastCensusHostId()).toBe("host-b");

    // Studio leaves the directory with its census already on screen.
    state.unresolvableHostIds = ["host-b"];
    view.rerender(sweep(SURFACE_ON_A));

    // The dialog holds the host it was pointed at and says what happened. It
    // does NOT slide back to Laptop, and it does not claim Studio is clean -
    // the census never ran.
    expect(
      screen.getByTestId("sweep-worktrees-host-unreachable").textContent,
    ).toContain("Can't reach Studio");
    expect(screen.queryByTestId("sweep-worktrees-empty")).toBeNull();
    expect(screen.getByTestId("sweep-host-chip").textContent).toContain(
      "on Studio",
    );
  });

  it("refuses a HELD confirmation once another surface starts sweeping these rows", () => {
    const view = renderSweep();
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    const popover = openHostPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Studio/ }));
    expect(screen.getByTestId("sweep-host-switch-confirm")).toBeTruthy();

    // The question was admitted when switching was allowed and then SAT there.
    // Another surface begins sweeping one of these rows underneath it.
    state.sweepingPaths = ["/wt/a"];
    view.rerender(sweep(SURFACE_ON_A));

    const confirm = screen.getByTestId("sweep-host-switch-confirm-action");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    // A check that ran at a moment which has since passed is not an admission.
    expect(lastCensusHostId()).toBe("host-a");
    // And it says why, rather than looking broken.
    expect(
      screen.getByTestId("sweep-host-switch-confirm").textContent,
    ).toContain("Not while this host is busy");
  });

  it("refuses a HELD confirmation once a refresh starts under it", () => {
    renderSweep();
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    const popover = openHostPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Studio/ }));
    expect(screen.getByTestId("sweep-host-switch-confirm")).toBeTruthy();

    // The other cause of the same gap: the census under the question starts
    // being re-proved while it waits for an answer.
    state.refreshing = true;
    fireEvent.click(screen.getByTestId("sweep-worktrees-refresh"));

    const confirm = screen.getByTestId("sweep-host-switch-confirm-action");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(lastCensusHostId()).toBe("host-a");
  });

  it("asks, on screen and cancellably, when the surface cannot name its host", () => {
    const view = render(sweep({ client: SURFACE_CLIENT, hostId: null }));

    // The dialog is UP. Rendering nothing here was the defect: the caller's
    // "sweep is open" state is only ever cleared from `onOpenChange`, so an
    // invisible wait is a request nobody can see, cancel, or wait out.
    expect(screen.getByTestId("sweep-worktrees-dialog")).toBeTruthy();
    expect(screen.getByTestId("sweep-host-chip").textContent).toContain(
      "Choose a host",
    );
    expect(
      screen.getByTestId("sweep-worktrees-host-unchosen").textContent,
    ).toBe("Choose a host to check its worktrees.");
    // Nothing is claimed about anyone's disk, because nothing was walked.
    expect(screen.queryByTestId("sweep-worktrees-empty")).toBeNull();
    expect(captured.censusHostIds.every((hostId) => hostId === null)).toBe(
      true,
    );

    view.rerender(sweep(SURFACE_ON_A));

    expect(screen.getByTestId("sweep-host-chip").textContent).toContain(
      "on Laptop",
    );
    expect(lastCensusHostId()).toBe("host-a");
  });

  it("says it is still finding hosts, cancellably, before the directory answers", () => {
    state.fleetResolved = false;
    const view = render(sweep(SURFACE_ON_A));

    expect(
      screen.getByTestId("sweep-worktrees-fleet-pending").textContent,
    ).toBe("Checking which hosts are available…");
    // No chip AT ALL - not even the unchosen one. We do not yet know whether
    // this account has a choice, and a chooser flashing at a single-host
    // install is the byte-identical promise broken for a query's length.
    expect(screen.queryByTestId("sweep-host-chip")).toBeNull();
    // Nothing is claimed about a disk, and nothing is walked.
    expect(screen.queryByTestId("sweep-worktrees-empty")).toBeNull();
    expect(captured.censusHostIds.every((hostId) => hostId === null)).toBe(
      true,
    );

    state.fleetResolved = true;
    view.rerender(sweep(SURFACE_ON_A));
    expect(screen.getByTestId("sweep-host-chip").textContent).toContain(
      "on Laptop",
    );
  });

  it("can be cancelled while the fleet is still pending", () => {
    state.fleetResolved = false;
    render(sweep(SURFACE_ON_A));

    fireEvent.click(screen.getByTestId("sweep-worktrees-cancel"));

    expect(captured.openChanges).toContain(false);
  });

  it("does not show a stale Review when a Task is reopened with no host", async () => {
    state.unproven = true;
    const view = renderSweep();
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(await screen.findByTestId("sweep-review-host")).toBeTruthy();

    // Cancel parks the session, exactly as it does for an ordinary re-open.
    view.rerender(closedSweep());
    // Re-opened while the window cannot name its host: "no host" and "not
    // open" are both absences, and sharing one session key made this look
    // like the gap between two opens - so host A's Review survived, naming a
    // machine this dialog is no longer pointed at, over a Sweep button that
    // silently did nothing.
    view.rerender(sweep({ client: SURFACE_CLIENT, hostId: null }));

    expect(screen.queryByTestId("sweep-review-host")).toBeNull();
    expect(screen.queryByTestId("sweep-worktrees-back")).toBeNull();
    expect(
      screen.getByTestId("sweep-worktrees-host-unchosen").textContent,
    ).toBe("Choose a host to check its worktrees.");
  });

  it("does not show a stale Review when a Task is reopened before the fleet answers", async () => {
    state.unproven = true;
    const view = renderSweep();
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(await screen.findByTestId("sweep-review-host")).toBeTruthy();

    view.rerender(closedSweep());
    state.fleetResolved = false;
    view.rerender(sweep(SURFACE_ON_A));

    // A pending dialog has no host, so that receipt must not paint over one
    // that is telling the person it has not started.
    expect(screen.queryByTestId("sweep-review-host")).toBeNull();
    expect(
      screen.getByTestId("sweep-worktrees-fleet-pending").textContent,
    ).toBe("Checking which hosts are available…");

    // ...and it must not come BACK when the fleet answers with the same host.
    // Hiding it only while pending would have left the parked session intact,
    // so the restored `host:A` key would match and the stale Review would
    // paint again the moment the directory replied.
    state.fleetResolved = true;
    view.rerender(sweep(SURFACE_ON_A));

    expect(screen.queryByTestId("sweep-review-host")).toBeNull();
    expect(screen.getByTestId("sweep-host-chip").textContent).toContain(
      "on Laptop",
    );
    expect(screen.getByTestId("sweep-worktrees-checkbox")).toBeTruthy();
  });

  it("withdraws a Review whose host stops answering, rather than offering it", async () => {
    state.unproven = true;
    const view = renderSweep();
    const popover = openHostPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Studio/ }));
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(
      (await screen.findByTestId("sweep-review-host")).textContent,
    ).toContain("On Studio");

    // Studio leaves the directory with its Review on screen. The host is
    // SETTLED, so the flow holds it - and the dialog holds the snapshot too,
    // because its session key goes null and parks. What must not survive that
    // is the confirmation itself: a receipt for a proof we can no longer act
    // on, whose Sweep button would silently do nothing.
    state.unresolvableHostIds = ["host-b"];
    view.rerender(sweep(SURFACE_ON_A));

    expect(screen.queryByTestId("sweep-review-host")).toBeNull();
    expect(
      screen.getByTestId("sweep-worktrees-host-unreachable").textContent,
    ).toContain("Can't reach Studio");
  });

  it("does not restore a parked Review when a pending fleet resolves to ONE host", async () => {
    state.unproven = true;
    const view = renderSweep();
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(await screen.findByTestId("sweep-review-host")).toBeTruthy();

    view.rerender(closedSweep());
    state.fleetResolved = false;
    view.rerender(sweep(SURFACE_ON_A));
    // The single-host resolution takes the `surface` arm, which carries no
    // host choice at all - so it is the arm most likely to look like the
    // dialog never lost its host.
    state.fleetResolved = true;
    state.connectableHostIds = ["host-a"];
    view.rerender(sweep(SURFACE_ON_A));

    expect(screen.queryByTestId("sweep-review-host")).toBeNull();
    expect(screen.queryByTestId("sweep-host-chip")).toBeNull();
    expect(screen.getByTestId("sweep-worktrees-checkbox")).toBeTruthy();
  });

  it("does not resume a parked Review when the same host is chosen afresh", async () => {
    state.unproven = true;
    const view = renderSweep();
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(await screen.findByTestId("sweep-review-host")).toBeTruthy();

    view.rerender(closedSweep());
    view.rerender(sweep({ client: SURFACE_CLIENT, hostId: null }));
    const popover = openHostPopover();
    // The flat list has no grouping while unchosen either - every host,
    // including the window's own machine, is a plain row in the popover.
    fireEvent.click(within(popover).getByRole("button", { name: /Laptop/ }));

    // Answering "which host" with the SAME machine still has to land on
    // Choose. Without an identity of its own, the unchosen detour reads as the
    // closed gap - so picking Laptop would resume a receipt from before the
    // question was asked, which is not what the person just agreed to.
    expect(lastCensusHostId()).toBe("host-a");
    expect(screen.queryByTestId("sweep-review-host")).toBeNull();
    expect(screen.getByTestId("sweep-worktrees-checkbox")).toBeTruthy();
  });

  it("lets you answer the unchosen question from the popover", () => {
    render(sweep({ client: SURFACE_CLIENT, hostId: null }));

    const popover = openHostPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Studio/ }));

    expect(lastCensusHostId()).toBe("host-b");
    expect(screen.getByText("branch-wt-b")).toBeTruthy();
  });

  it("can be cancelled from the unchosen state, which is what disarms the caller", () => {
    render(sweep({ client: SURFACE_CLIENT, hostId: null }));

    fireEvent.click(screen.getByTestId("sweep-worktrees-cancel"));

    // `onOpenChange(false)` is the ONLY thing that clears the caller's pending
    // sweep, so this is the whole recovery path.
    expect(captured.openChanges).toContain(false);
  });
});
