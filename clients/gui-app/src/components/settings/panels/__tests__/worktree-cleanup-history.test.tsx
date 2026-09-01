import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  WorktreeAutoCleanupRunSummary,
  WorktreeAutoCleanupTarget,
} from "@traycer/protocol/host/worktree-auto-cleanup-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeCleanupHistory } from "@/components/settings/panels/worktree-cleanup-history";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { useWorktreeCleanupViewStore } from "@/stores/settings/worktree-cleanup-view-store";

/**
 * The history sub-view's presentation contract: a `skipped` target is neutral,
 * an `interrupted` one is neutral and honestly unconfirmed, and only `failed`
 * wears failure styling. Each target row stands on its own — two rows for the
 * same path are two rows.
 */
function runFixture(
  overrides: Partial<WorktreeAutoCleanupRunSummary> & {
    readonly runId: string;
  },
): WorktreeAutoCleanupRunSummary {
  return {
    policyRevision: 1,
    inactivityDays: 30,
    cutoffAt: 1_000,
    startedAt: 2_000,
    completedAt: 3_000,
    status: "completed",
    evaluatedCount: 12,
    candidateCount: 3,
    deletedCount: 3,
    skippedCount: 0,
    failedCount: 0,
    interruptedCount: 0,
    budgetExhausted: false,
    ...overrides,
  };
}

function targetFixture(
  overrides: Partial<WorktreeAutoCleanupTarget> & {
    readonly targetId: string;
    readonly runId: string;
  },
): WorktreeAutoCleanupTarget {
  return {
    worktreePath: "/Users/dev/.traycer/worktrees/acme-app-1",
    repoLabel: "acme/app",
    branchLabel: "traycer/quiet-otter",
    tierAtSelection: "merged",
    activityAt: 500,
    createdAtInput: 100,
    reflogAtInput: 400,
    durableActivityInput: 500,
    outcome: "deleted",
    reasonCode: null,
    displayMessage: null,
    teardownExitCode: null,
    teardownTimedOut: false,
    supersedesTargetId: null,
    settledAt: 2_500,
    ...overrides,
  };
}

interface HistoryHandlers {
  readonly listRuns: (request: {
    readonly cursor: string | null;
    readonly limit: number;
  }) => {
    runs: WorktreeAutoCleanupRunSummary[];
    nextCursor: string | null;
  };
  readonly getRun: (request: { readonly runId: string }) => {
    run: WorktreeAutoCleanupRunSummary | null;
    targets: WorktreeAutoCleanupTarget[];
  };
}

function clientWithHistory(
  handlers: HistoryHandlers,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${Math.random().toString(36).slice(2)}`,
      handlers: {
        "worktree.listAutoCleanupRuns": (request) => handlers.listRuns(request),
        "worktree.getAutoCleanupRun": (request) => handlers.getRun(request),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

function renderHistory(client: HostClient<HostRpcRegistry>): {
  readonly onBack: () => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onBack = vi.fn();
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  render(
    <Wrapper>
      <WorktreeCleanupHistory
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({ hostId: "host-a", name: "Host A" }),
          client,
        })}
        onBack={onBack}
      />
    </Wrapper>,
  );
  return { onBack };
}

beforeEach(() => {
  useWorktreeCleanupViewStore.setState({
    view: "cleanupHistory",
    focusedRunId: null,
  });
});

afterEach(() => {
  cleanup();
  useWorktreeCleanupViewStore.setState({
    view: "settings",
    focusedRunId: null,
  });
});

describe("WorktreeCleanupHistory", () => {
  it("says nothing has run rather than showing an empty list", async () => {
    renderHistory(
      clientWithHistory({
        listRuns: () => ({ runs: [], nextCursor: null }),
        getRun: () => ({ run: null, targets: [] }),
      }),
    );

    await waitFor(() => {
      screen.getByText("No automatic cleanup has run on this host yet.");
    });
  });

  it("shows a running pass as running and an interrupted one as unconfirmed", async () => {
    renderHistory(
      clientWithHistory({
        listRuns: () => ({
          runs: [
            runFixture({
              runId: "run-running",
              status: "running",
              completedAt: null,
              deletedCount: 1,
              candidateCount: 4,
            }),
            runFixture({
              runId: "run-interrupted",
              status: "interrupted",
              completedAt: null,
              deletedCount: 1,
              interruptedCount: 2,
            }),
          ],
          nextCursor: null,
        }),
        getRun: () => ({ run: null, targets: [] }),
      }),
    );

    await waitFor(() => {
      screen.getByText("Running…");
    });
    // `interrupted` is TERMINAL for a run record, so it must never read as
    // "still working".
    screen.getByText("Unconfirmed — Host stopped during cleanup");
  });

  it("renders a mixed-outcome run neutrally except for the one real failure", async () => {
    renderHistory(
      clientWithHistory({
        listRuns: () => ({
          runs: [
            runFixture({
              runId: "run-mixed",
              deletedCount: 1,
              skippedCount: 1,
              failedCount: 1,
              interruptedCount: 1,
            }),
          ],
          nextCursor: null,
        }),
        getRun: () => ({
          run: runFixture({ runId: "run-mixed" }),
          targets: [
            targetFixture({ targetId: "t-1", runId: "run-mixed" }),
            targetFixture({
              targetId: "t-2",
              runId: "run-mixed",
              outcome: "skipped",
              reasonCode: "not_eligible:dirty",
              displayMessage: "Uncommitted changes appeared before deletion.",
            }),
            targetFixture({
              targetId: "t-3",
              runId: "run-mixed",
              outcome: "failed",
              reasonCode: "removal_error",
              displayMessage: "The worktree directory could not be removed.",
            }),
            targetFixture({
              targetId: "t-4",
              runId: "run-mixed",
              outcome: "interrupted",
              reasonCode: "host_stopped",
              displayMessage: null,
              settledAt: null,
            }),
          ],
        }),
      }),
    );

    await waitFor(() => {
      screen.getByText("1 removed, 1 skipped, 1 failed, 1 unconfirmed");
    });
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    await waitFor(() => {
      screen.getByTestId("worktree-cleanup-targets");
    });
    const rows = screen.getAllByTestId("worktree-cleanup-target");
    expect(rows.map((row) => row.getAttribute("data-outcome"))).toEqual([
      "deleted",
      "skipped",
      "failed",
      "interrupted",
    ]);
    // Neutral wording for the two states that are not failures, and the host's
    // own `displayMessage` wherever it sent one.
    screen.getByText("No longer eligible");
    screen.getByText("Uncommitted changes appeared before deletion.");
    screen.getByText("Unconfirmed");
    screen.getByText("Unconfirmed — Host stopped during cleanup.");
    // Only `failed` wears failure styling.
    const failureLabel = screen.getByText("Failed");
    expect(failureLabel.className).toContain("text-destructive");
    expect(screen.getByText("No longer eligible").className).not.toContain(
      "text-destructive",
    );
    // Every row stands alone: the path is shown as-is for this host.
    expect(rows).toHaveLength(4);
    expect(
      screen.getAllByText("/Users/dev/.traycer/worktrees/acme-app-1"),
    ).toHaveLength(4);
  });

  it("pages with a cursor and never asks for a page the host did not offer", async () => {
    const cursors: Array<string | null> = [];
    renderHistory(
      clientWithHistory({
        listRuns: (request) => {
          cursors.push(request.cursor);
          if (request.cursor === null) {
            return {
              runs: [runFixture({ runId: "run-newest" })],
              nextCursor: "cursor-2",
            };
          }
          return {
            runs: [runFixture({ runId: "run-older" })],
            nextCursor: null,
          };
        },
        getRun: () => ({ run: null, targets: [] }),
      }),
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("worktree-cleanup-run")).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("worktree-cleanup-run")).toHaveLength(2);
    });
    expect(cursors).toEqual([null, "cursor-2"]);
    // The last page ends the list rather than offering a dead control.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("opens expanded on the run a notification focused, and consumes the hint", async () => {
    useWorktreeCleanupViewStore.setState({
      view: "cleanupHistory",
      focusedRunId: "run-focused",
    });
    renderHistory(
      clientWithHistory({
        listRuns: () => ({
          runs: [
            runFixture({ runId: "run-newest" }),
            runFixture({ runId: "run-focused" }),
          ],
          nextCursor: null,
        }),
        getRun: (request) => ({
          run: runFixture({ runId: request.runId }),
          targets: [targetFixture({ targetId: "t-1", runId: request.runId })],
        }),
      }),
    );

    await waitFor(() => {
      screen.getByTestId("worktree-cleanup-targets");
    });
    const expanded = screen
      .getAllByTestId("worktree-cleanup-run")
      .filter((row) => row.querySelector('[aria-expanded="true"]') !== null);
    expect(expanded.map((row) => row.getAttribute("data-run-id"))).toEqual([
      "run-focused",
    ]);
    // The hint is consumed when the view goes away: re-entering history later
    // must not silently re-expand a run the user had closed.
    expect(useWorktreeCleanupViewStore.getState().focusedRunId).toBe(
      "run-focused",
    );
    cleanup();
    expect(useWorktreeCleanupViewStore.getState().focusedRunId).toBeNull();
  });

  it("says a focused run is gone instead of dead-ending on it", async () => {
    useWorktreeCleanupViewStore.setState({
      view: "cleanupHistory",
      focusedRunId: "run-collected",
    });
    renderHistory(
      clientWithHistory({
        listRuns: () => ({
          runs: [runFixture({ runId: "run-collected" })],
          nextCursor: null,
        }),
        // Retention GC dropped it between the notification and this read.
        getRun: () => ({ run: null, targets: [] }),
      }),
    );

    await waitFor(() => {
      screen.getByText("This run is no longer in this host's history.");
    });
  });
});
