import { useCallback } from "react";
import { create, useStore } from "zustand";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import type {
  ChatSessionState,
  FallbackChoiceLease,
} from "@/stores/chats/chat-session-store";

type ChoiceLeaseSlice = Pick<ChatSessionState, "fallbackChoiceLease">;

/** No live session: no hold to take, and nothing held. */
const emptySlice = create<ChoiceLeaseSlice>()(() => ({
  fallbackChoiceLease: null,
}));

export interface FallbackChoiceLeaseHandle {
  /** The live lease, or `null` when no hold has been asked for. */
  readonly lease: FallbackChoiceLease | null;
  /** Freeze the grace window and ask for a token. */
  readonly hold: (traversalId: string) => void;
  /** Resume the frozen remainder and clear the slot. */
  readonly release: () => void;
}

/**
 * The grace-hold lease, for the surface that opens the destination menu.
 *
 * Reaches the chat's own session store rather than routing through
 * `useChatActions`, for the same reason `useChatLastFailedAttempt` does: these
 * surfaces are mounted inside a transcript or a composer that knows its
 * `(epicId, chatId, hostId)` triple but is several layers below the tile that
 * owns the action bundle, and threading two more callbacks through that tree
 * for one menu is plumbing nobody else needs.
 *
 * A chat with no registered session hands back a permanent `null` lease and
 * no-op verbs. That is the honest answer rather than a throw: a published
 * (read-only) chat can render a card describing a frozen transcript, and it has
 * no stream to hold anything on.
 */
export function useFallbackChoiceLease(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}): FallbackChoiceLeaseHandle {
  const { epicId, chatId, hostId } = input;
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  const store = handle === null ? emptySlice : handle.store;
  const lease = useStore(store, (state) => state.fallbackChoiceLease);

  const hold = useCallback(
    (traversalId: string) => {
      if (handle === null) return;
      handle.store.getState().fallbackHoldForChoice(traversalId);
    },
    [handle],
  );
  const release = useCallback(() => {
    if (handle === null) return;
    handle.store.getState().fallbackReleaseChoice();
  }, [handle]);

  return { lease, hold, release };
}
