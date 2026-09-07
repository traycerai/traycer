import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { CloudChatReadPort } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";

/** The shared reader's transport port, bound to this device's host client. */
export function createHostCloudChatReadPort(
  client: HostRequester<HostRpcRegistry>,
): CloudChatReadPort {
  return {
    resolveHead: (identity) =>
      client.request("epic.resolveCloudChatHead", identity),
    readPart: (request) =>
      client.request("epic.readCloudChatPart", {
        ...request.identity,
        sha256: request.sha256,
        declaredByteLength: request.declaredByteLength,
      }),
  };
}

/** Whether a host RPC failure means "this host predates the cloud-chat surface". */
export function isCloudChatsUnsupported(error: HostRpcError | null): boolean {
  return error !== null && error.code === "E_HOST_UNSUPPORTED";
}
