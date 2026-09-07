import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type {
  WorkspaceSearchSource,
  WorkspaceSearchTextOptions,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { keepPreviousDataForSameHost } from "@/hooks/host/keep-previous-data-same-host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";

const WORKSPACE_SEARCH_TEXT_LIMIT = 200;

export interface UseWorkspaceSearchTextArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  /** Either an attached workspace/worktree root selector (a binding `runningDir` the Epic pickers expose - the host authorizes it, the renderer never sends an arbitrary trusted path) or the typed Epic-artifact mirror source (`{ kind: "epic-artifacts" }`, whose host-local directory the resolver derives from `epicId`). */
  readonly reference: WorkspaceSearchSource | null;
  readonly query: string;
  readonly options: WorkspaceSearchTextOptions;
  readonly enabled: boolean;
}

/** Renderer never scans contents. keepPreviousData is same-host only. E_HOST_UNSUPPORTED is a degraded state, no toast. */
export function useWorkspaceSearchText(
  args: UseWorkspaceSearchTextArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "workspace.searchText">,
  HostRpcError
> {
  const trimmedQuery = args.query.trim();
  const { options, reference } = args;
  const { hostId } = useReactiveHostReadiness(args.client);
  // A source is usable when it is the artifact mirror, or an attached root with
  // a non-empty path. Everything else disables the query.
  const hasSource =
    reference !== null && ("kind" in reference || reference.root.length > 0);
  // Callers hold the reference and glob arrays in stable state, so depending on
  // them directly does not churn; the request key varies with any change.
  const params = useMemo(
    () => ({
      epicId: args.epicId,
      reference: reference ?? { root: "" },
      query: trimmedQuery,
      options: {
        regex: options.regex,
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
        includeGlobs: [...options.includeGlobs],
        excludeGlobs: [...options.excludeGlobs],
      },
      limit: WORKSPACE_SEARCH_TEXT_LIMIT,
    }),
    [
      args.epicId,
      reference,
      trimmedQuery,
      options.regex,
      options.caseSensitive,
      options.wholeWord,
      options.includeGlobs,
      options.excludeGlobs,
    ],
  );

  return useHostQuery<HostRpcRegistry, "workspace.searchText">({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "workspace.searchText",
    params,
    options: {
      enabled: args.enabled && hasSource && trimmedQuery.length > 0,
      staleTime: 5_000,
      placeholderData: keepPreviousDataForSameHost(hostId),
    },
  });
}
