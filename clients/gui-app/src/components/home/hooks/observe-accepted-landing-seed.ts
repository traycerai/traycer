import {
  draftAuthorityActorIsCurrent,
  subscribeToDraftAuthoritySessionChanges,
} from "@/lib/drafts/draft-authority-session";
import type { DraftAuthorityActor } from "@/lib/drafts/draft-authority-types";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import {
  initialChatHandoffKey,
  useInitialChatHandoffStore,
} from "@/stores/epics/initial-chat-handoff-store";

export function observeAcceptedLandingSeed(input: {
  readonly actor: DraftAuthorityActor;
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly clientActionId: string;
  readonly accepted: () => void;
}): void {
  const { actor, hostId, epicId, chatId, messageId, clientActionId } = input;
  if (!draftAuthorityActorIsCurrent(actor)) return;
  const registry = getChatSessionRegistry();
  const key = initialChatHandoffKey({ hostId, epicId, userId: actor.accountId });
  let handle: ChatSessionStoreHandle | null = null;
  let stopHandle: (() => void) | null = null;
  const stop = (): void => {
    stopHandle?.();
    stopRegistry();
    stopSeed();
    stopSession();
  };
  const check = (): void => {
    if (!draftAuthorityActorIsCurrent(actor)) {
      stop();
      return;
    }
    const state = handle?.store.getState();
    if (state !== undefined && (
      state.pendingActions[clientActionId]?.messageConfirmedByHost === true ||
      state.acceptedActions[clientActionId]?.confirmedByHost === true ||
      state.messages.some(
        (message) => message.role === "user" && message.messageId === messageId,
      )
    )) {
      stop();
      input.accepted();
      return;
    }
    const handoff = useInitialChatHandoffStore.getState().handoffs[key];
    if (
      handoff === undefined ||
      handoff.status === "failed" ||
      handoff.chatId !== chatId ||
      handoff.clientActionId !== clientActionId ||
      handoff.messageId !== messageId
    ) stop();
  };
  const reconnect = (): void => {
    const next = registry.peek(epicId, chatId, hostId);
    if (handle !== next) {
      stopHandle?.();
      handle = next;
      stopHandle = handle?.store.subscribe(check) ?? null;
    }
    check();
  };
  const stopRegistry = registry.subscribe(reconnect);
  const stopSeed = useInitialChatHandoffStore.subscribe(check);
  const stopSession = subscribeToDraftAuthoritySessionChanges(stop);
  reconnect();
}

