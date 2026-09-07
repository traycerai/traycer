import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type {
  WorkspaceSearchPathResult,
  WorkspaceSearchPathsKindFilter,
  WorkspaceSearchPathsOutcome,
  WorkspaceSearchPathsResponse,
  WorkspaceSearchSource,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { keepPreviousDataForSameHost } from "@/hooks/host/keep-previous-data-same-host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";

const WORKSPACE_SEARCH_PATHS_LIMIT = 50;

export interface UseWorkspaceSearchPathsArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  /** The host authorizes it against the Epic's attached roots; the renderer never sends an arbitrary absolute path expecting it to be trusted. */
  readonly root: string | null;
  readonly query: string;
  readonly kinds: WorkspaceSearchPathsKindFilter;
  readonly enabled: boolean;
}

/**
 * Query key includes epic/host/root/query so a late in-flight response is discarded. Same-host `keepPreviousData` holds last results across keystrokes; a host switch drops the prior payload.
 */
export function useWorkspaceSearchPaths(
  args: UseWorkspaceSearchPathsArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "workspace.searchPaths">,
  HostRpcError
> {
  const trimmedQuery = args.query.trim();
  const reference = useMemo(() => ({ root: args.root ?? "" }), [args.root]);
  return useWorkspaceSearchPathsCore({
    client: args.client,
    epicId: args.epicId,
    reference,
    query: trimmedQuery,
    kinds: args.kinds,
    enabled:
      args.enabled &&
      args.root !== null &&
      args.root.length > 0 &&
      trimmedQuery.length > 0,
  });
}

export interface UseWorkspaceSearchPathsForSourceArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  /** The scoped search source: either an attached workspace/worktree `{ root }` or the host-derived `{ kind: "epic-artifacts" }` mirror. */
  readonly source: WorkspaceSearchSource | null;
  readonly query: string;
  readonly kinds: WorkspaceSearchPathsKindFilter;
  readonly enabled: boolean;
}

/** Unlike the root-only hook it does NOT gate on a non-empty query - the opener wants an empty-query passthrough (the host returns a bounded browse list) - so the caller owns the enable gate. */
export function useWorkspaceSearchPathsForSource(
  args: UseWorkspaceSearchPathsForSourceArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "workspace.searchPaths">,
  HostRpcError
> {
  const source = args.source;
  const fallbackSource = useMemo(() => ({ root: "" }), []);
  return useWorkspaceSearchPathsCore({
    client: args.client,
    epicId: args.epicId,
    reference: source ?? fallbackSource,
    query: args.query,
    kinds: args.kinds,
    enabled: args.enabled && source !== null && isSearchableSource(source),
  });
}

function useWorkspaceSearchPathsCore(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly reference: WorkspaceSearchSource;
  readonly query: string;
  readonly kinds: WorkspaceSearchPathsKindFilter;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "workspace.searchPaths">,
  HostRpcError
> {
  const trimmedQuery = args.query.trim();
  const { hostId } = useReactiveHostReadiness(args.client);
  const params = useMemo(
    () => ({
      epicId: args.epicId,
      reference: args.reference,
      query: trimmedQuery,
      limit: WORKSPACE_SEARCH_PATHS_LIMIT,
      kinds: args.kinds,
    }),
    [args.epicId, args.reference, trimmedQuery, args.kinds],
  );

  return useHostQuery<HostRpcRegistry, "workspace.searchPaths">({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "workspace.searchPaths",
    params,
    options: {
      enabled: args.enabled,
      staleTime: 5_000,
      placeholderData: keepPreviousDataForSameHost(hostId),
    },
  });
}

function isSearchableSource(source: WorkspaceSearchSource): boolean {
  return "kind" in source ? true : source.root.length > 0;
}

export interface WorkspaceSearchPathsView {
  readonly outcome: WorkspaceSearchPathsOutcome;
  readonly results: readonly WorkspaceSearchPathResult[];
  readonly truncated: boolean;
}

/** Reads a `workspace.searchPaths` response for a specific requested source, discriminating the attached-root vs artifact response branch and dropping a late/stale reply whose echoed `epicId`/source no longer matches the request. */
export function readSearchPathsResponseForSource(
  response: WorkspaceSearchPathsResponse | undefined,
  epicId: string,
  source: WorkspaceSearchSource,
): WorkspaceSearchPathsView | null {
  if (response === undefined || response.epicId !== epicId) return null;
  if ("kind" in source) {
    // The artifact response branch is the one carrying `source` (vs `root`).
    if (!("source" in response)) return null;
  } else if (!("root" in response) || response.root !== source.root) {
    return null;
  }
  return {
    outcome: response.outcome,
    results: response.results,
    truncated: response.truncated,
  };
}
