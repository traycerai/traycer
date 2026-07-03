import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTaskDeleteWorktreeCandidates } from "@/hooks/epic/use-task-delete-worktree-candidates-query";

interface StubOwner {
  readonly epicId: string;
  readonly ownerKind: "chat" | "terminal-agent";
  readonly ownerId: string;
  readonly updatedAt: number;
}

interface StubBranchStatus {
  readonly ahead: number;
  readonly behind: number;
  readonly mergedIntoDefault: boolean;
}

interface StubEntry {
  readonly worktreePath: string;
  readonly repoLabel: string;
  readonly branch: string | null;
  readonly uncommittedCount: number;
  readonly inUse: boolean;
  readonly owners: ReadonlyArray<StubOwner>;
  readonly branchStatus: StubBranchStatus | null;
}

interface MockQueryResult {
  readonly data: { readonly worktrees: StubEntry[] } | undefined;
  readonly isError: boolean;
}

const mockQueryResult = vi.hoisted((): { current: MockQueryResult } => ({
  current: { data: undefined, isError: false },
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({ getActiveHostId: () => "host-1" }),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => mockQueryResult.current,
}));

function owner(epicId: string): StubOwner {
  return { epicId, ownerKind: "chat", ownerId: `chat-${epicId}`, updatedAt: 1 };
}

function entry(over: Partial<StubEntry> & { worktreePath: string }): StubEntry {
  return {
    repoLabel: "acme/app",
    branch: "feat/x",
    uncommittedCount: 0,
    inUse: false,
    owners: [owner("epic-1")],
    branchStatus: null,
    ...over,
  };
}

describe("useTaskDeleteWorktreeCandidates", () => {
  beforeEach(() => {
    mockQueryResult.current = { data: undefined, isError: false };
  });

  it("offers worktrees whose owners are all in the deleted set and not in use", () => {
    mockQueryResult.current = {
      data: {
        worktrees: [
          entry({
            worktreePath: "/wt/a",
            branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
          }),
        ],
      },
      isError: false,
    };
    const { result } = renderHook(() =>
      useTaskDeleteWorktreeCandidates(["epic-1"]),
    );
    expect(result.current.candidates.map((c) => c.worktreePath)).toEqual([
      "/wt/a",
    ]);
    expect(result.current.candidates[0].ownerEpicIds).toEqual(["epic-1"]);
    // The activity-probed branch status is carried so the default-check evidence
    // rule can evaluate it downstream.
    expect(result.current.candidates[0].branchStatus).toEqual({
      ahead: 0,
      behind: 0,
      mergedIntoDefault: true,
    });
  });

  it("excludes in-use, ownerless, and out-of-scope worktrees", () => {
    mockQueryResult.current = {
      data: {
        worktrees: [
          entry({ worktreePath: "/wt/inuse", inUse: true }),
          entry({ worktreePath: "/wt/noowner", owners: [] }),
          entry({ worktreePath: "/wt/other", owners: [owner("epic-2")] }),
          entry({
            worktreePath: "/wt/mixed",
            owners: [owner("epic-1"), owner("epic-2")],
          }),
          entry({ worktreePath: "/wt/ok", owners: [owner("epic-1")] }),
        ],
      },
      isError: false,
    };
    const { result } = renderHook(() =>
      useTaskDeleteWorktreeCandidates(["epic-1"]),
    );
    expect(result.current.candidates.map((c) => c.worktreePath)).toEqual([
      "/wt/ok",
    ]);
  });

  // Regression: `listAllForHost` is the shared host-wide key, so React Query can
  // retain the last successful data after a failed refetch. A failed query must
  // never offer (possibly already deleted) stale worktree paths.
  it("suppresses candidates while the query is in an error state, even with retained data", () => {
    mockQueryResult.current = {
      data: { worktrees: [entry({ worktreePath: "/wt/a" })] },
      isError: true,
    };
    const { result } = renderHook(() =>
      useTaskDeleteWorktreeCandidates(["epic-1"]),
    );
    expect(result.current.candidates).toEqual([]);
    expect(result.current.isError).toBe(true);
  });

  it("returns no candidates when the dialog is closed (null ids)", () => {
    mockQueryResult.current = {
      data: { worktrees: [entry({ worktreePath: "/wt/a" })] },
      isError: false,
    };
    const { result } = renderHook(() => useTaskDeleteWorktreeCandidates(null));
    expect(result.current.candidates).toEqual([]);
  });
});
