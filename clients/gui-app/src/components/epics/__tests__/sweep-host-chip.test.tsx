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
 * and the badge that was decoration in a list is the empty state's next step.
 * The flow's own latch and its fallbacks are asserted separately, against a
 * captured dialog, in `sweep-worktrees-flow.test.tsx`.
 *
 * Everything is asserted against the client's HOST ID rather than against
 * copy: "the census moved" means the candidates query ran on the other
 * machine's client, which is the only thing that makes a sweep safe.
 */

interface SweepCensusClient {
  readonly getActiveHostId: () => string | null;
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
    return {
      hostId,
      rows,
      isPending: false,
      isError: false,
      checkedAt: 1_700_000_000_000,
      canRefresh: true,
      // A refresh that never settles is how "mid-refresh" is held open: the
      // spinner hook stays `refreshing` until this resolves.
      refresh: (): Promise<ReadonlyArray<EpicSweepWorktreeRow>> =>
        state.refreshing
          ? new Promise<ReadonlyArray<EpicSweepWorktreeRow>>(() => undefined)
          : Promise.resolve(rows),
    };
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

function renderSweep(occupiedHostIds: ReadonlySet<string>) {
  return render(sweep(occupiedHostIds, SURFACE_ON_A));
}

/** The same flow with the Sweep shut, so a re-open can be driven. */
function closedSweep() {
  return (
    <SweepWorktreesFlow
      epicIds={null}
      surfaceHostClient={SURFACE_CLIENT}
      surfaceHostId="host-a"
      occupiedHostIds={STUDIO_OCCUPIED}
      taskTitle="Ship it"
      onOpenChange={(open) => captured.openChanges.push(open)}
    />
  );
}

function sweep(occupiedHostIds: ReadonlySet<string>, surface: SurfaceHost) {
  return (
    <SweepWorktreesFlow
      epicIds={["epic-1"]}
      surfaceHostClient={surface.client}
      surfaceHostId={surface.hostId}
      occupiedHostIds={occupiedHostIds}
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

const STUDIO_OCCUPIED: ReadonlySet<string> = new Set(["host-b"]);

describe("Sweep host chip", () => {
  beforeEach(() => {
    state.connectableHostIds = ["host-a", "host-b"];
    state.unresolvableHostIds = [];
    state.pathsByHost = { "host-a": ["/wt/a"], "host-b": ["/wt/b"] };
    state.sweepingPaths = [];
    state.refreshing = false;
    state.unproven = false;
    state.fleetResolved = true;
    captured.censusHostIds = [];
    captured.openChanges = [];
  });
  afterEach(() => {
    cleanup();
  });

  it("renders no host control at all on a single-host fleet", () => {
    state.connectableHostIds = ["host-a"];
    state.pathsByHost = { "host-a": [] };
    renderSweep(STUDIO_OCCUPIED);

    // The hard requirement: a single-host install sees byte-for-byte the Sweep
    // it had before multi-host Sweep existed - no chip, no nudge, and the same
    // empty sentence, even though a record names another machine.
    expect(screen.queryByTestId("sweep-host-chip")).toBeNull();
    expect(screen.queryByTestId("sweep-worktrees-host-nudge")).toBeNull();
    expect(screen.getByTestId("sweep-worktrees-empty").textContent).toBe(
      "No worktrees on this host for the selected tasks.",
    );
  });

  it("names the host the census in front of it was taken on", () => {
    renderSweep(STUDIO_OCCUPIED);

    expect(screen.getByTestId("sweep-host-chip").textContent).toContain(
      "on Laptop",
    );
    expect(lastCensusHostId()).toBe("host-a");
  });

  it("lists every host in the popover, badged first, the rest behind one disclosure", () => {
    renderSweep(STUDIO_OCCUPIED);
    const popover = openHostPopover();

    // Badged (host-b) and current (host-a) are immediately visible; the rest
    // of the fleet is one collapsed row rather than a wall of machines.
    const [first, second] = within(popover).getAllByRole("button", {
      name: /Laptop|Studio/,
    });
    expect(first.textContent).toContain("Studio");
    expect(second.textContent).toContain("Laptop");
    expect(
      within(popover).queryByRole("button", { name: /Retired box/ }),
    ).toBeNull();

    const toggle = within(popover).getByRole("button", { name: /Other hosts/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    // Listed even though nothing names it and nothing can dial it:
    // completeness is the guarantee, the badge is only a hint.
    const dead = within(popover).getByRole("button", { name: /Retired box/ });
    expect(dead.hasAttribute("disabled")).toBe(true);
    expect(
      within(popover)
        .getByRole("button", { name: /Studio/ })
        .getAttribute("data-occupied"),
    ).toBe("true");
    // The row a person is already looking at is MARKED - here that is simply
    // true, where in a modal that asked a question it read as a fake selection.
    expect(
      within(popover)
        .getByRole("button", { name: /Laptop/ })
        .getAttribute("data-current"),
    ).toBe("true");
  });

  it("keeps the completeness rationale behind an affordance", () => {
    renderSweep(STUDIO_OCCUPIED);
    const popover = openHostPopover();

    expect(within(popover).queryByTestId("sweep-host-completeness")).toBeNull();
    fireEvent.click(within(popover).getByTestId("sweep-host-why-every-host"));
    expect(
      within(popover).getByTestId("sweep-host-completeness").textContent,
    ).toContain("Every host is listed");
  });

  it("re-proves against the picked host's client when the host changes", () => {
    renderSweep(STUDIO_OCCUPIED);
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
    renderSweep(STUDIO_OCCUPIED);
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
    renderSweep(STUDIO_OCCUPIED);
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
    renderSweep(STUDIO_OCCUPIED);
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
    renderSweep(STUDIO_OCCUPIED);
    const popover = openHostPopover();

    const row = within(popover).getByRole("button", { name: /Studio/ });
    expect(row.hasAttribute("disabled")).toBe(true);
    expect(row.textContent).toContain("unavailable");
    fireEvent.click(row);
    expect(lastCensusHostId()).toBe("host-a");
  });

  it("redirects to the badged host when this host's census comes back empty", () => {
    state.pathsByHost = { "host-a": [], "host-b": ["/wt/b"] };
    renderSweep(STUDIO_OCCUPIED);

    expect(screen.getByTestId("sweep-worktrees-empty").textContent).toBe(
      "No worktrees for this task on Laptop.",
    );
    // The zero-RPC badge finally doing something: not a decoration on a list,
    // but the next step when the proof has nothing to show.
    expect(
      screen.getByTestId("sweep-worktrees-empty-redirect").textContent,
    ).toContain("Its agents ran on Studio");
    // And it says it ONCE - the header's nudge would be the same sentence.
    expect(screen.queryByTestId("sweep-worktrees-host-nudge")).toBeNull();

    fireEvent.click(
      screen.getByTestId("sweep-worktrees-empty-redirect-action"),
    );
    expect(lastCensusHostId()).toBe("host-b");
    expect(screen.getByText("branch-wt-b")).toBeTruthy();
  });

  it("nudges toward a badged host while still showing this host's rows", () => {
    renderSweep(STUDIO_OCCUPIED);

    expect(
      screen.getByTestId("sweep-worktrees-host-nudge").textContent,
    ).toContain("This task's agents also ran on Studio.");
    fireEvent.click(screen.getByTestId("sweep-worktrees-nudge-redirect"));
    expect(lastCensusHostId()).toBe("host-b");
  });

  it("does not nudge away from a host the records already name", () => {
    // Both hosts badged. The current one is where the records point too, so
    // there is nothing to correct - saying "agents also ran elsewhere" here is
    // noise on top of a census that is already the right one.
    renderSweep(new Set(["host-a", "host-b"]));

    expect(screen.queryByTestId("sweep-worktrees-host-nudge")).toBeNull();
  });

  it("does not offer a redirect onto a host nothing can dial", () => {
    // host-c is badged but offline: a redirect there would retarget the dialog
    // at a machine whose own popover row is inert.
    state.pathsByHost = { "host-a": [] };
    renderSweep(new Set(["host-c"]));

    expect(screen.getByTestId("sweep-worktrees-empty").textContent).toBe(
      "No worktrees for this task on Laptop.",
    );
    expect(screen.queryByTestId("sweep-worktrees-empty-redirect")).toBeNull();
    expect(screen.queryByTestId("sweep-worktrees-host-nudge")).toBeNull();
  });

  it("puts the chip out of reach while a sweep of these rows is streaming", () => {
    state.sweepingPaths = ["/wt/a"];
    renderSweep(STUDIO_OCCUPIED);

    // The host is not a live question while this machine is mid-teardown.
    expect(screen.getByTestId("sweep-host-chip").hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("puts the chip out of reach while the census is being re-proved", () => {
    state.refreshing = true;
    renderSweep(STUDIO_OCCUPIED);
    fireEvent.click(screen.getByTestId("sweep-worktrees-refresh"));

    expect(screen.getByTestId("sweep-host-chip").hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("freezes the host read-only in review, with Back as the only route", async () => {
    state.unproven = true;
    renderSweep(STUDIO_OCCUPIED);
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
    const view = renderSweep(STUDIO_OCCUPIED);
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(
      (await screen.findByTestId("sweep-review-host")).textContent,
    ).toContain("On Laptop");

    // History's surface props are the app-wide effective host. Laptop dies,
    // selection fails over to Studio, and the props this dialog was opened
    // with now describe a different machine.
    view.rerender(
      sweep(STUDIO_OCCUPIED, {
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
    const view = renderSweep(STUDIO_OCCUPIED);
    const popover = openHostPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Studio/ }));
    expect(lastCensusHostId()).toBe("host-b");

    // Studio leaves the directory with its census already on screen.
    state.unresolvableHostIds = ["host-b"];
    view.rerender(sweep(STUDIO_OCCUPIED, SURFACE_ON_A));

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

  it("asks before the header's nudge discards checks made by hand", () => {
    renderSweep(STUDIO_OCCUPIED);
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));

    fireEvent.click(screen.getByTestId("sweep-worktrees-nudge-redirect"));

    // The redirect is a host switch like any other, so it meets the same
    // question - raised on the chip, where the host decision lives.
    expect(
      screen.getByTestId("sweep-host-switch-confirm").textContent,
    ).toContain("Changing hosts clears this selection.");
    expect(lastCensusHostId()).toBe("host-a");

    fireEvent.click(screen.getByTestId("sweep-host-switch-confirm-action"));
    expect(lastCensusHostId()).toBe("host-b");
  });

  it("puts the empty state's redirect out of reach while the census is being re-proved", () => {
    // The empty state's redirect can never meet the OVERRIDE half of the
    // policy - a census with no rows has nothing to have checked by hand, and
    // the dialog drops overrides for paths that vanish. The disabled half is
    // the one it can meet, and it must.
    state.pathsByHost = { "host-a": [], "host-b": ["/wt/b"] };
    state.refreshing = true;
    renderSweep(STUDIO_OCCUPIED);
    fireEvent.click(screen.getByTestId("sweep-worktrees-refresh"));

    const redirect = screen.getByTestId(
      "sweep-worktrees-empty-redirect-action",
    );
    expect(redirect.hasAttribute("disabled")).toBe(true);
    fireEvent.click(redirect);
    expect(lastCensusHostId()).toBe("host-a");
  });

  it("refuses a HELD confirmation once another surface starts sweeping these rows", () => {
    const view = renderSweep(STUDIO_OCCUPIED);
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-nudge-redirect"));
    expect(screen.getByTestId("sweep-host-switch-confirm")).toBeTruthy();

    // The question was admitted when switching was allowed and then SAT there.
    // Another surface begins sweeping one of these rows underneath it.
    state.sweepingPaths = ["/wt/a"];
    view.rerender(sweep(STUDIO_OCCUPIED, SURFACE_ON_A));

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
    renderSweep(STUDIO_OCCUPIED);
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-nudge-redirect"));
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
    const view = render(
      sweep(STUDIO_OCCUPIED, { client: SURFACE_CLIENT, hostId: null }),
    );

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

    view.rerender(sweep(STUDIO_OCCUPIED, SURFACE_ON_A));

    expect(screen.getByTestId("sweep-host-chip").textContent).toContain(
      "on Laptop",
    );
    expect(lastCensusHostId()).toBe("host-a");
  });

  it("says it is still finding hosts, cancellably, before the directory answers", () => {
    state.fleetResolved = false;
    const view = render(sweep(STUDIO_OCCUPIED, SURFACE_ON_A));

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
    view.rerender(sweep(STUDIO_OCCUPIED, SURFACE_ON_A));
    expect(screen.getByTestId("sweep-host-chip").textContent).toContain(
      "on Laptop",
    );
  });

  it("can be cancelled while the fleet is still pending", () => {
    state.fleetResolved = false;
    render(sweep(STUDIO_OCCUPIED, SURFACE_ON_A));

    fireEvent.click(screen.getByTestId("sweep-worktrees-cancel"));

    expect(captured.openChanges).toContain(false);
  });

  it("does not show a stale Review when a Task is reopened with no host", async () => {
    state.unproven = true;
    const view = renderSweep(STUDIO_OCCUPIED);
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
    view.rerender(
      sweep(STUDIO_OCCUPIED, { client: SURFACE_CLIENT, hostId: null }),
    );

    expect(screen.queryByTestId("sweep-review-host")).toBeNull();
    expect(screen.queryByTestId("sweep-worktrees-back")).toBeNull();
    expect(
      screen.getByTestId("sweep-worktrees-host-unchosen").textContent,
    ).toBe("Choose a host to check its worktrees.");
  });

  it("does not show a stale Review when a Task is reopened before the fleet answers", async () => {
    state.unproven = true;
    const view = renderSweep(STUDIO_OCCUPIED);
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(await screen.findByTestId("sweep-review-host")).toBeTruthy();

    view.rerender(closedSweep());
    state.fleetResolved = false;
    view.rerender(sweep(STUDIO_OCCUPIED, SURFACE_ON_A));

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
    view.rerender(sweep(STUDIO_OCCUPIED, SURFACE_ON_A));

    expect(screen.queryByTestId("sweep-review-host")).toBeNull();
    expect(screen.getByTestId("sweep-host-chip").textContent).toContain(
      "on Laptop",
    );
    expect(screen.getByTestId("sweep-worktrees-checkbox")).toBeTruthy();
  });

  it("withdraws a Review whose host stops answering, rather than offering it", async () => {
    state.unproven = true;
    const view = renderSweep(STUDIO_OCCUPIED);
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
    view.rerender(sweep(STUDIO_OCCUPIED, SURFACE_ON_A));

    expect(screen.queryByTestId("sweep-review-host")).toBeNull();
    expect(
      screen.getByTestId("sweep-worktrees-host-unreachable").textContent,
    ).toContain("Can't reach Studio");
  });

  it("does not restore a parked Review when a pending fleet resolves to ONE host", async () => {
    state.unproven = true;
    const view = renderSweep(STUDIO_OCCUPIED);
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(await screen.findByTestId("sweep-review-host")).toBeTruthy();

    view.rerender(closedSweep());
    state.fleetResolved = false;
    view.rerender(sweep(STUDIO_OCCUPIED, SURFACE_ON_A));
    // The single-host resolution takes the `surface` arm, which carries no
    // host choice at all - so it is the arm most likely to look like the
    // dialog never lost its host.
    state.fleetResolved = true;
    state.connectableHostIds = ["host-a"];
    view.rerender(sweep(STUDIO_OCCUPIED, SURFACE_ON_A));

    expect(screen.queryByTestId("sweep-review-host")).toBeNull();
    expect(screen.queryByTestId("sweep-host-chip")).toBeNull();
    expect(screen.getByTestId("sweep-worktrees-checkbox")).toBeTruthy();
  });

  it("does not resume a parked Review when the same host is chosen afresh", async () => {
    state.unproven = true;
    const view = renderSweep(STUDIO_OCCUPIED);
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(await screen.findByTestId("sweep-review-host")).toBeTruthy();

    view.rerender(closedSweep());
    view.rerender(
      sweep(STUDIO_OCCUPIED, { client: SURFACE_CLIENT, hostId: null }),
    );
    const popover = openHostPopover();
    // Nothing is "current" while unchosen, so only the badged host leads and
    // the rest of the fleet - including the window's own machine - sits under
    // the disclosure.
    fireEvent.click(
      within(popover).getByRole("button", { name: /Other hosts/ }),
    );
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
    render(sweep(STUDIO_OCCUPIED, { client: SURFACE_CLIENT, hostId: null }));

    const popover = openHostPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Studio/ }));

    expect(lastCensusHostId()).toBe("host-b");
    expect(screen.getByText("branch-wt-b")).toBeTruthy();
  });

  it("keeps the badged host's redirect live while unchosen", () => {
    render(sweep(STUDIO_OCCUPIED, { client: SURFACE_CLIENT, hostId: null }));

    // Nothing is badged as "current", so the nudge is the fastest answer to
    // the question the dialog is asking - it must not be suppressed as if an
    // empty census had already spoken.
    fireEvent.click(screen.getByTestId("sweep-worktrees-nudge-redirect"));
    expect(lastCensusHostId()).toBe("host-b");
  });

  it("can be cancelled from the unchosen state, which is what disarms the caller", () => {
    render(sweep(STUDIO_OCCUPIED, { client: SURFACE_CLIENT, hostId: null }));

    fireEvent.click(screen.getByTestId("sweep-worktrees-cancel"));

    // `onOpenChange(false)` is the ONLY thing that clears the caller's pending
    // sweep, so this is the whole recovery path.
    expect(captured.openChanges).toContain(false);
  });

  it("puts the header's nudge out of reach while the census is being re-proved", () => {
    state.refreshing = true;
    renderSweep(STUDIO_OCCUPIED);
    fireEvent.click(screen.getByTestId("sweep-worktrees-refresh"));

    // The chip is not the only way to change host, so it cannot be the only
    // control the policy reaches.
    expect(screen.getByTestId("sweep-host-chip").hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      screen
        .getByTestId("sweep-worktrees-nudge-redirect")
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByTestId("sweep-worktrees-nudge-redirect"));
    expect(lastCensusHostId()).toBe("host-a");
  });
});
