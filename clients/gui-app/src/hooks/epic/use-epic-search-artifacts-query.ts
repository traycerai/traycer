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

/** Artifact search covers user-visible content, not mirror-relative paths. */
const ARTIFACT_SEARCH_FIELDS = Object.freeze({
  title: true,
  path: false,
  body: true,
});

export interface UseEpicSearchArtifactsArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly query: string;
  /** Composed from the sidebar's kind filter. `null` = no kind restriction. */
  readonly kinds: ReadonlyArray<EpicArtifactKind> | null;
  /** Composed from the sidebar's status filter. `null` = no status restriction. */
  readonly statuses: ReadonlyArray<number> | null;
  /** POSIX subtree relative to the artifact root, or `null` for the whole Epic. */
  readonly subtreePath: string | null;
  readonly enabled: boolean;
}

/**
 * Scoped, host-ranked artifact search over one Epic (`epic.searchArtifacts`).
 * Titles are Fuse-ranked over authoritative artifact metadata and bodies are
 * ripgrep-matched over the Epic's on-disk Markdown mirror - the renderer never
 * loads or scans Markdown itself.
 *
 * The query key is `[host, method, { epicId, query, fields, filters, limit }]`,
 * so a change of host, Epic, query, or composed filter mints a new key and a
 * late in-flight response for the previous scope lands in that previous key's
 * cache slot - never the current one. `keepPreviousData` is intentionally NOT
 * used: `data` for the current key is therefore only ever this exact scope's
 * result, and the consumer owns same-scope retention across keystrokes so a
 * prior Epic/host/filter result can never render.
 *
 * `epic.searchArtifacts` is an optional (non-floor) capability: an old host
 * rejects with `E_HOST_UNSUPPORTED`, surfaced here as `query.error.code` for
 * the consumer to render a degraded state without a toast.
 */
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
