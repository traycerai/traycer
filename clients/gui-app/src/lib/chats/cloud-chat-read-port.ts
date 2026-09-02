import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
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
 *
 * ## The verdict is re-read per request
 *
 * `mayReadCloud` is consulted before EVERY call, not once at construction.
 * The reader is a pipeline - one head, then a fan-out of part reads for every
 * uncached shard - and a session demoted to `unverified` after the head
 * resolves would otherwise keep issuing part reads through the retained
 * local-host credential: the query's render-time `enabled` gate stops the
 * NEXT read, not the one in flight, and the host connection carries no
 * renderer verdict of its own. A refusal here is a plain RPC error the
 * pipeline propagates unchanged, so the read fails where it was already
 * failing for a transport error. Found in review.
 */
export function createHostCloudChatReadPort(
  client: Pick<HostRequester<HostRpcRegistry>, "request">,
  mayReadCloud: () => boolean,
): CloudChatReadPort {
  const refuse = (method: string): HostRpcError =>
    new HostRpcError({
      code: "RPC_ERROR",
      message:
        "This session no longer holds a cloud verdict, so the cloud chat read was not sent.",
      requestId: "client-pre-flight",
      method,
      fatalDetails: null,
    });
  return {
    resolveHead: (identity) =>
      mayReadCloud()
        ? client.request("epic.resolveCloudChatHead", identity)
        : Promise.reject(refuse("epic.resolveCloudChatHead")),
    readPart: (request) =>
      mayReadCloud()
        ? client.request("epic.readCloudChatPart", {
            ...request.identity,
            sha256: request.sha256,
            declaredByteLength: request.declaredByteLength,
          })
        : Promise.reject(refuse("epic.readCloudChatPart")),
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
