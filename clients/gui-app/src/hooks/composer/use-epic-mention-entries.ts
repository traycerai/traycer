import { useEffect, useRef } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EpicMentionSuggestion } from "@traycer/protocol/host/index";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { toastFromHostError } from "@/lib/host-error-toast";
import type {
  EpicMentionMethod,
  MentionEpicRequest,
} from "@/lib/composer/mentions";

export interface UseEpicMentionEntriesParams {
  readonly requests: ReadonlyArray<MentionEpicRequest>;
  /** The composer's host - the SAME client its workspace/terminal/GitHub mention lanes use, so a tab bound to a non-default host lists that host's artifacts and never the app-wide default's. */
  readonly client: HostClient<HostRpcRegistry> | null;
}

export interface UseEpicMentionEntriesResult {
  readonly data: ReadonlyArray<EpicMentionSuggestion>;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly lastFetchedAt: number;
  /**
   * Resolves when every `epic.mention*` refetch settles so the Artifacts refresh spinner reflects a real round-trip.
   */
  readonly refetch: () => Promise<void>;
  readonly error: HostRpcError | null;
}

export function useEpicMentionEntries(
  params: UseEpicMentionEntriesParams,
): UseEpicMentionEntriesResult {
  const { client } = params;
  const readiness = useReactiveHostReadiness(client);

  // The CURRENTLY bound host, readable when the refetch below settles.
  const boundHostIdRef = useRef(readiness.hostId);
  useEffect(() => {
    boundHostIdRef.current = readiness.hostId;
  }, [readiness.hostId]);

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
    // Manual refresh reports rejection (`refetch` resolves failed, does not throw). Compare request-time host at settle so a mid-flight composer rebind does not toast the departed host.
    refetch: () => {
      const issuedAgainstHostId = readiness.hostId;
      return Promise.all(queries.map((query) => query.refetch())).then(
        (results) => {
          const failure =
            results.find((result) => result.error !== null)?.error ?? null;
          if (failure === null) return;
          if (issuedAgainstHostId !== boundHostIdRef.current) return;
          toastFromHostError(failure, "Could not refresh artifacts");
        },
      );
    },
    error: queries.find((query) => query.error !== null)?.error ?? null,
  };
}

const EMPTY: ReadonlyArray<EpicMentionSuggestion> = [];
