import { create, useStore } from "zustand";
import type { LastFailedAttempt } from "@traycer/protocol/host/agent/gui/subscribe";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";

type LastFailedAttemptSlice = Pick<ChatSessionState, "lastFailedAttempt">;

/**
 * Stand-in for a chat with no live session - its tile is not mounted, or the
 * snapshot has yet to land. `undefined` is the same answer a live session with
 * no admissible rung gives, which is what the caller wants: no affordances.
 */
const emptySlice = create<LastFailedAttemptSlice>()(() => ({
  lastFailedAttempt: undefined,
}));

/**
 * This chat's host-named last failed attempt, read straight off its session.
 *
 * A transcript segment is deep in a rendered message list and does not know
 * which chat it belongs to; `ChatTranscriptContext` carries the `(chatId,
 * hostId)` pair the session registry keys on, and the caller passes it here
 * with the epic. A chat with no registered session answers `undefined` rather
 * than throwing - a transcript can be mounted before its session lands, and a
 * published (read-only) chat never has one.
 *
 * Read BY VALUE and never accumulated. `undefined` is what clears the error
 * card's affordances, so a hook that remembered its last value would keep
 * offering Retry on a turn that has since succeeded - the defect D122 closed on
 * the host side, reintroduced in the renderer.
 */
export function useChatLastFailedAttempt(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}): LastFailedAttempt | undefined {
  const { epicId, chatId, hostId } = input;
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  const store = handle === null ? emptySlice : handle.store;
  return useStore(store, (state) => state.lastFailedAttempt);
}
