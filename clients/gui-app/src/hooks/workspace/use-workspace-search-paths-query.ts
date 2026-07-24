import { useMemo } from "react";
import { keepPreviousData, type UseQueryResult } from "@tanstack/react-query";
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
import { useHostQuery } from "@/hooks/host/use-host-query";

const WORKSPACE_SEARCH_PATHS_LIMIT = 50;

export interface UseWorkspaceSearchPathsArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  /**
   * The selected workspace/worktree root - a binding `runningDir` or resolved
   * workspace-folder path the Epic pickers expose. The host authorizes it
   * against the Epic's attached roots; the renderer never sends an arbitrary
   * absolute path expecting it to be trusted.
   */
  readonly root: string | null;
  readonly query: string;
  readonly kinds: WorkspaceSearchPathsKindFilter;
  readonly enabled: boolean;
}

/**
 * Scoped, host-ranked file/folder NAME search over one Epic-attached root
 * (`workspace.searchPaths`). Enumeration + Fuse ranking live in the host, so a
 * query never ships or scans the full tree in the renderer.
 *
 * The query key is `[host, method, { epicId, reference.root, query, ... }]`, so
 * a change of Epic, host, root, or query mints a new key and a late in-flight
 * response for the previous selection is discarded rather than applied. The
 * response also echoes `epicId`/`root` so callers can defensively drop a stale
 * payload. `keepPreviousData` keeps the last results visible while the next
 * keystroke's request is in flight, so the list does not blank between strokes.
 */
export function useWorkspaceSearchPaths(
  args: UseWorkspaceSearchPathsArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "workspace.searchPaths">,
  HostRpcError
> {
  const trimmedQuery = args.query.trim();
  const params = useMemo(
    () => ({
      epicId: args.epicId,
      reference: { root: args.root ?? "" },
      query: trimmedQuery,
      limit: WORKSPACE_SEARCH_PATHS_LIMIT,
      kinds: args.kinds,
    }),
    [args.epicId, args.root, trimmedQuery, args.kinds],
  );

  return useHostQuery<HostRpcRegistry, "workspace.searchPaths">({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "workspace.searchPaths",
    params,
    options: {
      enabled:
        args.enabled &&
        args.root !== null &&
        args.root.length > 0 &&
        trimmedQuery.length > 0,
      staleTime: 5_000,
      placeholderData: keepPreviousData,
    },
  });
}

export interface UseWorkspaceSearchPathsForSourceArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  /**
   * The scoped search source: either an attached workspace/worktree `{ root }`
   * or the host-derived `{ kind: "epic-artifacts" }` mirror. Pass a STABLE
   * object (module constant or memoized) so the query key is stable across
   * renders. `null` disables the query.
   */
  readonly source: WorkspaceSearchSource | null;
  readonly query: string;
  readonly kinds: WorkspaceSearchPathsKindFilter;
  readonly enabled: boolean;
}

/**
 * Source-capable variant of {@link useWorkspaceSearchPaths} for callers (the
 * new-tab Files opener) that search EITHER an attached root OR the Epic artifact
 * mirror. Unlike the root-only hook it does NOT gate on a non-empty query - the
 * opener wants an empty-query passthrough (the host returns a bounded browse
 * list) - so the caller owns the enable gate. The response is a discriminated
 * union; read it through {@link readSearchPathsResponseForSource} to echo-guard
 * a late reply against the requested source.
 */
export function useWorkspaceSearchPathsForSource(
  args: UseWorkspaceSearchPathsForSourceArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "workspace.searchPaths">,
  HostRpcError
> {
  const trimmedQuery = args.query.trim();
  const source = args.source;
  const params = useMemo(
    () => ({
      epicId: args.epicId,
      reference: source ?? { root: "" },
      query: trimmedQuery,
      limit: WORKSPACE_SEARCH_PATHS_LIMIT,
      kinds: args.kinds,
    }),
    [args.epicId, source, trimmedQuery, args.kinds],
  );

  return useHostQuery<HostRpcRegistry, "workspace.searchPaths">({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "workspace.searchPaths",
    params,
    options: {
      enabled: args.enabled && source !== null && isSearchableSource(source),
      staleTime: 5_000,
      placeholderData: keepPreviousData,
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

/**
 * Reads a `workspace.searchPaths` response for a specific requested source,
 * discriminating the attached-root vs artifact response branch and dropping a
 * late/stale reply whose echoed `epicId`/source no longer matches the request.
 * Returns `null` for "no usable data yet" (undefined response or echo mismatch).
 */
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
