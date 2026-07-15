import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ListTasksResponse,
  ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import {
  DEFAULT_HISTORY_SEARCH,
  patchHistorySearch,
} from "@/lib/history-search";
import type { HistorySearchState } from "@/lib/history-search";
import { useHistoryQuery } from "@/hooks/home/use-history-query";

const testState = vi.hoisted(() => {
  const tasks: ListTaskLight[] = [];
  const response: ListTasksResponse = {
    tasks,
    hasMore: false,
  };
  return {
    tasks,
    response,
    isFetching: false,
    isPlaceholderData: false,
    hasNextPage: false,
    worktreesByEpicId: new Map<string, readonly WorktreeHostEntryV12[]>(),
    worktreeMetadataError: null as Error | null,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  };
});

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({
    hostId: "host-test",
    currentUserId: "user-1",
    tasks: testState.tasks,
    query: {
      data: testState.response,
      isPending: false,
      isFetching: testState.isFetching,
      isPlaceholderData: testState.isPlaceholderData,
      error: null,
      refetch: testState.refetch,
    },
    fetchNextPage: testState.fetchNextPage,
    hasNextPage: testState.hasNextPage,
    isFetchingNextPage: false,
  }),
}));

vi.mock("@/hooks/worktree/use-task-worktree-metadata-query", () => ({
  useTaskWorktreeMetadata: () => ({
    worktreesByEpicId: testState.worktreesByEpicId,
    isFetching: false,
    error: testState.worktreeMetadataError,
  }),
}));

describe("useHistoryQuery", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-04-22T12:00:00.000Z"),
    );
    testState.tasks = [
      taskLight("epic-alpha", "Alpha workbench", "traycer/gui-app"),
      taskLight("epic-beta", "Beta search flow", "traycer/server"),
    ];
    testState.response = { tasks: testState.tasks, hasMore: false };
    testState.isFetching = false;
    testState.isPlaceholderData = false;
    testState.hasNextPage = false;
    testState.worktreesByEpicId = new Map();
    testState.worktreeMetadataError = null;
    testState.refetch.mockReset();
    testState.fetchNextPage.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("locally narrows existing rows while a new search query is debouncing", () => {
    const { rerender } = render(
      <HistoryQueryHarness search={DEFAULT_HISTORY_SEARCH} />,
    );

    expect(screen.getByTestId("pending").textContent).toBe("false");
    expect(screen.getByTestId("fetching").textContent).toBe("false");
    expect(screen.getByTestId("titles").textContent).toBe(
      "Alpha workbench|Beta search flow",
    );

    rerender(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "beta ",
        })}
      />,
    );

    expect(screen.getByTestId("pending").textContent).toBe("false");
    expect(screen.getByTestId("fetching").textContent).toBe("true");
    expect(screen.getByTestId("titles").textContent).toBe("Beta search flow");
  });

  it("does not expose stale facet counts while projecting placeholder rows", () => {
    testState.response = {
      tasks: testState.tasks,
      hasMore: false,
      facets: {
        repos: [
          {
            repoIdentifier: { owner: "traycer", repo: "gui-app" },
            count: 37,
          },
        ],
        workspaces: [
          {
            workspaceIdentifier: {
              hostId: "host-1",
              workspacePath: "/Users/me/gui-app",
            },
            count: 37,
          },
        ],
        ownershipScopes: [
          { value: "mine", count: 37 },
          { value: "shared", count: 2 },
        ],
      },
    };
    testState.isFetching = true;
    testState.isPlaceholderData = true;

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          ownershipScopes: ["shared"],
        })}
      />,
    );

    expect(screen.getByTestId("repo-facets").textContent).toBe("");
    expect(screen.getByTestId("workspace-facets").textContent).toBe("");
    expect(screen.getByTestId("ownership-facets").textContent).toBe("");
  });

  it.each(["84", "#84", "PR #84"])(
    "locally matches a task by enriched PR query %s",
    (query) => {
      testState.worktreesByEpicId = new Map([
        ["epic-beta", [worktreeWithPullRequest(84)]],
      ]);

      render(
        <HistoryQueryHarness
          search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
            query,
          })}
        />,
      );

      expect(screen.getByTestId("titles").textContent).toBe("Beta search flow");
    },
  );

  it("keeps pagination available for a settled PR query", () => {
    testState.hasNextPage = true;
    testState.worktreesByEpicId = new Map([
      ["epic-beta", [worktreeWithPullRequest(84)]],
    ]);

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "#84",
        })}
      />,
    );

    expect(screen.getByTestId("has-next-page").textContent).toBe("true");
  });

  it("lifts an optimistically pinned row above unpinned rows in the settled server order", () => {
    // An optimistic pin patch flips the cached row's bit in place, so the
    // settled (non-projecting) path must partition pinned-first itself
    // instead of trusting the raw cached order, which still reflects the
    // pre-pin state.
    testState.tasks = [
      taskLight("epic-alpha", "Alpha workbench", "traycer/gui-app"),
      {
        ...taskLight("epic-beta", "Beta search flow", "traycer/server"),
        pinned: true,
      },
    ];
    testState.response = { tasks: testState.tasks, hasMore: false };

    render(<HistoryQueryHarness search={DEFAULT_HISTORY_SEARCH} />);

    expect(screen.getByTestId("titles").textContent).toBe(
      "Beta search flow|Alpha workbench",
    );
  });

  it("floats pinned rows above a higher-relevance unpinned match under relevance sort", () => {
    // Relevance sort + a non-empty query is the only path that routes through
    // prioritizePinnedHistoryItems (use-history-query.ts). That local
    // projection only runs while the cloud query is unsettled, so mark it
    // fetching. The unpinned row is the exact-title match, so Fuse ranks it
    // first; the pin must still lift its (weaker-matching) row above it.
    testState.isFetching = true;
    testState.tasks = [
      taskLight("epic-exact", "search", "traycer/gui-app"),
      {
        ...taskLight("epic-pinned", "Beta search flow", "traycer/server"),
        pinned: true,
      },
    ];
    testState.response = { tasks: testState.tasks, hasMore: false };

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "search",
          sort: "relevance",
        })}
      />,
    );

    expect(screen.getByTestId("titles").textContent).toBe(
      "Beta search flow|search",
    );
  });

  it("surfaces a worktree metadata failure for a PR-number search", () => {
    testState.worktreeMetadataError = new Error("Worktree metadata failed");

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "#84",
        })}
      />,
    );

    expect(screen.getByTestId("error").textContent).toBe(
      "Worktree metadata failed",
    );
  });
});

function HistoryQueryHarness(props: {
  readonly search: HistorySearchState;
}): ReactElement {
  const result = useHistoryQuery({ search: props.search, nowMs: null });
  return (
    <div>
      <div data-testid="pending">{String(result.isPending)}</div>
      <div data-testid="fetching">{String(result.isFetching)}</div>
      <div data-testid="error">{result.error?.message ?? ""}</div>
      <div data-testid="has-next-page">{String(result.hasNextPage)}</div>
      <div data-testid="titles">
        {result.data?.items.map((item) => item.title).join("|") ?? ""}
      </div>
      <div data-testid="repo-facets">
        {result.data?.facets.repos
          .map((facet) => `${facet.label}:${facet.count}`)
          .join("|") ?? ""}
      </div>
      <div data-testid="workspace-facets">
        {result.data?.facets.workspaces
          .map(
            (facet) =>
              `${facet.workspace.hostId}:${facet.workspace.workspacePath}:${facet.count}`,
          )
          .join("|") ?? ""}
      </div>
      <div data-testid="ownership-facets">
        {result.data?.facets.ownershipScopes
          .map((facet) => `${facet.value}:${facet.count}`)
          .join("|") ?? ""}
      </div>
    </div>
  );
}

function taskLight(id: string, title: string, repo: string): ListTaskLight {
  const [owner, repoName] = repo.split("/");
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: Date.parse("2026-04-22T10:00:00.000Z"),
        updatedAt: Date.parse("2026-04-22T11:00:00.000Z"),
        createdBy: "user-1",
        version: "1.0.0",
      },
      permission: null,
      repos: [
        {
          task: { taskId: id, taskType: "epic" },
          repoIdentifier: {
            owner,
            repo: repoName,
          },
          createdAt: Date.parse("2026-04-22T10:00:00.000Z"),
          createdBy: "user-1",
        },
      ],
      workspaces: [],
      roomInfo: null,
    },
    pinned: false,
  };
}

function worktreeWithPullRequest(prNumber: number): WorktreeHostEntryV12 {
  return {
    worktreePath: "/worktrees/task-history",
    repoLabel: "traycer/gui-app",
    repoIdentifier: { owner: "traycer", repo: "gui-app" },
    branch: "task-history",
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    lastActivityAt: null,
    owners: [
      {
        epicId: "epic-beta",
        ownerKind: "chat",
        ownerId: "chat-1",
        updatedAt: 1,
      },
    ],
    branchStatus: null,
    createdAt: null,
    prState: "open",
    prNumber,
    prUrl: `https://github.com/traycer/gui-app/pull/${prNumber}`,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
  };
}
