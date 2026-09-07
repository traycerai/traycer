import type { QueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  ResolveArtifactByPathRequest,
  ResolveArtifactByPathResponse,
  ResolveArtifactByPathResult,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { hostQueryKeys } from "@/lib/query-keys";

export interface FetchResolveArtifactByPathArgs {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
  /**
   * Active/default host id - epics are listed from it and the resolved artifact tab is stamped with it (matching sidebar artifact opens), NOT the chat's `tabHostId`.
   * Also scopes the cache key so a host swap can't serve a stale id.
   */
  readonly hostId: string;
  readonly epicId: string;
  /** Absolute artifact `index.md` path lifted from the markdown href. */
  readonly filePath: string;
}

/**
 * Imperative read of `epic.resolveArtifactByPath` for a link click - gui-app mandates host RPC through TanStack Query, but a click is imperative, so this routes through `queryClient.fetchQuery` rather than a render-bound `useHostQuery`.
 */
export async function fetchResolveArtifactByPath(
  args: FetchResolveArtifactByPathArgs,
): Promise<ResolveArtifactByPathResult | null> {
  const params: ResolveArtifactByPathRequest = {
    epicId: args.epicId,
    filePath: args.filePath,
  };
  // Named request fn (not an inline closure in `queryFn`) so the host-scoped key stays the cache identity - the client is addressed by `hostId`, never a key dep (mirrors `hostQueryOptions`).
  const request = (): Promise<ResolveArtifactByPathResponse> =>
    args.client.request("epic.resolveArtifactByPath", params);
  const queryKey = hostQueryKeys.resolveArtifactByPath(args.hostId, params);
  const response = await args.queryClient.fetchQuery({
    queryKey,
    queryFn: request,
    // A resolved id→path mapping only changes on rename/delete, which invalidate via the epic projection; a short window is enough to collapse a double-click.
    staleTime: 15_000,
  });
  // A `null` result means the path is not (yet) an artifact.
  // Unlike a real id, a not-yet-minted path can BECOME resolvable moments later WITHOUT invalidating this key (minting isn't a rename/delete), so a 15s-fresh null would keep re-clicks falling back / no-oping until it expires.
  if (response.artifact === null) {
    args.queryClient.removeQueries({ queryKey });
  }
  return response.artifact;
}
