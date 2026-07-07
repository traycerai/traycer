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

interface StubSubmoduleFact {
  readonly repoIdentifier: { readonly owner: string; readonly repo: string };
  readonly branch: string;
  readonly prState: "merged" | "open" | "closed" | "none" | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly mergedHeadShaMatches: boolean;
  readonly mergedIntoDefault: boolean;
}

interface StubEntry {
  readonly worktreePath: string;
  readonly repoLabel: string;
  readonly branch: string | null;
  readonly uncommittedCount: number;
  readonly inUse: boolean;
  readonly gitRemovable: boolean;
  readonly owners: ReadonlyArray<StubOwner>;
  readonly branchStatus: StubBranchStatus | null;
  readonly prState: "merged" | "open" | "closed" | "none" | null;
  readonly mergedHeadShaMatches: boolean;
  readonly submodules: ReadonlyArray<StubSubmoduleFact>;
  readonly atBaseCommit: boolean;
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
    gitRemovable: true,
    owners: [owner("epic-1")],
    branchStatus: null,
    prState: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
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
    // A merged candidate is proven-removable → default-checked.
    expect(result.current.candidates[0].provenRemovable).toBe(true);
  });

  it("computes provenRemovable against the POST-delete state (owners emptied)", () => {
    mockQueryResult.current = {
      data: {
        worktrees: [
          // Clean, at the upstream tip (ahead 0), but still owned by the Task
          // being deleted. On the always-on list this stays out of the green
          // tiers (owners gate), yet here - modelling the post-delete state -
          // it is proven-removable and defaults checked.
          entry({
            worktreePath: "/wt/tip",
            owners: [owner("epic-1")],
            branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: false },
          }),
          // Merged via a validated PR, never pushed to a local-ancestry proof.
          entry({
            worktreePath: "/wt/pr",
            owners: [owner("epic-1")],
            prState: "merged",
            mergedHeadShaMatches: true,
          }),
          // Dirty → not proven-removable, defaults unchecked.
          entry({
            worktreePath: "/wt/dirty",
            owners: [owner("epic-1")],
            uncommittedCount: 2,
          }),
          // Unproven branch status → defaults unchecked.
          entry({
            worktreePath: "/wt/unknown",
            owners: [owner("epic-1")],
            branchStatus: null,
          }),
        ],
      },
      isError: false,
    };
    const { result } = renderHook(() =>
      useTaskDeleteWorktreeCandidates(["epic-1"]),
    );
    const byPath = new Map(
      result.current.candidates.map((c) => [c.worktreePath, c.provenRemovable]),
    );
    expect(byPath.get("/wt/tip")).toBe(true);
    expect(byPath.get("/wt/pr")).toBe(true);
    expect(byPath.get("/wt/dirty")).toBe(false);
    expect(byPath.get("/wt/unknown")).toBe(false);
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
