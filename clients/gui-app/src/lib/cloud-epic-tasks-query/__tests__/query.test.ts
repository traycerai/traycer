import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type { HistorySearchState } from "@/lib/history-search";
import {
  DEFAULT_HISTORY_SEARCH,
  parseHistorySearch,
} from "@/lib/history-search";
import {
  cloudEpicTasksQueryKey,
  listCloudTasksRequestForHistorySearch,
} from "@/lib/cloud-epic-tasks-query";

describe("listCloudTasksRequestForHistorySearch", () => {
  it("builds a type-safe server request from typed history search state", () => {
    const search = parseHistorySearch({
      historyQuery: "api",
      historyRepos: ["traycer/gui-app", "invalid/repo/label"],
      historyRepoMode: "all",
      historyWorkspaces: ["host-1:%2FUsers%2Fme%2Fgui-app"],
      historyWorkspaceMode: "all",
      historyOwnership: ["mine"],
      historySort: "title-asc",
    });

    expect(listCloudTasksRequestForHistorySearch(search)).toMatchObject({
      limit: 20,
      sort: "title-asc",
      filters: {
        query: "api",
        repoIdentifiers: [{ owner: "traycer", repo: "gui-app" }],
        repoMatchMode: "all",
        workspaceIdentifiers: [
          {
            hostId: "host-1",
            workspacePath: "/Users/me/gui-app",
          },
        ],
        workspaceMatchMode: "all",
        ownershipScopes: ["mine"],
      },
    });
  });

  it("requests central last-viewed sorting", () => {
    const search = parseHistorySearch({ historySort: "last-viewed" });

    expect(listCloudTasksRequestForHistorySearch(search).sort).toBe(
      "last-viewed",
    );
  });

  it("canonicalizes reverse-order repository and workspace selections to the same request and query key", () => {
    // Mirrors ambient modal state (`withToggledValue` / `withToggledWorkspace`),
    // which preserves toggle order rather than sorting - unlike
    // `parseHistorySearch`, which sorts on every URL round-trip and would mask
    // this. Selecting z/repo then a/repo (and the matching workspaces) must
    // produce the identical request/query key as selecting them in display
    // order, so the two identical filters share one cache identity.
    const forwardOrder: HistorySearchState = {
      ...DEFAULT_HISTORY_SEARCH,
      repos: ["a/repo", "z/repo"],
      workspaces: [
        { hostId: "host-a", workspacePath: "/a" },
        { hostId: "host-z", workspacePath: "/z" },
      ],
      ownershipScopes: ["mine", "shared"],
    };
    const reverseOrder: HistorySearchState = {
      ...DEFAULT_HISTORY_SEARCH,
      repos: ["z/repo", "a/repo"],
      workspaces: [
        { hostId: "host-z", workspacePath: "/z" },
        { hostId: "host-a", workspacePath: "/a" },
      ],
      ownershipScopes: ["shared", "mine"],
    };

    const forwardRequest = listCloudTasksRequestForHistorySearch(forwardOrder);
    const reverseRequest = listCloudTasksRequestForHistorySearch(reverseOrder);

    expect(reverseRequest).toEqual(forwardRequest);
    expect(cloudEpicTasksQueryKey("host-1", "user-1", reverseRequest)).toEqual(
      cloudEpicTasksQueryKey("host-1", "user-1", forwardRequest),
    );

    // Prove the two orders actually resolve to one TanStack Query cache entry
    // (not just deep-equal key arrays): settle rows under the forward-order
    // key, then read them back through the reverse-order key.
    const queryClient = new QueryClient();
    const settledPage: ListTasksResponse = { tasks: [], hasMore: false };
    queryClient.setQueryData(
      cloudEpicTasksQueryKey("host-1", "user-1", forwardRequest),
      settledPage,
    );
    expect(
      queryClient.getQueryData(
        cloudEpicTasksQueryKey("host-1", "user-1", reverseRequest),
      ),
    ).toBe(settledPage);
  });
});
