import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HydrateChatRequest,
  HydrateChatResponse,
} from "@traycer/protocol/host/epic/chat-hydration";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
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
  const supportsHydration = useHostMethodSupport(
    input.hostId,
    "epic.hydrateChat",
  );
  const host = useHostDirectoryEntry(input.hostId);
  // A recorded absence parks the very RPC that would refresh it. Keep one
  // released-floor read alive, and re-ask when this host's process changes.
  useHostCapabilityProbe({
    client: input.client,
    stale: supportsHydration === false,
    incarnation: [
      input.hostId,
      host?.version ?? null,
      host?.transportDialability ?? null,
      host?.websocketUrl ?? null,
    ],
  });
  return useHostMutation<HostRpcRegistry, "epic.hydrateChat">({
    client: input.client,
    method: "epic.hydrateChat",
    mapVariables: (variables) => {
      if (supportsHydration === false) {
        throw new HostRpcError({
          code: "E_HOST_UNSUPPORTED",
          message: EVICTED_SEND_FAILED_MESSAGE,
          requestId: "client-hydrate-unsupported",
          method: "epic.hydrateChat",
          fatalDetails: null,
        });
      }
      // An unknown host must be allowed to connect. The request's own
      // handshake still refuses an absent method before sending its payload.
      return variables;
    },
    options: {
      mutationKey: chatHydrateMutationKeys.hydrate(input.hostId, input.chatId),
      onError: (error) => {
        toastFromHostError(error, EVICTED_SEND_FAILED_MESSAGE);
      },
    },
  });
}
