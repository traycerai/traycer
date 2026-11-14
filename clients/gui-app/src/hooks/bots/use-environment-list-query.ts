import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import {
  EnvironmentCloudError,
  NEEDS_CONNECTION_MESSAGE,
} from "@traycer-clients/shared/environment/environment-cloud";
import {
  environmentDirectoryRows,
  readEnvironmentList,
} from "@traycer-clients/shared/environment/environment-list";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  ENVIRONMENT_CLOUD_QUERY_SCOPE,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { describeLogErrorSummary, appLogger } from "@/lib/logger";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const METHOD = "environment.list";

// Stable params identity so the key stays referentially constant across renders.
const EMPTY_PARAMS = {};

/**
 * Every environment the signed-in person belongs to (the personal one first,
 * then one per team), read by the app itself with no computer in the path:
 * traycer-server's directory through the shell (`AuthService.listEnvironments`),
 * joined with authn's reads of each row's hosts and the person's role, as the
 * host's `environment.list` joined them. A row whose facts could not be read
 * lists degraded, and is logged without its id or the failure's words.
 *
 * The directory and the joins are one operation on one sign-in: a sign-in that
 * changes after the directory answered fails the read instead of joining one
 * person's directory with another's facts.
 *
 * The answer is the ACCOUNT's, so its key carries the viewer and the read waits
 * until the viewer resolves: an account switch must never serve the previous
 * account's environments. It sits under the app's own environment scope, where
 * a host's `environment.list` would put its host id, so every invalidation of
 * the method on any host reaches it.
 */
export function useEnvironmentListQuery(
  enabled: boolean,
): UseQueryResult<EnvironmentListResponseV11, HostRpcError> {
  const auth = useHostBinding()?.auth ?? null;
  const cloud = useEnvironmentCloud();
  const viewerId = useCloudChatViewerId();
  const teams = useAuthStore((state) => state.shareableTeams);
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useQuery<EnvironmentListResponseV11, HostRpcError>(
    // `auth`, `cloud` and `teams` are the session of the viewer the key
    // already names; adding them would refetch on their identity alone.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryOptions<EnvironmentListResponseV11, HostRpcError>({
      queryKey: [
        ...hostQueryKeys.method<HostRpcRegistry, typeof METHOD>(
          ENVIRONMENT_CLOUD_QUERY_SCOPE,
          METHOD,
          EMPTY_PARAMS,
        ),
        viewerId,
      ],
      meta: stampHostRpcMethod(undefined, METHOD),
      queryFn: () =>
        withHostQueryErrorBoundary(METHOD, async () => {
          cloudVerdictPreflight(METHOD)();
          if (auth === null || cloud === null)
            throw hostClientUnavailableError(METHOD);
          const operation = cloud();
          try {
            const directory = environmentDirectoryRows(
              await auth.listEnvironments(),
            );
            if (!operation.onOriginSignIn()) {
              throw new EnvironmentCloudError(
                "no_response",
                NEEDS_CONNECTION_MESSAGE.settings,
              );
            }
            const environments = await readEnvironmentList(
              operation,
              directory,
              teams.map((team) => ({ id: team.teamId, slug: team.slug })),
              (_environmentId, facts, error) => {
                appLogger.warn("[environment-list] row facts unread", {
                  facts,
                  error: describeLogErrorSummary(error),
                });
              },
            );
            return { environments };
          } catch (error) {
            throw environmentCloudHostError(METHOD, error);
          }
        }),
      enabled:
        enabled &&
        auth !== null &&
        cloud !== null &&
        viewerId.length > 0 &&
        authorized,
      refetchOnWindowFocus: false,
    }),
  );
}
