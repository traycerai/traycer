import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  isTransientHostRpcFailure,
  type HostRpcError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  useCloudChatHasCloudAuthorization,
  useCloudChatViewerId,
} from "@/hooks/chats/use-cloud-chat-queries";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";

const METHOD = "epic.getChatTitle";

/**
 * One agent's title as the cloud holds it for the viewer: `chat: null` when the
 * viewer may not read it or it does not exist.
 *
 * The title is the account's, not one machine's, so in a build with a server
 * pool the pool answers whichever client is passed. The method is optional, so
 * the read waits until the serving peer has advertised it: a peer without it
 * is never asked, and a reader keeps whatever label it already had.
 *
 * The answer is the viewer's (which row the cloud picks, and whether it may be
 * read at all, differ between two accounts on one installation), so its key
 * carries the viewer and the read waits for a cloud verdict.
 */
export function useEpicChatTitleQuery(args: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly taskId: string;
  readonly chatId: string;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "epic.getChatTitle">,
  HostRpcError
> {
  const { client, taskId, chatId } = args;
  const servingClient = useMemo(
    () => resolvePoolTierHostClient(client),
    [client],
  );
  const servingHostId = useReactiveHostReadiness(servingClient).hostId;
  const supported = useHostMethodSupport(servingHostId, METHOD) === true;
  const viewerUserId = useCloudChatViewerId();
  const cloudAuthorized = useCloudChatHasCloudAuthorization();
  const params = useMemo(() => ({ taskId, chatId }), [taskId, chatId]);
  return useHostQuery<HostRpcRegistry, "epic.getChatTitle">({
    cacheKeyIdentity: [viewerUserId],
    client: servingClient,
    method: METHOD,
    params,
    preflight: cloudVerdictPreflight(METHOD),
    options: {
      enabled: supported && cloudAuthorized && viewerUserId.length > 0,
      refetchOnWindowFocus: false,
      // A refusal is the answer; only a transport failure can recover.
      retry: (_failureCount, error) => isTransientHostRpcFailure(error),
    },
  });
}
