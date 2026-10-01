import type { UseQueryResult } from "@tanstack/react-query";
import {
  AUTO_JUDGE_RECENT_LIMIT_MAX,
  type AutoJudgeListRecentResponse,
} from "@traycer/protocol/host/auto-mode/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/** The whole ring: the host keeps the last 200 decisions, so ask for them. */
const AUTO_JUDGE_RECENT_PARAMS = { limit: AUTO_JUDGE_RECENT_LIMIT_MAX };

/**
 * `autoJudge.listRecent` on the surface's host: the judge's recent decisions
 * on that machine, newest first.
 *
 * `enabled` is the caller's capability gate - the method is optional, and a
 * host that predates it would answer every read as unsupported. Refetched on
 * every mount, because the log grows while the tab is closed and a stale page
 * of decisions is the one thing this view must not show.
 */
export function useAutoJudgeRecentQuery(
  enabled: boolean,
): UseQueryResult<AutoJudgeListRecentResponse, HostRpcError> {
  const client = useHostClient();
  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "autoJudge.listRecent",
    params: AUTO_JUDGE_RECENT_PARAMS,
    options: {
      enabled,
      refetchOnWindowFocus: false,
      refetchOnMount: "always",
    },
  });
}
