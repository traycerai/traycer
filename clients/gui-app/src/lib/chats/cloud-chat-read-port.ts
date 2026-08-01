import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { CloudChatReadPort } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";

/**
 * The shared reader's transport port, bound to this device's host client.
 *
 * The whole binding is two calls forwarded, and that thinness is the design.
 * Everything a reader DECIDES - the version gate, per-part digest and length
 * verification, head-order assembly, the content-addressed cache - lives in
 * `@traycer-clients/shared/cloud-chat`, environment-agnostic, so the renderer
 * and the CLI cannot drift on any of it. What differs between them is which
 * wire the bytes come off, and that is exactly what this file is.
 *
 * ## Which host
 *
 * Whatever host this DEVICE runs, which is generally not the chat's owning
 * host. That is what makes the owner-offline path work: a laptop being asleep
 * does not stop a phone's host from piping down a published chat, because the
 * bytes come from the cloud and the token comes from the user.
 *
 * The host is a byte pipe here and nothing more - it does not parse the head,
 * so it cannot gate on it and cannot verify a part against it. Both jobs sit
 * with the party that does the parsing.
 */
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

/**
 * Whether a host RPC failure means "this host predates the cloud-chat surface".
 *
 * The five read methods are optional capabilities, so an older host answers
 * `E_HOST_UNSUPPORTED` for them and nothing else. Consumers branch on this
 * rather than rendering a generic failure: a host that cannot reach cloud chats
 * is not an error a user can act on except by updating it, so the surface says
 * that - or hides itself - instead of showing a broken tab.
 */
export function isCloudChatsUnsupported(error: HostRpcError | null): boolean {
  return error !== null && error.code === "E_HOST_UNSUPPORTED";
}
