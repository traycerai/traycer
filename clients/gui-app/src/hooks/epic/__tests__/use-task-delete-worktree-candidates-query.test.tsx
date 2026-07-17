import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTaskDeleteWorktreeCandidates } from "@/hooks/epic/use-task-delete-worktree-candidates-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

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

const mockHostClient = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => mockHostClient,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "host-1",
    requestContextUserId: "user-1",
    isReady: true,
  }),
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
    mockHostClient.request.mockReset();
  });

  function wrapperFor(queryClient: QueryClient) {
    return (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  }

  function renderCandidates(deletedEpicIds: ReadonlyArray<string> | null) {
    const queryClient = new QueryClient();
    const hook = renderHook(
      () => useTaskDeleteWorktreeCandidates(deletedEpicIds),
      { wrapper: wrapperFor(queryClient) },
    );
    return { ...hook, queryClient };
  }

  it("offers worktrees whose owners are all in the deleted set and not in use", async () => {
    mockHostClient.request.mockResolvedValue({
      worktrees: [
        entry({
          worktreePath: "/wt/a",
          branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
        }),
      ],
      nextCursor: null,
    });
    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.candidates.map((c) => c.worktreePath)).toEqual([
        "/wt/a",
      ]);
    });
    expect(result.current.candidates.map((c) => c.worktreePath)).toEqual([
      "/wt/a",
    ]);
    expect(result.current.candidates[0].ownerEpicIds).toEqual(["epic-1"]);
    // The branch status is carried through to the dialog model.
    expect(result.current.candidates[0].branchStatus).toEqual({
      ahead: 0,
      behind: 0,
      mergedIntoDefault: true,
    });
    // A merged candidate is proven-removable → default-checked.
    expect(result.current.candidates[0].provenRemovable).toBe(true);
  });

  it("loops pages before deriving candidates", async () => {
    mockHostClient.request
      .mockResolvedValueOnce({
        worktrees: [entry({ worktreePath: "/wt/a" })],
        nextCursor: "/wt/a",
      })
      .mockResolvedValueOnce({
        worktrees: [entry({ worktreePath: "/wt/b" })],
        nextCursor: null,
      });
    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.candidates.map((c) => c.worktreePath)).toEqual([
        "/wt/a",
        "/wt/b",
      ]);
    });
    expect(mockHostClient.request).toHaveBeenNthCalledWith(
      1,
      "worktree.listAllForHost",
      {
        includeActivity: true,
        activityPaths: null,
        cursor: null,
        limit: 8,
        forceRefresh: false,
      },
    );
    expect(mockHostClient.request).toHaveBeenNthCalledWith(
      2,
      "worktree.listAllForHost",
      {
        includeActivity: true,
        activityPaths: null,
        cursor: "/wt/a",
        limit: 8,
        forceRefresh: false,
      },
    );
  });

  it("computes provenRemovable against the POST-delete state (owners emptied)", async () => {
    mockHostClient.request.mockResolvedValue({
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
        // Dirty -> not proven-removable, defaults unchecked.
        entry({
          worktreePath: "/wt/dirty",
          owners: [owner("epic-1")],
          uncommittedCount: 2,
        }),
        // Unproven branch status -> defaults unchecked.
        entry({
          worktreePath: "/wt/unknown",
          owners: [owner("epic-1")],
          branchStatus: null,
        }),
      ],
      nextCursor: null,
    });
    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.candidates).toHaveLength(4);
    });
    const byPath = new Map(
      result.current.candidates.map((c) => [c.worktreePath, c.provenRemovable]),
    );
    expect(byPath.get("/wt/tip")).toBe(true);
    expect(byPath.get("/wt/pr")).toBe(true);
    expect(byPath.get("/wt/dirty")).toBe(false);
    expect(byPath.get("/wt/unknown")).toBe(false);
    expect(mockHostClient.request).toHaveBeenCalledWith(
      "worktree.listAllForHost",
      {
        includeActivity: true,
        activityPaths: null,
        cursor: null,
        limit: 8,
        forceRefresh: false,
      },
    );
  });

  it("excludes in-use, ownerless, and out-of-scope worktrees", async () => {
    mockHostClient.request.mockResolvedValue({
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
      nextCursor: null,
    });
    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.candidates.map((c) => c.worktreePath)).toEqual([
        "/wt/ok",
      ]);
    });
  });

  // Regression: `listAllForHost` is the shared host-wide key, so React Query can
  // retain the last successful data after a failed refetch. A failed query must
  // never offer (possibly already deleted) stale worktree paths.
  it("suppresses candidates while the query is in an error state, even with retained data", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      hostQueryKeys.method<HostRpcRegistry, "worktree.listAllForHost">(
        "host-1",
        "worktree.listAllForHost",
        {
          includeActivity: true,
          activityPaths: null,
          cursor: null,
          limit: 8,
          // Must mirror the hook's cache identity exactly - the directive is
          // pinned to `false` in the key and never varies.
          forceRefresh: false,
        },
      ),
      { worktrees: [entry({ worktreePath: "/wt/a" })], nextCursor: null },
    );
    mockHostClient.request.mockRejectedValue(new Error("page failed"));
    const { result } = renderHook(
      () => useTaskDeleteWorktreeCandidates(["epic-1"]),
      { wrapper: wrapperFor(queryClient) },
    );
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.candidates).toEqual([]);
  });

  it("returns no candidates when the dialog is closed (null ids)", () => {
    mockHostClient.request.mockResolvedValue({
      worktrees: [entry({ worktreePath: "/wt/a" })],
      nextCursor: null,
    });
    const { result } = renderCandidates(null);
    expect(result.current.candidates).toEqual([]);
    expect(mockHostClient.request).not.toHaveBeenCalled();
  });
});
