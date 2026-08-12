import { keepPreviousData } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EpicMentionSuggestion } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostBinding } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { toastFromHostError } from "@/lib/host-error-toast";
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
  /**
   * Refetches every `epic.mention*` query behind this list, resolving when
   * they all settle.
   *
   * It resolves rather than returning void because the composer's Artifacts
   * refresh button awaits it: the button's spinner has to reflect a real
   * round-trip. Until this was wired up, that button called `setStep` with the
   * step it was already on, which the picker store early-returns from - so it
   * spun for its minimum visible time and fetched nothing at all.
   */
  readonly refetch: () => Promise<void>;
  readonly error: HostRpcError | null;
}

export function useEpicMentionEntries(
  params: UseEpicMentionEntriesParams,
): UseEpicMentionEntriesResult {
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;

  const queries = useHostQueries<HostRpcRegistry, EpicMentionMethod>({
    client,
    cacheKeyIdentity: undefined,
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
    // A rejected refresh is REPORTED, because a user asked for this one.
    //
    // `refetch()` resolves with a failed result rather than rejecting, so
    // without this the button spins for its round-trip and stops exactly as it
    // does on success - a refresh that never reached the host, presented as
    // one that found nothing new. The picker has no inline surface to say it
    // in either: `useMentionItems` publishes `loadFailed: false` outright.
    //
    // Same split as the GitHub catalog's two lanes: the manual lane speaks up,
    // automatic ones degrade in place and leave the cached rows on screen.
    refetch: () =>
      Promise.all(queries.map((query) => query.refetch())).then((results) => {
        const failure =
          results.find((result) => result.error !== null)?.error ?? null;
        if (failure === null) return;
        toastFromHostError(failure, "Could not refresh artifacts");
      }),
    error: queries.find((query) => query.error !== null)?.error ?? null,
  };
}

const EMPTY: ReadonlyArray<EpicMentionSuggestion> = [];
