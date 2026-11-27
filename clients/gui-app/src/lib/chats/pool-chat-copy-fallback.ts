import { negotiatedVersionMeetsRequirement } from "@traycer-clients/shared/host-transport/host-messenger";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { chatSubscribeV18 } from "@traycer/protocol/host/agent/gui/subscribe";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";

export type PoolChatStreamHandshake = ReadonlyMap<string, SchemaVersion>;

export interface PoolChatCopyRefusal {
  readonly handshake: PoolChatStreamHandshake | null;
}

export function poolChatSupportsWindows(
  handshake: PoolChatStreamHandshake,
): boolean {
  return negotiatedVersionMeetsRequirement(
    handshake.get(chatSubscribeV18.method),
    {
      method: chatSubscribeV18.method,
      version: chatSubscribeV18.schemaVersion,
    },
  );
}

export function freshPoolChatStreamHandshake(
  handshake: PoolChatStreamHandshake | null,
  refusal: PoolChatCopyRefusal,
): boolean {
  return (
    handshake !== null &&
    handshake !== refusal.handshake &&
    poolChatSupportsWindows(handshake)
  );
}

/** Terminal pool stream closes for which the tile can read the published copy. */
export function isPoolChatCopyFallbackClose(
  reason: StreamCloseReason | null,
): boolean {
  if (reason?.kind !== "fatalError" || reason.details.retryable === true) {
    return false;
  }
  const { code } = reason.details;
  return (
    code === "E_HOST_UNSUPPORTED" ||
    code === "INCOMPATIBLE" ||
    code === "CHAT_INDEX_UNAVAILABLE"
  );
}
