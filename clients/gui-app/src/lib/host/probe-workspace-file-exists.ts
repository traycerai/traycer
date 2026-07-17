import type { QueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  WorkspaceReadFileRequest,
  WorkspaceReadFileResponse,
} from "@traycer/protocol/host/workspace/unary-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { hostQueryKeys } from "@/lib/query-keys";

/** Cheapest possible read that still distinguishes "exists" from "missing". */
const EXISTENCE_PROBE_MAX_BYTES = 1;

export interface FetchWorkspaceFileExistsArgs {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly workspacePath: string;
  readonly filePath: string;
}

/**
 * Imperative existence probe for a chat markdown link's candidate root -
 * gui-app mandates host RPC through TanStack Query, but a click is
 * imperative, so this routes through `queryClient.fetchQuery` rather than a
 * render-bound `useHostQuery` (mirrors `fetchResolveArtifactByPath`).
 *
 * Resolves `true` when the host reports content for `filePath` under
 * `workspacePath` (a relative link's multi-root probe treats this as "this
 * root has the file" and opens it), `false` otherwise - including a
 * transport rejection, so one unreachable root can't fail the whole probe.
 */
export async function fetchWorkspaceFileExists(
  args: FetchWorkspaceFileExistsArgs,
): Promise<boolean> {
  const params: WorkspaceReadFileRequest = {
    workspacePath: args.workspacePath,
    filePath: args.filePath,
    maxBytes: EXISTENCE_PROBE_MAX_BYTES,
  };
  const request = (): Promise<WorkspaceReadFileResponse> =>
    args.client.request("workspace.readFile", params);
  const queryKey = hostQueryKeys.readWorkspaceFile(args.hostId, params);
  return args.queryClient
    .fetchQuery({
      queryKey,
      queryFn: request,
      staleTime: 5_000,
    })
    .then((response) => response.content !== null)
    .catch(() => false);
}
