import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";

const PLAN_CONTENT_STALE_TIME_MS = 60 * 60 * 1000;

export function useAgentPlanQuery(args: {
  readonly epicId: string;
  readonly chatId: string;
  readonly planId: string;
  readonly contentIdentity: string;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "agent.gui.getPlan">,
  HostRpcError
> {
  const client = useTabHostClient();
  return useHostQuery<HostRpcRegistry, "agent.gui.getPlan">({
    client,
    method: "agent.gui.getPlan",
    params: {
      epicId: args.epicId,
      chatId: args.chatId,
      planId: args.planId,
    },
    cacheKeyIdentity: [args.contentIdentity],
    options: {
      enabled: args.enabled,
      staleTime: PLAN_CONTENT_STALE_TIME_MS,
      retry: false,
    },
  });
}
