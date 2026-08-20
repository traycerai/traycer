import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ListTasksResponse,
  ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import type { ListCloudTasksRequest } from "@/lib/cloud-epic-tasks-query";
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
    worktreeIndex: [] as readonly WorktreeHostEntryV12[],
    worktreeIndexError: null as Error | null,
    activityWorktrees: [] as readonly WorktreeHostEntryV12[],
    activityError: null as Error | null,
    taskContexts: new Map<string, ListTaskLight>(),
    taskContextsError: null as Error | null,
    chatHostSupport: "supported",
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  };
});

// The fake cloud applies the request's text query as a title filter, the way
// the real cloud task index does - so a query that only matches local
// worktree strings comes back empty from the "server" and must be satisfied
// by the id-fetched union.
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: (request: ListCloudTasksRequest) => {
    const query = request.filters?.query?.trim().toLowerCase() ?? "";
    const tasks =
      query.length === 0
        ? testState.tasks
        : testState.tasks.filter((task) =>
            (task.epic?.light?.title ?? task.phase?.light?.title ?? "")
              .toLowerCase()
              .includes(query),
          );
    return {
      hostId: "host-test",
      currentUserId: "user-1",
      tasks,
      query: {
        // Facets ride along even on the query branch: the real server computes
        // them for every FIRST page regardless of filters, and this query
        // never carries a cursor. Dropping them here would fake the
        // old-cloud-tier signal the host filter fails closed on.
        data:
          query.length === 0
            ? testState.response
            : { tasks, hasMore: false, facets: testState.response.facets },
        isPending: false,
        isFetching: testState.isFetching,
        isPlaceholderData: testState.isPlaceholderData,
        error: null,
        refetch: testState.refetch,
      },
      fetchNextPage: testState.fetchNextPage,
      hasNextPage: testState.hasNextPage,
      isFetchingNextPage: false,
    };
  },
}));

vi.mock("@/hooks/worktree/use-task-worktree-metadata-query", () => ({
  useTaskWorktreeMetadata: () => ({
    worktreesByEpicId: testState.worktreesByEpicId,
    isFetching: false,
    error: null,
  }),
  useWorktreeHostIndex: () => ({
    worktrees: testState.worktreeIndex,
    isFetching: false,
    error: testState.worktreeIndexError,
  }),
  // Mirrors the real hook: when disabled, both underlying queries are off, so
  // it reports no worktrees AND no error. Leaking an error through the
  // disabled path would let an error-handling regression pass unnoticed.
  useWorktreeHostActivityIndex: (enabled: boolean) => ({
    worktrees: enabled ? testState.activityWorktrees : [],
    isFetching: false,
    error: enabled ? testState.activityError : null,
  }),
}));

vi.mock("@/hooks/home/use-chat-host-filter-support", () => ({
  useChatHostFilterSupport: () => testState.chatHostSupport,
}));

vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: (taskIds: readonly string[]) => ({
    tasksById: new Map(
      taskIds.flatMap((taskId) => {
        const task = testState.taskContexts.get(taskId);
        return task === undefined ? [] : [[taskId, task] as const];
      }),
    ),
    isFetching: false,
    error: testState.taskContextsError,
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
    testState.worktreeIndex = [];
    testState.worktreeIndexError = null;
    testState.activityWorktrees = [];
    testState.activityError = null;
    testState.taskContexts = new Map();
    testState.taskContextsError = null;
    testState.chatHostSupport = "supported";
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
    expect(
      screen.getByRole("status", { name: "History titles" }).textContent,
    ).toBe("Alpha workbench|Beta search flow");

    rerender(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "beta ",
        })}
      />,
    );

    expect(screen.getByTestId("pending").textContent).toBe("false");
    expect(screen.getByTestId("fetching").textContent).toBe("true");
    expect(
      screen.getByRole("status", { name: "History titles" }).textContent,
    ).toBe("Beta search flow");
  });

  it("preserves the central last-viewed row order", () => {
    testState.tasks = [
      taskLight("epic-beta", "Beta search flow", "traycer/server"),
      taskLight("epic-alpha", "Alpha workbench", "traycer/gui-app"),
    ];
    testState.response = { tasks: testState.tasks, hasMore: false };

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          sort: "last-viewed",
          sortExplicit: true,
        })}
      />,
    );

    expect(
      screen.getByRole("status", { name: "History titles" }).textContent,
    ).toBe("Beta search flow|Alpha workbench");
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
    "unions a task matched by PR number %s via id fetch",
    (query) => {
      testState.activityWorktrees = [worktreeWithPullRequest(84)];
      testState.taskContexts = new Map([
        [
          "epic-beta",
          taskLight("epic-beta", "Beta search flow", "traycer/server"),
        ],
      ]);

      render(
        <HistoryQueryHarness
          search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
            query,
          })}
        />,
      );

      expect(
        screen.getByRole("status", { name: "History titles" }).textContent,
      ).toBe("Beta search flow");
    },
  );

  it("keeps pagination available for a settled PR query", () => {
    testState.hasNextPage = true;
    testState.activityWorktrees = [worktreeWithPullRequest(84)];
    testState.taskContexts = new Map([
      [
        "epic-beta",
        taskLight("epic-beta", "Beta search flow", "traycer/server"),
      ],
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

  it("unions a task matched by its worktree branch via id fetch", () => {
    testState.worktreeIndex = [worktreeWithPullRequest(84)];
    testState.taskContexts = new Map([
      [
        "epic-beta",
        taskLight("epic-beta", "Beta search flow", "traycer/server"),
      ],
    ]);

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "task-history",
        })}
      />,
    );

    expect(
      screen.getByRole("status", { name: "History titles" }).textContent,
    ).toBe("Beta search flow");
  });

  it("unions a task matched by its worktree directory name via id fetch", () => {
    testState.worktreeIndex = [
      {
        ...worktreeWithPullRequest(84),
        branch: null,
        worktreePath: "/worktrees/slot-rework-v2",
      },
    ];
    testState.taskContexts = new Map([
      [
        "epic-beta",
        taskLight("epic-beta", "Beta search flow", "traycer/server"),
      ],
    ]);

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "slot-rework-v2",
        })}
      />,
    );

    expect(
      screen.getByRole("status", { name: "History titles" }).textContent,
    ).toBe("Beta search flow");
  });

  it("appends branch-matched extras without hijacking the cloud title search", () => {
    // "flow" is a real title match for epic-beta on the cloud side AND a
    // branch match for epic-alpha's worktree. Both must appear: server rows
    // first, id-fetched extras appended.
    testState.worktreeIndex = [
      {
        ...worktreeWithPullRequest(84),
        branch: "flow-experiments",
        owners: [
          {
            epicId: "epic-alpha",
            ownerKind: "chat",
            ownerId: "chat-1",
            updatedAt: 1,
          },
        ],
      },
    ];
    testState.taskContexts = new Map([
      [
        "epic-alpha",
        taskLight("epic-alpha", "Alpha workbench", "traycer/gui-app"),
      ],
    ]);

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "flow",
        })}
      />,
    );

    expect(
      screen.getByRole("status", { name: "History titles" }).textContent,
    ).toBe("Beta search flow|Alpha workbench");
  });

  it("dedups a task matched by both the cloud query and a local worktree string", () => {
    testState.worktreeIndex = [
      { ...worktreeWithPullRequest(84), branch: "beta-live" },
    ];
    testState.taskContexts = new Map([
      [
        "epic-beta",
        taskLight("epic-beta", "Beta search flow", "traycer/server"),
      ],
    ]);

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "beta",
        })}
      />,
    );

    expect(
      screen.getByRole("status", { name: "History titles" }).textContent,
    ).toBe("Beta search flow");
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

    expect(
      screen.getByRole("status", { name: "History titles" }).textContent,
    ).toBe("Beta search flow|Alpha workbench");
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

    expect(
      screen.getByRole("status", { name: "History titles" }).textContent,
    ).toBe("Beta search flow|search");
  });

  it("surfaces a worktree activity failure for a PR-number search", () => {
    testState.activityError = new Error("Worktree activity probe failed");

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "#84",
        })}
      />,
    );

    expect(screen.getByTestId("error").textContent).toBe(
      "Worktree activity probe failed",
    );
  });

  it("degrades quietly when the worktree host index fails", () => {
    // The base index is enabled for EVERY query, so surfacing its failure
    // would put a worktree error on ordinary title searches. Branch matching
    // is an additive bonus: losing it must cost the cloud results nothing.
    testState.worktreeIndexError = new Error("Worktree index failed");

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "beta",
        })}
      />,
    );

    expect(screen.getByTestId("error").textContent).toBe("");
    expect(
      screen.getByRole("status", { name: "History titles" }).textContent,
    ).toBe("Beta search flow");
  });

  it("surfaces a task-context fetch failure", () => {
    testState.worktreeIndex = [worktreeWithPullRequest(84)];
    testState.taskContextsError = new Error("Task contexts failed");

    render(
      <HistoryQueryHarness
        search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
          query: "task-history",
        })}
      />,
    );

    expect(screen.getByTestId("error").textContent).toBe(
      "Task contexts failed",
    );
  });

  describe("chat-host filter", () => {
    const hostSearch: HistorySearchState = {
      ...DEFAULT_HISTORY_SEARCH,
      chatHosts: ["host-a"],
    };

    it("withholds rows when the host negotiated a minor that drops the filter", () => {
      // The response is well-formed and complete - that is exactly the
      // hazard. An old host strips `chatHostIds` and answers as if no filter
      // was asked for, so rendering these rows would present an UNFILTERED
      // list as a filtered one, with nothing anywhere reporting a problem.
      testState.chatHostSupport = "unsupported";
      render(<HistoryQueryHarness search={hostSearch} />);

      expect(screen.getByTestId("chat-host-unsupported").textContent).toBe(
        "true",
      );
      expect(
        screen.getByRole("status", { name: "History titles" }).textContent,
      ).toBe("");
    });

    it("withholds rows when the first page comes back without the chat-host facet", () => {
      // The cloud tier has no version negotiation of its own: an old server
      // simply drops request keys it does not recognize. A first page that
      // omits the `chatHosts` group is the only evidence of that, and it must
      // fail closed the same way the host arm does.
      testState.chatHostSupport = "supported";
      testState.response = {
        tasks: testState.tasks,
        hasMore: false,
        facets: {
          repos: [],
          workspaces: [],
          ownershipScopes: [],
        },
      };
      render(<HistoryQueryHarness search={hostSearch} />);

      expect(screen.getByTestId("chat-host-unsupported").textContent).toBe(
        "true",
      );
      expect(
        screen.getByRole("status", { name: "History titles" }).textContent,
      ).toBe("");
    });

    it("withholds rows when the response carries no facets object at all", () => {
      // This query never carries a cursor - "Show more" pages append through a
      // separate mutation and store - so its response is always a first page.
      // A first page with no facets is a server that never computed them, not
      // a later page that legitimately omits them.
      testState.chatHostSupport = "supported";
      testState.response = { tasks: testState.tasks, hasMore: false };
      render(<HistoryQueryHarness search={hostSearch} />);

      expect(screen.getByTestId("chat-host-unsupported").textContent).toBe(
        "true",
      );
      expect(
        screen.getByRole("status", { name: "History titles" }).textContent,
      ).toBe("");
    });

    it("serves rows and facet counts when both tiers can apply the filter", () => {
      testState.chatHostSupport = "supported";
      testState.response = {
        tasks: testState.tasks,
        hasMore: false,
        facets: {
          repos: [],
          workspaces: [],
          ownershipScopes: [],
          chatHosts: [{ hostId: "host-a", count: 2 }],
        },
      };
      render(<HistoryQueryHarness search={hostSearch} />);

      expect(screen.getByTestId("chat-host-unsupported").textContent).toBe(
        "false",
      );
      expect(screen.getByTestId("chat-host-facets").textContent).toBe(
        "host-a:2",
      );
      expect(
        screen.getByRole("status", { name: "History titles" }).textContent,
      ).toBe("Alpha workbench|Beta search flow");
    });

    it("host-filters an id-fetched worktree match instead of dropping the local search", () => {
      // A branch name lives only in local worktree metadata, so this row can
      // only arrive through the id-fetched union - which never passed the
      // server's host filter. The row carries its own visible chat hosts, so
      // the filter is re-applied here rather than the whole local arm being
      // switched off (which would make branch search silently return nothing
      // whenever a host was selected).
      const onHost = taskLight("epic-local", "Local only", "traycer/gui-app");
      testState.taskContexts = new Map([
        ["epic-local", { ...onHost, chatHostIds: ["host-a"] }],
      ]);
      testState.worktreeIndex = [
        {
          ...worktreeWithPullRequest(1),
          worktreePath: "/w/histogram",
          branch: "feature/histogram",
          owners: [
            {
              epicId: "epic-local",
              ownerKind: "chat",
              ownerId: "chat-local",
              updatedAt: 1,
            },
          ],
        },
      ];
      testState.response = {
        tasks: [],
        hasMore: false,
        facets: {
          repos: [],
          workspaces: [],
          ownershipScopes: [],
          chatHosts: [{ hostId: "host-a", count: 1 }],
        },
      };

      const { rerender } = render(
        <HistoryQueryHarness
          search={{ ...hostSearch, query: "feature/histogram" }}
        />,
      );
      expect(
        screen.getByRole("status", { name: "History titles" }).textContent,
      ).toBe("Local only");

      // The same search against a host the row does NOT have drops it.
      rerender(
        <HistoryQueryHarness
          search={{
            ...hostSearch,
            chatHosts: ["host-z"],
            query: "feature/histogram",
          }}
        />,
      );
      expect(
        screen.getByRole("status", { name: "History titles" }).textContent,
      ).toBe("");
    });
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
      <div role="status" aria-label="History titles">
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
      <div data-testid="chat-host-unsupported">
        {String(result.data?.chatHostFilterUnsupported ?? false)}
      </div>
      <div data-testid="chat-host-facets">
        {result.data?.facets.chatHosts
          ?.map((facet) => `${facet.hostId}:${facet.count}`)
          .join("|") ?? "none"}
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
