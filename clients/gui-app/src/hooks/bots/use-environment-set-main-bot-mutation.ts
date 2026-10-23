import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  EnvironmentSetMainBotRequest,
  EnvironmentSetMainBotResponse,
} from "@traycer/protocol/host/environment/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { environmentMutationKeys } from "@/lib/query-keys";
import { invalidateBotLists } from "@/hooks/bots/use-bot-mutations";

/**
 * Makes a bot its environment's main bot (`environment.setMainBot`), through
 * the tab host's client. The main bot is read back from `bot.list`'s
 * `mainBotIds`, which is cloud-backed and the same through every host, so
 * the write invalidates the list on every host scope. No toast: the Settings
 * panel states a refusal inline, under the control.
 */
export function useEnvironmentSetMainBotMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  EnvironmentSetMainBotResponse,
  HostRpcError,
  EnvironmentSetMainBotRequest
> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "environment.setMainBot">({
    client,
    method: "environment.setMainBot",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: environmentMutationKeys.setMainBot(),
      onSuccess: () => {
        invalidateBotLists(queryClient);
      },
    },
  });
}
