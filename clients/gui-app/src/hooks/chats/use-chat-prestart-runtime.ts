import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatPrestartRuntimeRequest } from "@traycer/protocol/host/agent/gui/prestart-runtime";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { chatPrestartMutationKeys } from "@/lib/query-keys/chat-prestart-mutation-keys";

export function useChatPrestartRuntime(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string,
  chatId: string,
) {
  return useHostMutation({
    client,
    method: "chat.prestartRuntime",
    mapVariables: (request: ChatPrestartRuntimeRequest) => request,
    options: {
      mutationKey: chatPrestartMutationKeys.prestart(hostId, chatId),
      retry: false,
      // Warming is best effort; the actual send owns any actionable error.
      meta: { suppressErrorToast: true },
    },
  });
}
