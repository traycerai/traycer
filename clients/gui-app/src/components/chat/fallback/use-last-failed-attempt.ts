import { create, useStore } from "zustand";
import type { LastFailedAttempt } from "@traycer/protocol/host/agent/gui/subscribe";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { fallbackComposerCardVisible } from "./fallback-state";

type LastFailedAttemptSlice = Pick<
  ChatSessionState,
  "lastFailedAttempt" | "pendingFallback"
>;

/**
 * Stand-in for a chat with no live session - its tile is not mounted, or the
 * snapshot has yet to land. `undefined` is the same answer a live session with
 * no admissible rung gives, which is what the caller wants: no affordances.
 */
const emptySlice = create<LastFailedAttemptSlice>()(() => ({
  lastFailedAttempt: undefined,
  pendingFallback: undefined,
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

/**
 * Whether a fallback traversal is live on this chat right now.
 *
 * Exists because `lastFailedAttempt` stopped answering "nothing holds
 * dispatch". That used to be part of what the host's manual-rung guard chain
 * MEANT - {@link useChatLastFailedAttempt}'s consumers were written against it,
 * and `fallback-manual-rungs.tsx` still states it as the reason the error row
 * needs no gating logic of its own. Then the grace card was given manual rungs,
 * which needed the same field defined DURING a hold, so the host grew a
 * carve-out for exactly that case - and the transcript's error row, reading the
 * same field, silently came back with it. Two switch controls on screen at once,
 * and the row's one is the leaseless one: its menu is built `preparing={false}`
 * under a comment reading "No hold to take: there is no countdown here to
 * freeze", which the carve-out made false. Open it during a countdown, let the
 * window expire, and the pick returns `rung_unavailable`.
 *
 * So the row asks this instead. The rule it encodes: while a traversal is live,
 * the COMPOSER's card owns the routing conversation, because that card is the
 * only surface whose controls take the choice lease. The error row is the
 * SETTLED surface, and it comes back the moment the traversal ends - which is
 * also when `pendingFallback` clears, so there is nothing to remember.
 *
 * **A boolean, not the DTO.** `pendingFallback` carries `graceRemainingMs` and
 * `deadline`, so it is a new object on nearly every frame of a countdown;
 * selecting the whole thing would re-render every error row in the transcript
 * at that rate for a question whose answer changes twice.
 *
 * Read BY VALUE for the same reason as its sibling above: `undefined` is what
 * gives the row back, and a hook that accumulated would strand it.
 *
 * "Live" means a traversal the composer is DRAWING a routing card for - the
 * same predicate the composer's banner slot decides on - not merely a defined
 * `pendingFallback`. The one frame that separates them is a countdown with
 * nothing to try: the composer draws no card for it (spec Flow 1: "the
 * failed-turn card shows instead"), so the row must not stand down for it
 * either, or the error would sit on screen with no controls anywhere.
 */
export function useChatFallbackTraversalIsLive(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}): boolean {
  const { epicId, chatId, hostId } = input;
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  const store = handle === null ? emptySlice : handle.store;
  return useStore(store, (state) =>
    fallbackComposerCardVisible(state.pendingFallback),
  );
}
