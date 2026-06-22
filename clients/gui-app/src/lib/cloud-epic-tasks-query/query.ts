import { queryOptions } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  ListTasksRequest,
  ListTasksResponse,
  TaskRepoIdentifier,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  CURRENT_EPIC_VERSION,
  CURRENT_PHASE_VERSION,
} from "@traycer-clients/shared/epic/epic-version";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import { getCloudEpicTasksClient } from "@/lib/cloud-epic-tasks-query/client-registry";
import type { HistorySearchState } from "@/lib/history-search";

const PAGE_LIMIT = 20;

export type ListCloudTasksRequest = Omit<ListTasksRequest, "cursor">;

interface FetchCloudEpicTasksPageOptions {
  readonly expectedUserId: string;
  readonly request: ListCloudTasksRequest;
  readonly cursor: string | undefined;
  readonly abortSignal: AbortSignal | undefined;
}

export const LIST_CLOUD_TASKS_REQUEST: ListCloudTasksRequest = {
  limit: PAGE_LIMIT,
  filters: null,
  sort: "recent",
  extensionPhaseVersion: String(CURRENT_PHASE_VERSION),
  extensionEpicVersion: String(CURRENT_EPIC_VERSION),
};

export function cloudEpicTasksQueryKey(
  hostId: string,
  fingerprint: string,
  request: ListCloudTasksRequest,
): readonly unknown[] {
  return queryKeys.cloudEpicTasks(hostId, fingerprint, request);
}

export async function fetchCloudEpicTasksPage(
  client: HostClient<HostRpcRegistry>,
  request: ListCloudTasksRequest,
  cursor: string | undefined,
): Promise<ListTasksResponse> {
  return client.request(
    "epic.listTasks",
    buildListTasksRequest(request, cursor),
  );
}

function fetchCloudEpicTasksFirstPageByHostId(
  hostId: string,
  options: FetchCloudEpicTasksPageOptions,
): Promise<ListTasksResponse> {
  const client = getCloudEpicTasksClient(hostId);
  if (client === null) {
    return Promise.reject(new Error(`No host client registered for ${hostId}`));
  }
  return waitForMatchingRequestContext(client, options).then(() =>
    fetchCloudEpicTasksPage(client, options.request, options.cursor),
  );
}

export function cloudEpicTasksFirstPageQueryOptions(
  hostId: string,
  userId: string,
  request: ListCloudTasksRequest,
) {
  return queryOptions<ListTasksResponse>({
    queryKey: cloudEpicTasksQueryKey(hostId, userId, request),
    queryFn: ({ signal }) =>
      fetchCloudEpicTasksFirstPageByHostId(hostId, {
        expectedUserId: userId,
        request,
        cursor: undefined,
        abortSignal: signal,
      }),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
export function listCloudTasksRequestForHistorySearch(
  search: HistorySearchState,
): ListCloudTasksRequest {
  const repoIdentifiers = search.repos.flatMap(parseRepoLabel);
  const query = search.query.trim();
  const filters: NonNullable<ListTasksRequest["filters"]> = {};
  if (query.length > 0) filters.query = query;
  if (repoIdentifiers.length > 0) {
    filters.repoIdentifiers = repoIdentifiers;
    filters.repoMatchMode = search.repoMode;
  }
  if (search.workspaces.length > 0) {
    filters.workspaceIdentifiers = [...search.workspaces];
    filters.workspaceMatchMode = search.workspaceMode;
  }
  if (search.ownershipScopes.length > 0) {
    filters.ownershipScopes = [...search.ownershipScopes];
  }
  return {
    ...LIST_CLOUD_TASKS_REQUEST,
    filters: Object.keys(filters).length > 0 ? filters : null,
    sort: search.sort,
  };
}

function buildListTasksRequest(
  request: ListCloudTasksRequest,
  cursor: string | undefined,
): ListTasksRequest {
  if (cursor === undefined) {
    return request;
  }
  return { ...request, cursor };
}

function parseRepoLabel(label: string): TaskRepoIdentifier[] {
  const separatorIndex = label.indexOf("/");
  if (
    separatorIndex <= 0 ||
    separatorIndex !== label.lastIndexOf("/") ||
    separatorIndex === label.length - 1
  ) {
    return [];
  }
  return [
    {
      owner: label.slice(0, separatorIndex),
      repo: label.slice(separatorIndex + 1),
    },
  ];
}

function waitForMatchingRequestContext(
  client: HostClient<HostRpcRegistry>,
  options: FetchCloudEpicTasksPageOptions,
): Promise<void> {
  if (hasMatchingRequestContext(client, options.expectedUserId)) {
    return Promise.resolve();
  }
  if (options.abortSignal?.aborted === true) {
    return Promise.reject(createAbortError());
  }
  return new Promise((resolve, reject) => {
    const unsubscribe = client.onChange(() => {
      if (!hasMatchingRequestContext(client, options.expectedUserId)) {
        return;
      }
      cleanup();
      resolve();
    });
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      unsubscribe();
      options.abortSignal?.removeEventListener("abort", onAbort);
    };
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hasMatchingRequestContext(
  client: HostClient<HostRpcRegistry>,
  expectedUserId: string,
): boolean {
  return client.getRequestContextUserId() === expectedUserId;
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
