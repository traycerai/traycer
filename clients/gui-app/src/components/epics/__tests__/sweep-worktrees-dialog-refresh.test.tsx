import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";

const testState = vi.hoisted(() => ({
  refresh: vi.fn(() => Promise.resolve()),
  isPending: false,
  isError: false,
  checkedAt: Date.now(),
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktree-candidates-query", () => ({
  useEpicSweepWorktreeCandidatesForClient: () => ({
    hostId: "host-1",
    rows: [
      {
        entry: worktreeEntry(),
        tier: "at-base-commit" as const,
        defaultChecked: true,
        disabled: false,
        note: null,
      },
    ],
    isPending: testState.isPending,
    isError: testState.isError,
    checkedAt: testState.checkedAt,
    canRefresh: true,
    refresh: testState.refresh,
  }),
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktrees-mutation", () => ({
  useEpicSweepWorktrees: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useSweepingWorktreePaths: () => new Set<string>(),
}));

vi.mock("@/components/worktree/worktree-pr-metadata", () => ({
  WorktreePrPills: () => null,
}));

import { SweepWorktreesDialog } from "@/components/epics/sweep-worktrees-dialog";

function worktreeEntry(): WorktreeHostEntryV14 {
  return {
    worktreePath: "/tmp/traycer-refresh",
    branch: "traycer/refresh",
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
    resolvedAt: Date.now(),
  };
}

describe("SweepWorktreesDialog refresh", () => {
  beforeEach(() => {
    testState.refresh.mockClear();
    testState.isPending = false;
    testState.isError = false;
    testState.checkedAt = Date.now();
  });

  afterEach(() => {
    cleanup();
  });

  it("mirrors the chat-hover refresh footer and claims its R shortcut", () => {
    render(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Refresh sweep"
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByTestId("sweep-worktrees-checked-at").textContent).toBe(
      "Workspace snapshot · now",
    );
    const refresh = screen.getByRole("button", {
      name: "Refresh worktree details",
    });
    expect(refresh.getAttribute("aria-keyshortcuts")).toBe("R");

    fireEvent.keyDown(window, { key: "r" });

    expect(testState.refresh).toHaveBeenCalledOnce();
  });

  it("keeps the cached snapshot visible but non-actionable while rechecking", () => {
    testState.isPending = true;

    render(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Refresh sweep"
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByText("traycer/refresh")).toBeTruthy();
    expect(screen.queryByText("Checking worktrees…")).toBeNull();
    expect(screen.getByTestId("sweep-worktrees-checked-at")).toBeTruthy();
    const checkbox = screen.getByTestId<HTMLButtonElement>(
      "sweep-worktrees-checkbox",
    );
    const confirm = screen.getByTestId<HTMLButtonElement>(
      "sweep-worktrees-confirm",
    );
    expect(checkbox.disabled).toBe(true);
    expect(confirm.disabled).toBe(true);
  });
});
