import { keepPreviousData } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EpicMentionSuggestion } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostBinding } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import type {
  EpicMentionMethod,
  MentionEpicRequest,
} from "@/lib/composer/mentions";

export interface UseEpicMentionEntriesParams {
  readonly requests: ReadonlyArray<MentionEpicRequest>;
}

export interface UseEpicMentionEntriesResult {
  readonly data: ReadonlyArray<EpicMentionSuggestion>;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly lastFetchedAt: number;
  readonly refetch: () => void;
  readonly error: HostRpcError | null;
}

export function useEpicMentionEntries(
  params: UseEpicMentionEntriesParams,
): UseEpicMentionEntriesResult {
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;

  const queries = useHostQueries<HostRpcRegistry, EpicMentionMethod>({
    client,
    requests: params.requests,
    options: { staleTime: 15_000, placeholderData: keepPreviousData },
  });

  return {
    data: queries.flatMap((query) => query.data?.entries ?? EMPTY),
    isLoading: queries.some((query) => query.isLoading),
    isFetching: queries.some((query) => query.isFetching),
    lastFetchedAt: Math.max(
      0,
      ...queries.flatMap((query) =>
        query.dataUpdatedAt > 0 ? [query.dataUpdatedAt] : [],
      ),
    ),
    refetch: () => {
      void Promise.all(queries.map((query) => query.refetch()));
    },
    error: queries.find((query) => query.error !== null)?.error ?? null,
  };
}

const EMPTY: ReadonlyArray<EpicMentionSuggestion> = [];
