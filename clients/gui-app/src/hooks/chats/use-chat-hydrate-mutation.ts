import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HydrateChatRequest,
  HydrateChatResponse,
} from "@traycer/protocol/host/epic/chat-hydration";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { EVICTED_SEND_FAILED_MESSAGE } from "@/lib/chats/evicted-chat-refusal";
import type { HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { chatHydrateMutationKeys } from "@/lib/query-keys";

/**
 * Asks a chat's own host to bring back the records it dropped
 * (`epic.hydrateChat`), on that host's client. A failure is the failure of the
 * message that asked, so it toasts as one, a typed refusal included.
 */
export function useChatHydrateMutation(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly chatId: string;
}): UseMutationResult<HydrateChatResponse, HostRpcError, HydrateChatRequest> {
  return useHostMutation<HostRpcRegistry, "epic.hydrateChat">({
    client: input.client,
    method: "epic.hydrateChat",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: chatHydrateMutationKeys.hydrate(input.hostId, input.chatId),
      onError: (error) => {
        toastFromHostError(error, EVICTED_SEND_FAILED_MESSAGE);
      },
    },
  });
}
