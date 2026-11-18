import type { UseMutationResult } from "@tanstack/react-query";
import type {
  BotSurfaceActRequest,
  BotSurfaceActResponse,
} from "@traycer/protocol/host/bot/surface-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { botMutationKeys } from "@/lib/query-keys";

/**
 * A member's answer or decision from a bot's surface card (Tracy Bots T89),
 * sent through the tab's host, which records it when it runs the task's chat
 * and otherwise sends it on to the machine that does. No toast: the card
 * says what became of it, in place.
 */
export function useBotSurfaceActMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotSurfaceActResponse,
  HostRpcError,
  BotSurfaceActRequest
> {
  return useHostMutation<HostRpcRegistry, "bot.surface.act">({
    client,
    method: "bot.surface.act",
    mapVariables: (variables) => variables,
    options: { mutationKey: botMutationKeys.surfaceAct() },
  });
}
