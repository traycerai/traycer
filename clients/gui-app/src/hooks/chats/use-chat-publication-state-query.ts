import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import {
  publicationStateFromResponse,
  type ChatForkPublicationState,
} from "@/components/chat/chat-fork-target";

const UNKNOWN: ChatForkPublicationState = { kind: "unknown" };

/** Every failure (unsupported, unreachable, in-flight) is unknown, never unpublished. */
export function useChatPublicationState(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly epicId: string;
  readonly chatId: string | null;
  readonly boundaryMessageId: string | null;
  readonly enabled: boolean;
}): ChatForkPublicationState {
  const supportsMethod = useHostSupportsMethod(
    args.hostId,
    "epic.chatPublicationState",
  );
  // Gate the result the same way as the request. TanStack retains cached data across a disabled observer.
  const isEnabled =
    args.enabled &&
    args.chatId !== null &&
    args.client !== null &&
    supportsMethod;
  const query = useHostQuery<HostRpcRegistry, "epic.chatPublicationState">({
    cacheKeyIdentity: [args.chatId, args.boundaryMessageId],
    client: args.client,
    method: "epic.chatPublicationState",
    params: {
      epicId: args.epicId,
      chatId: args.chatId ?? "",
      boundaryMessageId: args.boundaryMessageId,
    },
    options: {
      enabled: isEnabled,
      staleTime: 5_000,
    },
  });
  // Disabled, error, and in-flight (isFetching) are all unknown. Never serve a retained older answer.
  if (!isEnabled) return UNKNOWN;
  if (query.isError) return UNKNOWN;
  if (query.isFetching) return UNKNOWN;
  const data = query.data;
  if (data === undefined) return UNKNOWN;
  return publicationStateFromResponse(data);
}
