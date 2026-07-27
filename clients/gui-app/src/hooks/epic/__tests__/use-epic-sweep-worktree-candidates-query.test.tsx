import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEpicSweepWorktreeCandidates } from "@/hooks/epic/use-epic-sweep-worktree-candidates-query";

interface StubOwner {
  readonly epicId: string;
  readonly ownerKind: "chat" | "terminal-agent";
  readonly ownerId: string;
  readonly updatedAt: number;
}

interface StubEntry {
  readonly worktreePath: string;
  readonly repoLabel: string;
  readonly branch: string | null;
  readonly uncommittedCount: number;
  readonly inUse: boolean;
  readonly gitRemovable: boolean;
  readonly owners: ReadonlyArray<StubOwner>;
  readonly branchStatus: {
    readonly ahead: number | null;
    readonly behind: number | null;
    readonly mergedIntoDefault: boolean;
  } | null;
  readonly prState: "merged" | "open" | "closed" | "none" | null;
  readonly mergedHeadShaMatches: boolean;
  readonly submodules: ReadonlyArray<never>;
  readonly atBaseCommit: boolean;
  readonly resolvedAt: number | null;
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
    resolvedAt: 1,
    ...over,
  };
}

const BASE_WALK_PARAMS = {
  includeActivity: false,
  activityPaths: null,
  cursor: null,
  limit: null,
  forceRefresh: false,
} as const;

function forcedProbeParams(activityPaths: readonly string[]) {
  return {
    includeActivity: true,
    activityPaths,
    cursor: null,
    limit: null,
    forceRefresh: true,
  };
}

/**
 * Wires the two-request act-time flow: the un-probed base walk returns
 * `baseEntries` (owner discovery only), the forced selection-mode probe
 * returns `probedEntries` (the rows the dialog derives from).
 */
function mockActTimeProbe(
  baseEntries: ReadonlyArray<StubEntry>,
  probedEntries: ReadonlyArray<StubEntry>,
): void {
  mockHostClient.request.mockImplementation(
    (method: string, params: { readonly forceRefresh: boolean }) => {
      if (method !== "worktree.listAllForHost") {
        throw new Error(`unexpected method ${method}`);
      }
      return Promise.resolve({
        worktrees: params.forceRefresh ? probedEntries : baseEntries,
        nextCursor: null,
      });
    },
  );
}

function wrapperFor(queryClient: QueryClient) {
  return (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function renderCandidates(epicId: string | null) {
  const queryClient = new QueryClient();
  return renderHook(() => useEpicSweepWorktreeCandidates(epicId), {
    wrapper: wrapperFor(queryClient),
  });
}

describe("useEpicSweepWorktreeCandidates", () => {
  beforeEach(() => {
    mockHostClient.request.mockReset();
  });

  it("lists EVERY task-owned worktree from the forced probe, pre-checking only greens", async () => {
    mockActTimeProbe(
      [
        entry({ worktreePath: "/wt/landed" }),
        entry({ worktreePath: "/wt/base" }),
        entry({ worktreePath: "/wt/review" }),
        entry({ worktreePath: "/wt/foreign", owners: [owner("epic-2")] }),
      ],
      [
        // Proven landed via validated PR -> merged tier, default-checked.
        entry({
          worktreePath: "/wt/landed",
          prState: "merged",
          mergedHeadShaMatches: true,
        }),
        // Never advanced from its birth commit -> at-base-commit, checked.
        entry({ worktreePath: "/wt/base", atBaseCommit: true }),
        // Unproven -> review tier: LISTED, unchecked, checkable.
        entry({ worktreePath: "/wt/review" }),
      ],
    );
    const { result } = renderCandidates("epic-1");
    await waitFor(() => {
      expect(result.current.rows).toHaveLength(3);
    });
    const byPath = new Map(
      result.current.rows.map((row) => [row.entry.worktreePath, row]),
    );
    expect(byPath.get("/wt/landed")).toMatchObject({
      tier: "merged",
      defaultChecked: true,
      disabled: false,
      note: null,
    });
    expect(byPath.get("/wt/base")).toMatchObject({
      tier: "at-base-commit",
      defaultChecked: true,
      disabled: false,
      note: null,
    });
    expect(byPath.get("/wt/review")).toMatchObject({
      tier: "review",
      defaultChecked: false,
      disabled: false,
      note: "not-landed",
    });
    // The wire shape of the act-time proof: one cheap owner-discovery walk,
    // then ONE forced probe scoped to exactly the Task-owned paths (the
    // foreign worktree is never probed nor listed).
    expect(mockHostClient.request).toHaveBeenNthCalledWith(
      1,
      "worktree.listAllForHost",
      BASE_WALK_PARAMS,
    );
    expect(mockHostClient.request).toHaveBeenNthCalledWith(
      2,
      "worktree.listAllForHost",
      forcedProbeParams(["/wt/landed", "/wt/base", "/wt/review"]),
    );
    expect(mockHostClient.request).toHaveBeenCalledTimes(2);
  });

  it("catches freshly-dirtied worktrees the cached listing still calls clean", async () => {
    // The stale-clean data-loss window this hook exists to close: the base
    // walk (host cache) still believes the worktree is clean+landed, but the
    // forced re-derive discovers uncommitted changes -> listed unchecked.
    mockActTimeProbe(
      [
        entry({
          worktreePath: "/wt/was-clean",
          prState: "merged",
          mergedHeadShaMatches: true,
        }),
      ],
      [
        entry({
          worktreePath: "/wt/was-clean",
          prState: "merged",
          mergedHeadShaMatches: true,
          uncommittedCount: 2,
        }),
      ],
    );
    const { result } = renderCandidates("epic-1");
    await waitFor(() => {
      expect(result.current.rows).toHaveLength(1);
    });
    expect(result.current.rows[0]).toMatchObject({
      tier: "review",
      defaultChecked: false,
      disabled: false,
      note: "not-landed",
    });
  });

  it("marks shared rows checkable-unchecked and busy/unresolved rows disabled", async () => {
    const probed = [
      entry({
        worktreePath: "/wt/shared",
        owners: [owner("epic-1"), owner("epic-2")],
        prState: "merged",
        mergedHeadShaMatches: true,
      }),
      entry({
        worktreePath: "/wt/busy",
        inUse: true,
        prState: "merged",
        mergedHeadShaMatches: true,
      }),
      entry({
        worktreePath: "/wt/probing",
        resolvedAt: null,
        atBaseCommit: true,
      }),
    ];
    mockActTimeProbe(probed, probed);
    const { result } = renderCandidates("epic-1");
    await waitFor(() => {
      expect(result.current.rows).toHaveLength(3);
    });
    const byPath = new Map(
      result.current.rows.map((row) => [row.entry.worktreePath, row]),
    );
    expect(byPath.get("/wt/shared")).toMatchObject({
      defaultChecked: false,
      disabled: false,
      note: "shared",
    });
    expect(byPath.get("/wt/busy")).toMatchObject({
      defaultChecked: false,
      disabled: true,
      note: "in-use",
    });
    expect(byPath.get("/wt/probing")).toMatchObject({
      defaultChecked: false,
      disabled: true,
      note: "checking",
    });
  });

  it("skips the forced probe entirely when the Task owns no worktrees", async () => {
    mockActTimeProbe(
      [entry({ worktreePath: "/wt/foreign", owners: [owner("epic-2")] })],
      [],
    );
    const { result } = renderCandidates("epic-1");
    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
    expect(result.current.rows).toEqual([]);
    // Only the base walk ran - no forced probe for an empty path set.
    expect(mockHostClient.request).toHaveBeenCalledTimes(1);
    expect(mockHostClient.request).toHaveBeenCalledWith(
      "worktree.listAllForHost",
      BASE_WALK_PARAMS,
    );
  });

  it("yields zero rows on a failed probe (failure -> no candidates)", async () => {
    mockHostClient.request.mockRejectedValue(new Error("probe failed"));
    const { result } = renderCandidates("epic-1");
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.rows).toEqual([]);
  });

  it("stays disabled while the dialog is closed (null epicId)", () => {
    mockActTimeProbe(
      [entry({ worktreePath: "/wt/a", atBaseCommit: true })],
      [],
    );
    const { result } = renderCandidates(null);
    expect(result.current.rows).toEqual([]);
    expect(result.current.isPending).toBe(false);
    expect(mockHostClient.request).not.toHaveBeenCalled();
  });
});
