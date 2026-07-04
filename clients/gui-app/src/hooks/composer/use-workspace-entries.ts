import { keepPreviousData } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { WorkspaceMentionSuggestion } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import type {
  MentionWorkspaceRequest,
  WorkspaceMentionMethod,
} from "@/lib/composer/mentions";

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

export function useWorkspaceEntries(
  params: UseWorkspaceEntriesParams,
): UseWorkspaceEntriesResult {
  const queries = useHostQueries<HostRpcRegistry, WorkspaceMentionMethod>({
    client: params.client,
    requests: params.requests,
    options: { staleTime: 30_000, placeholderData: keepPreviousData },
  });

  return {
    data: queries.flatMap((query) => query.data?.entries ?? EMPTY),
    isLoading: queries.some((query) => query.isLoading),
    isFetching: queries.some((query) => query.isFetching),
    error: queries.find((query) => query.error !== null)?.error ?? null,
  };
}

const EMPTY: ReadonlyArray<WorkspaceMentionSuggestion> = [];
