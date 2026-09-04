import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ListTasksCompleteness,
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
import { useAuthStore } from "@/stores/auth/auth-store";

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
    localHomedTaskIds: new Set<string>(),
    taskContextsError: null as Error | null,
    chatHostSupport: "supported",
    // The cloud hook's GUARDED refresh - the one `useHistoryQuery` must expose.
    refetch: vi.fn(),
    // TanStack's raw `query.refetch`, which overrides `enabled` and resets the
    // page identity before the verdict is consulted; History must never hand
    // this one out.
    rawRefetch: vi.fn(),
    fetchNextPage: vi.fn(),
    // T5a/T5b: `isCloudPagePending` and `completeness` are the two NEW
    // fields `useCloudEpicTasksQuery` exposes so `useHistoryQuery` can pass
    // them through as `cloudPagePending` / the union `data.completeness`.
    // Independent from `isFetching`/`response`: the producer this models is
    // the caller-owned-tombstone arm, whose page is `{tasks: [], hasMore:
    // false}` with `isFetching` already settled false - not a fetch in
    // progress.
    isCloudPagePending: false,
    completenessOverride: null as ListTasksCompleteness | null,
    initialLegRefused: false,
    // Otherwise-hardcoded `false` in the mock below, so a test asserting the
    // T18 refusal's `isPending: false` has something to distinguish it from -
    // without this, `query.isPending` never varies and that assertion would
    // pass whether or not the hook's own `!initialLegRefused && ...` guard
    // existed at all.
    queryIsPending: false,
    // T12: the `enabled` argument `useEpicGetTaskContexts` was actually
    // called with, most-recent last. The mock below otherwise ignores it (it
    // always returns `taskContexts` regardless), so asserting on the mock's
    // RESULT would pass whether or not `useHistoryQuery` gated the spend on
    // the cloud-authorization verdict - only capturing the argument proves it.
    taskContextsEnabledCalls: [] as boolean[],
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
        isPending: testState.queryIsPending,
        isFetching: testState.isFetching,
        isPlaceholderData: testState.isPlaceholderData,
        error: null,
        refetch: testState.rawRefetch,
      },
      refetch: testState.refetch,
      fetchNextPage: testState.fetchNextPage,
      hasNextPage: testState.hasNextPage,
      isFetchingNextPage: false,
      initialLegRefused: testState.initialLegRefused,
      isCloudPagePending: testState.isCloudPagePending,
      // The UNION statement, deliberately independent of `query.data`'s own
      // `completeness` above (T5b) - `useHistoryQuery` must read this field,
      // not `tasksQuery.data.completeness`, for the exposed `data.completeness`.
      completeness: testState.completenessOverride,
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
  useEpicGetTaskContexts: (
    taskIds: readonly string[],
    _userId: string | null,
    options: { readonly enabled: boolean },
  ) => {
    testState.taskContextsEnabledCalls.push(options.enabled);
    return {
      tasksById: new Map(
        taskIds.flatMap((taskId) => {
          const task = testState.taskContexts.get(taskId);
          return task === undefined ? [] : [[taskId, task] as const];
        }),
      ),
      // `epic.getTaskContexts@1.2`'s sibling home-marker list. Kept on the fake
      // because the projection now READS it - a context-only hit is the one path
      // where nothing else can say the epic is local-homed.
      localHomedTaskIds: testState.localHomedTaskIds,
      isFetching: false,
      error: testState.taskContextsError,
    };
  },
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
    testState.localHomedTaskIds = new Set<string>();
    testState.chatHostSupport = "supported";
    testState.refetch.mockReset();
    testState.rawRefetch.mockReset();
    testState.fetchNextPage.mockReset();
    testState.isCloudPagePending = false;
    testState.completenessOverride = null;
    testState.initialLegRefused = false;
    testState.queryIsPending = false;
    testState.taskContextsEnabledCalls = [];
    // `useEpicGetTaskContexts` is gated on `authorizesCloudCapability`, read
    // off the REAL store (not mocked in this file) - default to `signed-in`
    // so every pre-existing test here keeps exercising the id-fetched union
    // exactly as before. The T12 test below overrides this per case.
    useAuthStore.setState({ status: "signed-in" });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // Zustand stores are module scope, so a status staged here outlives this
    // file inside the same worker.
    useAuthStore.setState({ status: "signed-out" });
  });

  it("exposes the cloud hook's guarded refetch, never the raw query's", () => {
    // TanStack's `query.refetch` overrides `enabled` and resets the page
    // identity before the dispatch-time verdict check can refuse the cloud
    // leg, so a pull-to-refresh holding it across a demotion discarded every
    // retained cursor page for a request it never sent. History must hand out
    // the hook's own callback, which re-reads the verdict at dispatch.
    render(<HistoryQueryHarness search={DEFAULT_HISTORY_SEARCH} />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(testState.refetch).toHaveBeenCalledTimes(1);
    expect(testState.rawRefetch).not.toHaveBeenCalled();
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

  describe("cloud page pending", () => {
    // T5a: `cloudPagePending` is passed through from `isCloudPagePending`,
    // independent of `isFetching` and of whether `tasks`/`items` are empty.
    // The producer this models is the host resolver's caller-owned-tombstone
    // arm - a `{tasks: [], hasMore: false}` page for an account nobody has
    // finished asking about, with `isFetching` already settled false (the
    // follow-up revalidation runs under its own ephemeral query key and is
    // invisible to `isFetching`). Building the fixture as a "pristine
    // cloud-only account" was disproved
    // (`traycer-host/src/transport/rpc/__tests__/epic-list-tasks-discovery.test.ts:249-288`
    // shows such an account WAITS for cloud instead), so this deliberately
    // pairs the pending flag with settled-empty rows rather than an
    // in-flight fetch.
    it("stays true while the local-first revalidation leg is outstanding, even with settled empty rows", () => {
      testState.tasks = [];
      testState.response = { tasks: [], hasMore: false };
      testState.isFetching = false;
      testState.isCloudPagePending = true;

      render(<HistoryQueryHarness search={DEFAULT_HISTORY_SEARCH} />);

      expect(screen.getByTestId("fetching").textContent).toBe("false");
      expect(screen.getByTestId("cloud-page-pending").textContent).toBe("true");
      expect(
        screen.getByRole("status", { name: "History titles" }).textContent,
      ).toBe("");
    });

    it("clears once the follow-up settles (or fails)", () => {
      testState.isCloudPagePending = false;

      render(<HistoryQueryHarness search={DEFAULT_HISTORY_SEARCH} />);

      expect(screen.getByTestId("cloud-page-pending").textContent).toBe(
        "false",
      );
    });
  });

  describe("completeness union", () => {
    // T5b: `data.completeness` must be the union `useCloudEpicTasksQuery`
    // computes across the first page AND every retained "Show more" tail
    // (`unionCompleteness`/`mergeCompleteness` in
    // `hooks/epics/use-cloud-epic-tasks-query.ts`), never the first page's
    // own `completeness` alone. The mock deliberately gives the first page
    // and the union DIFFERENT statements so a regression that reads
    // `tasksQuery.data.completeness` instead of the hook's `completeness`
    // field would fail this assertion.
    it("exposes the worst-of union rather than the first page's own statement", () => {
      testState.response = {
        tasks: testState.tasks,
        hasMore: false,
        completeness: {
          cloudPage: "settled",
          facets: "server",
          localRows: "none",
          sort: "server",
        },
      };
      testState.completenessOverride = {
        cloudPage: "unavailable",
        facets: "partial",
        localRows: "truncated",
        sort: "loaded-union",
      };

      render(<HistoryQueryHarness search={DEFAULT_HISTORY_SEARCH} />);

      expect(screen.getByTestId("completeness").textContent).toBe(
        "unavailable|partial|truncated|loaded-union",
      );
    });

    it("unions a locally-held workspace and repo into the available filter options when the union reports partial facets", () => {
      testState.tasks = [
        taskLight("epic-alpha", "Alpha workbench", "traycer/gui-app"),
      ];
      testState.response = {
        tasks: testState.tasks,
        hasMore: false,
        facets: {
          repos: [
            { repoIdentifier: { owner: "traycer", repo: "gui-app" }, count: 1 },
          ],
          workspaces: [
            {
              workspaceIdentifier: {
                hostId: "host-1",
                workspacePath: "/server-only",
              },
              count: 1,
            },
          ],
          ownershipScopes: [],
        },
      };
      testState.completenessOverride = {
        cloudPage: "unavailable",
        facets: "partial",
        localRows: "truncated",
        sort: "loaded-union",
      };
      testState.worktreeIndex = [
        {
          ...worktreeWithPullRequest(1),
          worktreePath: "/w/local-only",
          branch: "feature/local-only-workspace",
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
      // Local-only labels that sort BEFORE the server counterparts. A fixture
      // that was already alphabetical cannot tell server-first union from a
      // full re-sort, so only this order makes `dedupSortWorkspaces` fail.
      const localTask = taskLight(
        "epic-local",
        "Local only workspace",
        "aaa/local-repo",
      );
      if (localTask.epic === undefined || localTask.epic === null) {
        throw new Error("Expected epic on local task fixture");
      }
      testState.taskContexts = new Map([
        [
          "epic-local",
          {
            ...localTask,
            epic: {
              ...localTask.epic,
              workspaces: [
                {
                  task: null,
                  hostId: "aaa-host",
                  workspacePath: "/aaa-local",
                  createdAt: 0,
                },
              ],
            },
          },
        ],
      ]);

      render(
        <HistoryQueryHarness
          search={patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
            query: "feature/local-only-workspace",
          })}
        />,
      );

      expect(screen.getByTestId("available-workspaces").textContent).toBe(
        "host-1:/server-only|aaa-host:/aaa-local",
      );
      expect(screen.getByTestId("available-repos").textContent).toBe(
        "traycer/gui-app|aaa/local-repo",
      );
    });
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

  // T12: `epic.getTaskContexts` is a CLOUD spend for the ids an id-fetched
  // worktree/PR match surfaces. `currentUserId` is the WIDENED identity
  // (`unverified` resolves one too, so History keeps rendering this
  // machine's own epics), so it cannot double as this batch's authorization -
  // the hook must gate `enabled` on `authorizesCloudCapability` separately.
  it("gates the task-context batch's enabled flag on the cloud-authorization verdict, not on search activity", () => {
    useAuthStore.setState({ status: "unverified" });
    const { rerender } = render(
      <HistoryQueryHarness search={DEFAULT_HISTORY_SEARCH} />,
    );
    expect(testState.taskContextsEnabledCalls.at(-1)).toBe(false);

    useAuthStore.setState({ status: "signed-in" });
    rerender(<HistoryQueryHarness search={DEFAULT_HISTORY_SEARCH} />);
    expect(testState.taskContextsEnabledCalls.at(-1)).toBe(true);
  });

  // T18: `useCloudEpicTasksQuery`'s `initialLegRefused` maps to a SETTLED
  // empty result, not `undefined` (which every render site here treats as
  // still loading). Ahead of the `tasksQuery.data === undefined` guard in the
  // `data` memo for exactly that reason - the refusal PRODUCES that
  // `undefined`, so checking it first would misread the refusal as a load in
  // progress and never reach `hostRequiresCloudToList` at all.
  it("settles to an empty, non-pending page and flags hostRequiresCloudToList when the initial leg is refused", () => {
    testState.initialLegRefused = true;
    // The underlying TanStack query for a refused leg is disabled and reports
    // `isPending: true` forever - this models that, so the assertion below
    // proves `useHistoryQuery` overrides it rather than merely inheriting an
    // already-false value from the mock.
    testState.queryIsPending = true;
    render(<HistoryQueryHarness search={DEFAULT_HISTORY_SEARCH} />);

    expect(screen.getByTestId("host-requires-cloud-to-list").textContent).toBe(
      "true",
    );
    // The false statement this exists to prevent: a query that never ran
    // reports `status: "pending"` forever, which the render sites read as a
    // permanent skeleton.
    expect(screen.getByTestId("pending").textContent).toBe("false");
    expect(
      screen.getByRole("status", { name: "History titles" }).textContent,
    ).toBe("");
  });
});

/**
 * Project an optional list of already-formatted parts into one assertable
 * string. Every readout below is the same "map then join, or say nothing"
 * shape, and inlining the `?? fallback` at each of them is what put this
 * harness over the complexity ceiling.
 */
function joined(
  parts: ReadonlyArray<string> | undefined,
  fallback: string,
): string {
  return parts === undefined ? fallback : parts.join("|");
}

function HistoryQueryHarness(props: {
  readonly search: HistorySearchState;
}): ReactElement {
  const result = useHistoryQuery({ search: props.search, nowMs: null });
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void result.refetch();
        }}
      >
        Refresh
      </button>
      <div data-testid="pending">{String(result.isPending)}</div>
      <div data-testid="fetching">{String(result.isFetching)}</div>
      <div data-testid="host-requires-cloud-to-list">
        {String(result.data?.hostRequiresCloudToList ?? false)}
      </div>
      <div data-testid="error">{result.error?.message ?? ""}</div>
      <div data-testid="has-next-page">{String(result.hasNextPage)}</div>
      <div role="status" aria-label="History titles">
        {joined(
          result.data?.items.map((item) => item.title),
          "",
        )}
      </div>
      <div data-testid="repo-facets">
        {joined(
          result.data?.facets.repos.map(
            (facet) => `${facet.label}:${facet.count}`,
          ),
          "",
        )}
      </div>
      <div data-testid="workspace-facets">
        {joined(
          result.data?.facets.workspaces.map(
            (facet) =>
              `${facet.workspace.hostId}:${facet.workspace.workspacePath}:${facet.count}`,
          ),
          "",
        )}
      </div>
      <div data-testid="chat-host-unsupported">
        {String(result.data?.chatHostFilterUnsupported ?? false)}
      </div>
      <div data-testid="chat-host-facets">
        {joined(
          result.data?.facets.chatHosts?.map(
            (facet) => `${facet.hostId}:${facet.count}`,
          ),
          "none",
        )}
      </div>
      <div data-testid="ownership-facets">
        {joined(
          result.data?.facets.ownershipScopes.map(
            (facet) => `${facet.value}:${facet.count}`,
          ),
          "",
        )}
      </div>
      <div data-testid="cloud-page-pending">
        {String(result.cloudPagePending)}
      </div>
      <div data-testid="completeness">
        {(() => {
          const completeness = result.data?.completeness;
          if (completeness === null || completeness === undefined) return "";
          return [
            completeness.cloudPage,
            completeness.facets,
            completeness.localRows,
            completeness.sort,
          ].join("|");
        })()}
      </div>
      <div data-testid="available-workspaces">
        {joined(
          result.data?.availableWorkspaces.map(
            (workspace) => `${workspace.hostId}:${workspace.workspacePath}`,
          ),
          "",
        )}
      </div>
      <div data-testid="available-repos">
        {joined(result.data?.availableRepos, "")}
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
