import { useCallback } from "react";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";

/**
 * Delivers a fallback outcome that no mounted surface will report.
 *
 * The callback deliberately OUTLIVES the component that created it. It closes
 * over the session handle, not over React state, and a released chat session
 * stays warm for ten minutes - so a mutation resolving well after its popover
 * (and its card, and its live region) have gone still has somewhere to put the
 * answer. That is the whole point: a menu's per-call
 * `mutate(vars, { onSuccess })` handler is skipped once its observer has no
 * listeners, so before this the refusal was not late, it was lost.
 */
export type UnattendedFallbackOutcomePublisher = (text: string) => void;

/**
 * Publishes an unattended fallback outcome onto this chat's session store, for
 * the persistent transcript announcer to speak.
 *
 * Reaches the session store directly, as `usePublishConfirmedManualFallbackAction`,
 * `useChatLastFailedAttempt` and `useFallbackChoiceLease` do, and for the same
 * reason: these surfaces know their `(epicId, chatId, hostId)` triple but sit
 * well below the tile that owns the announcer.
 *
 * A no-op when the registry has no handle for the triple. That is a real state
 * (a card rendered outside a live chat session) and not one worth an error:
 * there is no announcer listening either, so the sentence has no destination
 * whether or not it is recorded.
 */
export function usePublishUnattendedFallbackOutcome(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}): UnattendedFallbackOutcomePublisher {
  const { epicId, chatId, hostId } = input;
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  return useCallback(
    (text: string) => {
      if (handle === null) return;
      handle.store.getState().publishUnattendedFallbackOutcome({
        hostId,
        epicId,
        chatId,
        text,
      });
    },
    [chatId, epicId, handle, hostId],
  );
}
