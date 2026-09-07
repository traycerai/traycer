import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import type { EpicSweepWorktreeRow } from "@/hooks/epic/use-epic-sweep-worktree-candidates-query";
import { useSweepSessionStore } from "@/stores/epics/sweep-session-store";

/**
 * The Remove click's own contract: it re-proves before anything destructive,
 * and the proof outlives the dialog rather than being cancelled by it.
 *
 * These cases drive the REAL dialog against a fully-controlled candidates
 * hook, so `prove()` can be resolved, rejected, or held open on cue - the
 * thing `sweep-worktrees-dialog-force-delete.test.tsx` and
 * `sweep-worktrees-dialog-refresh.test.tsx` do not need to do, because none
 * of their cases care about the gap between the click and the proof landing.
 */

const HOLDERS: readonly WorktreeBusyHolder[] = [
  {
    ownerRef: {
      epicId: "epic-1",
      ownerKind: "terminal-agent",
      ownerId: "tui-1",
    },
    holdKind: "terminal-agent-pty",
    activity: "working",
    label: "Claude Code agent polite-ocelot is working",
    holderId: "epic-1:terminal-agent:tui-1",
  },
];

/** A `prove()` held open until the test says so - the gap the cases below are about. */
function deferredProve(): {
  readonly promise: Promise<ReadonlyArray<EpicSweepWorktreeRow>>;
  readonly resolve: (rows: ReadonlyArray<EpicSweepWorktreeRow>) => void;
} {
  let resolve: (rows: ReadonlyArray<EpicSweepWorktreeRow>) => void = () =>
    undefined;
  const promise = new Promise<ReadonlyArray<EpicSweepWorktreeRow>>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const testState = vi.hoisted(() => ({
  hostId: "host-1",
  rows: [] as EpicSweepWorktreeRow[],
  isPending: false,
  prove: vi.fn((): Promise<ReadonlyArray<EpicSweepWorktreeRow>> =>
    Promise.resolve([]),
  ),
  mutate: vi.fn(),
  mutationPending: false,
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktree-candidates-query", () => ({
  useEpicSweepWorktreeCandidatesForClient: () => ({
    hostId: testState.hostId,
    rows: testState.rows,
    isPending: testState.isPending,
    isError: false,
    checkedAt: Date.now(),
    canRefresh: true,
    refresh: () => Promise.resolve(testState.rows),
    prove: testState.prove,
  }),
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktrees-mutation", () => ({
  useEpicSweepWorktrees: () => ({
    isPending: testState.mutationPending,
    mutate: testState.mutate,
  }),
  useSweepingWorktreePaths: () => new Set<string>(),
}));

vi.mock("@/components/worktree/worktree-pr-metadata", () => ({
  WorktreePrPills: () => null,
}));

vi.mock("@/lib/worktree/teardown-agent-names", () => ({
  useTeardownAgentNames: () => new Map<string, string>(),
}));

vi.mock("@/components/settings/panels/use-worktree-task-titles", () => ({
  useWorktreeTaskTitles: () => new Map<string, string>(),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

import { SweepWorktreesDialog } from "@/components/epics/sweep-worktrees-dialog";

function worktreeEntry(
  over: Partial<WorktreeHostEntryV14> & { readonly worktreePath: string },
): WorktreeHostEntryV14 {
  return {
    worktreePath: over.worktreePath,
    branch: over.branch ?? "feat-proof",
    repoLabel: "traycerai/traycer",
    repoIdentifier: { owner: "traycerai", repo: "traycer" },
    inUse: over.inUse ?? false,
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
    atBaseCommit: over.atBaseCommit ?? false,
    resolvedAt: Date.now(),
  };
}

function safeRow(worktreePath: string, branch: string): EpicSweepWorktreeRow {
  return {
    entry: worktreeEntry({ worktreePath, branch, inUse: false }),
    tier: "merged",
    defaultChecked: true,
    disabled: false,
    note: null,
    holders: [],
    holdersStatus: "none",
  };
}

function inUseRow(worktreePath: string, branch: string): EpicSweepWorktreeRow {
  return {
    entry: worktreeEntry({ worktreePath, branch, inUse: true }),
    tier: "in-use",
    defaultChecked: false,
    disabled: false,
    note: "in-use",
    holders: HOLDERS,
    holdersStatus: "ready",
  };
}

/**
 * The pre-proof shape of an in-use row: already flagged `in-use` (so a
 * manual check on it counts as "previously in-use" for reconciliation), but
 * without a settled holder inventory yet.
 */
function inUseUnknownRow(
  worktreePath: string,
  branch: string,
): EpicSweepWorktreeRow {
  return {
    entry: worktreeEntry({ worktreePath, branch, inUse: true }),
    tier: "in-use",
    defaultChecked: false,
    disabled: false,
    note: "in-use",
    holders: [],
    holdersStatus: "unknown",
  };
}

function renderDialog(epicIds: ReadonlyArray<string> | null) {
  return render(
    <SweepWorktreesDialog
      epicIds={epicIds}
      hostClient={null}
      hostChoice={null}
      fleetPending={false}
      taskTitle="Task"
      onOpenChange={vi.fn()}
    />,
  );
}

describe("SweepWorktreesDialog Remove-click proof", () => {
  beforeEach(() => {
    useSweepSessionStore.getState().reset();
    testState.hostId = "host-1";
    testState.rows = [];
    testState.isPending = false;
    testState.mutationPending = false;
    testState.prove.mockReset();
    testState.prove.mockImplementation(() => Promise.resolve([]));
    testState.mutate.mockReset();
    vi.mocked(toast.info).mockReset();
  });

  afterEach(() => {
    cleanup();
    useSweepSessionStore.getState().reset();
  });

  it("calls prove before mutate, and mutates with the fresh row", async () => {
    testState.rows = [safeRow("/wt/a", "stale-branch")];
    testState.prove.mockImplementation(() =>
      Promise.resolve([safeRow("/wt/a", "fresh-branch")]),
    );
    renderDialog(["epic-1"]);

    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));

    expect(testState.prove).toHaveBeenCalledTimes(1);
    // Nothing destructive has happened yet - the proof has not landed.
    expect(testState.mutate).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(testState.mutate).toHaveBeenCalledTimes(1);
    });
    const variables = testState.mutate.mock.calls[0]?.[0] as {
      worktrees: ReadonlyArray<{ branch: string | null }>;
    };
    expect(variables.worktrees[0]?.branch).toBe("fresh-branch");
  });

  it("still fires prove, with the button enabled, while the mutation is pending", () => {
    testState.rows = [safeRow("/wt/a", "feat-a")];
    testState.mutationPending = true;
    renderDialog(["epic-1"]);

    const confirm = screen.getByTestId("sweep-worktrees-confirm");
    expect(confirm.hasAttribute("disabled")).toBe(false);

    fireEvent.click(confirm);
    expect(testState.prove).toHaveBeenCalledTimes(1);
  });

  it("opens review when the proof comes back in-use, and does not mutate", async () => {
    // Reconciliation keeps a row only when it was ALREADY in-use at click
    // time (a newly-in-use row is dropped, not reviewed) - so the row starts
    // in-use with an unresolved holder inventory, and the click is what
    // resolves it.
    testState.rows = [inUseUnknownRow("/wt/a", "feat-a")];
    renderDialog(["epic-1"]);
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    testState.prove.mockImplementation(() =>
      Promise.resolve([inUseRow("/wt/a", "feat-a")]),
    );

    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));

    await waitFor(() => {
      expect(screen.getByTestId("sweep-worktrees-confirm").textContent).toBe(
        "Confirm and remove 1 worktree",
      );
    });
    expect(testState.mutate).not.toHaveBeenCalled();
  });

  it("removes nothing and stays on Choose when the proof resolves empty", async () => {
    testState.rows = [safeRow("/wt/a", "feat-a")];
    testState.prove.mockImplementation(() => Promise.resolve([]));
    renderDialog(["epic-1"]);

    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));

    await waitFor(() => {
      expect(testState.prove).toHaveBeenCalledTimes(1);
    });
    expect(testState.mutate).not.toHaveBeenCalled();
    expect(screen.queryByText("Review this sweep")).toBeNull();
    // The dialog is open for this session, so it says nothing in a toast.
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("removes nothing and stays on Choose when the proof rejects", async () => {
    testState.rows = [safeRow("/wt/a", "feat-a")];
    testState.prove.mockImplementation(() =>
      Promise.reject(new Error("network down")),
    );
    renderDialog(["epic-1"]);

    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));

    await waitFor(() => {
      expect(testState.prove).toHaveBeenCalledTimes(1);
    });
    expect(testState.mutate).not.toHaveBeenCalled();
    expect(screen.queryByText("Review this sweep")).toBeNull();
    expect(screen.getByTestId("sweep-worktrees-confirm")).toBeTruthy();
  });

  it("never blocks on the dialog: an all-safe proof still mutates after unmount", async () => {
    testState.rows = [safeRow("/wt/a", "feat-a")];
    const deferred = deferredProve();
    testState.prove.mockImplementation(() => deferred.promise);
    const view = renderDialog(["epic-1"]);

    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(testState.prove).toHaveBeenCalledTimes(1);

    view.unmount();
    deferred.resolve([safeRow("/wt/a", "feat-a")]);

    await waitFor(() => {
      expect(testState.mutate).toHaveBeenCalledTimes(1);
    });
  });

  it("never blocks on the dialog: an in-use proof parks a review and toasts after unmount", async () => {
    // Same pre-condition as the in-use review case above: the row must
    // already be in-use at click time, or reconciliation drops it instead of
    // parking it.
    testState.rows = [inUseUnknownRow("/wt/a", "feat-a")];
    const view = renderDialog(["epic-1"]);
    fireEvent.click(screen.getByTestId("sweep-worktrees-checkbox"));
    const deferred = deferredProve();
    testState.prove.mockImplementation(() => deferred.promise);

    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    view.unmount();
    deferred.resolve([inUseRow("/wt/a", "feat-a")]);

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalled();
    });
    const message = vi.mocked(toast.info).mock.calls[0]?.[0];
    expect(message).toContain("needs your confirmation");
    expect(useSweepSessionStore.getState().parked.size).toBe(1);

    // Re-opened on the SAME session (same host, same Task set): the parked
    // review is picked up rather than left for a toast nobody will see twice.
    renderDialog(["epic-1"]);

    await waitFor(() => {
      expect(screen.getByTestId("sweep-worktrees-confirm").textContent).toBe(
        "Confirm and remove 1 worktree",
      );
    });
    expect(useSweepSessionStore.getState().parked.size).toBe(0);
  });
});
