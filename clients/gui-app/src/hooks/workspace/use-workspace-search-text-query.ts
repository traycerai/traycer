import { useMemo } from "react";
import { keepPreviousData, type UseQueryResult } from "@tanstack/react-query";
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
import { useHostQuery } from "@/hooks/host/use-host-query";

const WORKSPACE_SEARCH_TEXT_LIMIT = 200;

export interface UseWorkspaceSearchTextArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  /**
   * The search source. Either an attached workspace/worktree root selector (a
   * binding `runningDir` the Epic pickers expose - the host authorizes it, the
   * renderer never sends an arbitrary trusted path) or the typed Epic-artifact
   * mirror source (`{ kind: "epic-artifacts" }`, whose host-local directory the
   * resolver derives from `epicId`). `null` disables the query.
   */
  readonly reference: WorkspaceSearchSource | null;
  readonly query: string;
  readonly options: WorkspaceSearchTextOptions;
  readonly enabled: boolean;
}

/**
 * Scoped, host-run TEXT (file-content) search over one source
 * (`workspace.searchText`) - either an Epic-attached code root or the Epic's
 * artifact mirror. ripgrep runs in the host; the renderer never scans contents.
 *
 * The query key is `[host, method, { epicId, reference, query, options, limit }]`,
 * so a change of Epic, host, source (root or artifact), query, or any option
 * mints a new key and a late in-flight response for the previous selection is
 * discarded rather than applied. The response also echoes `epicId` and its
 * source (`root` for a code root, `source` for artifacts) so the caller can
 * defensively drop a stale payload that crosses a source/target change.
 * `keepPreviousData` keeps the last results visible while the next keystroke's
 * request is in flight, so the list does not blank between strokes.
 *
 * `workspace.searchText` is an optional (non-floor) capability: an old host
 * rejects with `E_HOST_UNSUPPORTED`, surfaced here as `query.error.code` for the
 * consumer to render a degraded state without a toast.
 */
export function useWorkspaceSearchText(
  args: UseWorkspaceSearchTextArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "workspace.searchText">,
  HostRpcError
> {
  const trimmedQuery = args.query.trim();
  const { options, reference } = args;
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
      placeholderData: keepPreviousData,
    },
  });
}
