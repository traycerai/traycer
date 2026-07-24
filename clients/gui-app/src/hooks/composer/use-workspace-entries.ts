import { useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { WorkspaceMentionSuggestion } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import type { HostRequestSpec } from "@/hooks/host/use-host-queries";
import type {
  MentionSearchPathsRequest,
  MentionWorkspaceRequest,
  WorkspaceMentionMethod,
} from "@/lib/composer/mentions";
import {
  fileSuggestionFromSearchResult,
  folderSuggestionFromSearchResult,
} from "@/lib/composer/mentions/search-path-suggestions";

export interface UseWorkspaceEntriesParams {
  readonly requests: ReadonlyArray<MentionWorkspaceRequest>;
  readonly client: HostClient<HostRpcRegistry> | null;
}

export interface UseWorkspaceEntriesResult {
  data: ReadonlyArray<WorkspaceMentionSuggestion>;
  isLoading: boolean;
  isFetching: boolean;
  error: HostRpcError | null;
}

// The legacy raw-root fallback re-request for a scoped root whose
// `workspace.searchPaths` query errored (e.g. an old host that predates the
// method): a small cap keeps the fallback cheap - it only exists so a scoped
// failure never drops that root's suggestions.
const SEARCH_PATHS_FALLBACK_LIMIT = 25;

type LegacyMentionRequest = Exclude<
  MentionWorkspaceRequest,
  MentionSearchPathsRequest
>;

/**
 * Executes the file/folder/git mention requests. Legacy raw-root requests run
 * as before; scoped `workspace.searchPaths` requests (emitted only for
 * Epic-attached roots) run separately and their host-ranked results are
 * reconstructed into the same mention-suggestion shape. If a scoped request
 * errors, that root is re-issued through the legacy RPC so scoping never makes
 * a suggestion disappear.
 */
export function useWorkspaceEntries(
  params: UseWorkspaceEntriesParams,
): UseWorkspaceEntriesResult {
  const legacyRequests = useMemo(
    () => params.requests.filter(isLegacyRequest),
    [params.requests],
  );
  const searchRequests = useMemo(
    () => params.requests.filter(isSearchPathsRequest),
    [params.requests],
  );

  const searchQueries = useHostQueries<HostRpcRegistry, "workspace.searchPaths">(
    {
      client: params.client,
      cacheKeyIdentity: undefined,
      requests: useMemo(
        () =>
          searchRequests.map((request) => ({
            method: request.method,
            params: request.params,
          })),
        [searchRequests],
      ),
      options: { staleTime: 30_000, placeholderData: keepPreviousData },
    },
  );

  // Fall back to the legacy RPC for any scoped root the host could not search:
  // a query error (e.g. an old host that lacks `workspace.searchPaths`, or a
  // transient failure) OR a typed `root_unavailable` outcome (the root is no
  // longer authorized/attached/resolvable). Both keep the existing behavior
  // instead of silently dropping that root's suggestions; a `ready` outcome
  // (even with zero matches) does NOT fall back.
  const fallbackRequests = useMemo(
    () =>
      searchRequests.flatMap((request, index) => {
        const query = searchQueries[index];
        const unavailable =
          query.isError || query.data?.outcome === "root_unavailable";
        return unavailable ? [fallbackLegacyRequest(request)] : [];
      }),
    [searchRequests, searchQueries],
  );

  const legacyQueries = useHostQueries<HostRpcRegistry, WorkspaceMentionMethod>({
    client: params.client,
    cacheKeyIdentity: undefined,
    requests: useMemo(
      () => [...legacyRequests, ...fallbackRequests],
      [legacyRequests, fallbackRequests],
    ),
    options: { staleTime: 30_000, placeholderData: keepPreviousData },
  });

  const legacyData = legacyQueries.flatMap((query) => query.data?.entries ?? EMPTY);
  const searchData = searchRequests.flatMap((request, index) => {
    const data = searchQueries[index]?.data;
    if (data === undefined) return EMPTY;
    // A `root_unavailable` outcome contributes nothing here - the legacy
    // fallback above already re-issued that root - so only `ready` data maps.
    if (data.outcome !== "ready") return EMPTY;
    // Drop a late reply that crossed an Epic/root selection change (the echoed
    // ids no longer match the request this slot stands for).
    if (
      !("root" in data) ||
      data.epicId !== request.params.epicId ||
      data.root !== request.root
    ) {
      return EMPTY;
    }
    return data.results.flatMap((result) => {
      if (result.kind !== request.suggestionKind) return [];
      return [
        request.suggestionKind === "folder"
          ? folderSuggestionFromSearchResult(request.root, result)
          : fileSuggestionFromSearchResult(request.root, result),
      ];
    });
  });

  return {
    data: [...legacyData, ...searchData],
    isLoading:
      legacyQueries.some((query) => query.isLoading) ||
      searchQueries.some((query) => query.isLoading),
    isFetching:
      legacyQueries.some((query) => query.isFetching) ||
      searchQueries.some((query) => query.isFetching),
    // A scoped error is recovered by the legacy fallback above, so it must not
    // surface as the batch error; only a legacy error is user-visible.
    error: legacyQueries.find((query) => query.error !== null)?.error ?? null,
  };
}

function isSearchPathsRequest(
  request: MentionWorkspaceRequest,
): request is MentionSearchPathsRequest {
  return request.method === "workspace.searchPaths";
}

function isLegacyRequest(
  request: MentionWorkspaceRequest,
): request is LegacyMentionRequest {
  return request.method !== "workspace.searchPaths";
}

function fallbackLegacyRequest(
  request: MentionSearchPathsRequest,
): HostRequestSpec<HostRpcRegistry, WorkspaceMentionMethod> {
  return {
    method:
      request.suggestionKind === "folder"
        ? "workspace.mentionFolders"
        : "workspace.mentionFiles",
    params: {
      roots: [request.root],
      query: request.params.query,
      limit: SEARCH_PATHS_FALLBACK_LIMIT,
    },
  };
}

const EMPTY: ReadonlyArray<WorkspaceMentionSuggestion> = [];
