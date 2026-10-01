import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type { HistorySearchState } from "@/lib/history-search";
import {
  DEFAULT_HISTORY_SEARCH,
  parseHistorySearch,
} from "@/lib/history-search";
import {
  __resetCloudEpicTasksClientsForTests,
  cloudEpicTasksFirstPageQueryOptions,
  cloudEpicTasksQueryKey,
  LIST_CLOUD_TASKS_REQUEST,
  listCloudTasksRequestForHistorySearch,
  registerCloudEpicTasksClient,
} from "@/lib/cloud-epic-tasks-query";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useAuthStore } from "@/stores/auth/auth-store";

const USER_ID = "user-1";
const USER_PROFILE = {
  userId: USER_ID,
  userName: "User 1",
  email: "user-1@example.test",
};
const USER_CONTEXT = { userId: USER_ID, username: USER_ID };

function requestContextFor(userId: string) {
  return createRequestContextFixture({
    identity: { userId, username: userId, providerHandle: null },
    origin: "renderer",
  });
}

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

  it("refetches an invalidated inactive page when History remounts", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const pages: ListTasksResponse[] = [
      { tasks: [], hasMore: false },
      { tasks: [], hasMore: true },
    ];
    let dispatchCount = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "cloud-epic-tasks-query",
      handlers: {
        "epic.listTasks": () => {
          const page = pages.at(dispatchCount);
          dispatchCount += 1;
          if (page === undefined) throw new Error("Unexpected extra fetch");
          return page;
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger,
    });
    spine.setRequestContext(requestContextFor(USER_ID));
    const client = spine.createRequester(mockLocalHostEntry);
    const hostId = mockLocalHostEntry.hostId;
    const options = cloudEpicTasksFirstPageQueryOptions(
      hostId,
      USER_ID,
      LIST_CLOUD_TASKS_REQUEST,
    );

    useAuthStore.getState().setSignedIn(USER_PROFILE, USER_CONTEXT, []);
    __resetCloudEpicTasksClientsForTests();
    registerCloudEpicTasksClient(hostId, client);

    try {
      await expect(queryClient.fetchQuery(options)).resolves.toEqual(pages[0]);
      expect(dispatchCount).toBe(1);

      const freshObserver = new QueryObserver(queryClient, options);
      const unsubscribeFresh = freshObserver.subscribe(() => {});
      await Promise.resolve();
      expect(dispatchCount).toBe(1);
      unsubscribeFresh();

      await queryClient.invalidateQueries({ queryKey: options.queryKey });
      expect(dispatchCount).toBe(1);
      expect(queryClient.getQueryState(options.queryKey)?.isInvalidated).toBe(
        true,
      );

      const remountedObserver = new QueryObserver(queryClient, options);
      const refreshed = new Promise<ListTasksResponse>((resolve, reject) => {
        const unsubscribe = remountedObserver.subscribe((result) => {
          if (result.isError) {
            unsubscribe();
            reject(result.error);
          } else if (
            result.isSuccess &&
            result.data.hasMore &&
            dispatchCount === 2
          ) {
            unsubscribe();
            resolve(result.data);
          }
        });
      });

      await expect(refreshed).resolves.toEqual(pages[1]);
      expect(dispatchCount).toBe(2);
      expect(queryClient.getQueryState(options.queryKey)?.isInvalidated).toBe(
        false,
      );
    } finally {
      __resetCloudEpicTasksClientsForTests();
      useAuthStore.getState().setSignedOut();
    }
  });
});
