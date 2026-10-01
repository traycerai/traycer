import { useMemo } from "react";
import { create, useStore } from "zustand";
import type { ChatPortForward } from "@traycer/protocol/host/port-forward";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";

/**
 * The read side of a chat's port forwards.
 *
 * The set rides that chat's own `chat.subscribe` stream
 * (`snapshot.portForwards` + `portForwardsChanged`, `@1.14`), so this is a
 * projection of the chat session store, exactly as the shells' read side is -
 * and bound to the same explicit `hostId`, since a host-minted `chatId` alone
 * does not name a session.
 *
 * Empty means empty: a host too old to send the field cannot forward a port,
 * so there is no "unavailable" to tell apart from "none".
 */
type PortForwardsChatSlice = Pick<ChatSessionState, "portForwards">;

// Stable stand-in for a chat with no live session (its tile is not mounted, or
// the snapshot has yet to land).
const emptyChatSlice = create<PortForwardsChatSlice>()(() => ({
  portForwards: [],
}));

/**
 * What needs a person first, then oldest first. An `interrupted` forward will
 * never come back on its own, so it outranks the ones that are simply working;
 * within a state the order is creation order, so a row does not move when
 * another forward records an event.
 */
function comparePortForwards(a: ChatPortForward, b: ChatPortForward): number {
  const aInterrupted = a.state === "interrupted";
  const bInterrupted = b.state === "interrupted";
  if (aInterrupted !== bInterrupted) return aInterrupted ? -1 : 1;
  return a.createdAtMs - b.createdAtMs;
}

export function usePortForwardsForChat(options: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}): readonly ChatPortForward[] {
  const handle = useExistingChatSessionHandle(
    options.epicId,
    options.chatId,
    options.hostId,
  );
  const forwards = useStore(
    handle === null ? emptyChatSlice : handle.store,
    (state) => state.portForwards,
  );
  return useMemo(() => [...forwards].sort(comparePortForwards), [forwards]);
}
