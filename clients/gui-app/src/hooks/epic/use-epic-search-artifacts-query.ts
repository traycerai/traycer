import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { useHostQuery } from "@/hooks/host/use-host-query";

const EPIC_SEARCH_ARTIFACTS_LIMIT = 50;

/**
 * Titles, logical artifact paths, and bodies. Paths are searched because agents
 * routinely print an artifact's slug chain (`tickets/sweep-dialog-discovery`)
 * and users paste that back to find it; the host ranks the logical path, never
 * the physical `index.md` mirror layout.
 */
const ARTIFACT_SEARCH_FIELDS = Object.freeze({
  title: true,
  path: true,
  body: true,
});

export interface UseEpicSearchArtifactsArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly query: string;
  readonly kinds: ReadonlyArray<EpicArtifactKind> | null;
  /** Composed from the sidebar's status filter. `null` = no status restriction. */
  readonly statuses: ReadonlyArray<number> | null;
  /** POSIX subtree relative to the artifact root, or `null` for the whole Epic. */
  readonly subtreePath: string | null;
  readonly enabled: boolean;
}

/** Renderer never scans Markdown. No keepPreviousData. E_HOST_UNSUPPORTED is a degraded state, no toast. */
export function useEpicSearchArtifacts(
  args: UseEpicSearchArtifactsArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "epic.searchArtifacts">,
  HostRpcError
> {
  const trimmedQuery = args.query.trim();
  const { kinds, statuses, subtreePath } = args;
  const params = useMemo(
    () => ({
      epicId: args.epicId,
      query: trimmedQuery,
      fields: ARTIFACT_SEARCH_FIELDS,
      filters: {
        kinds: kinds === null ? null : [...kinds],
        statuses: statuses === null ? null : [...statuses],
        subtreePath,
      },
      limit: EPIC_SEARCH_ARTIFACTS_LIMIT,
    }),
    // `kinds`/`statuses` are stable references from the sidebar filter store,
    // so depending on them directly does not remint the key each render. The
    // query key is structurally hashed, so params identity is not the gate.
    [args.epicId, trimmedQuery, kinds, statuses, subtreePath],
  );

  return useHostQuery<HostRpcRegistry, "epic.searchArtifacts">({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "epic.searchArtifacts",
    params,
    options: {
      enabled: args.enabled && trimmedQuery.length > 0,
      staleTime: 5_000,
    },
  });
}
