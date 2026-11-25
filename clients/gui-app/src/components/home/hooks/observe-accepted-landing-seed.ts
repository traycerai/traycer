import {
  draftAuthorityActorIsCurrent,
  subscribeToDraftAuthoritySessionChanges,
} from "@/lib/drafts/draft-authority-session";
import {
  readDraftAuthoritySlot,
  sameDraftAuthoritySlot,
  subscribeToDraftAuthorityChanges,
} from "@/lib/drafts/draft-authority";
import type {
  DraftAuthorityActor,
  DraftAuthorityVersion,
} from "@/lib/drafts/draft-authority-types";
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
  readonly observation:
    | { readonly kind: "handoff" }
    | { readonly kind: "observe-only"; readonly source: DraftAuthorityVersion };
  readonly accepted: () => void;
}): void {
  const { actor, hostId, epicId, chatId, messageId, clientActionId, observation } = input;
  if (!draftAuthorityActorIsCurrent(actor)) return;
  const registry = getChatSessionRegistry();
  const key = initialChatHandoffKey({ hostId, epicId, userId: actor.accountId });
  let handle: ChatSessionStoreHandle | null = null;
  let stopHandle: (() => void) | null = null;
  const stop = (): void => {
    stopHandle?.();
    stopRegistry();
    stopSeed?.();
    stopSource?.();
    stopSession();
  };
  const check = (): void => {
    if (!draftAuthorityActorIsCurrent(actor)) {
      stop();
      return;
    }
    const state = handle?.store.getState();
    const pending = state?.pendingActions[clientActionId];
    const accepted = state?.acceptedActions[clientActionId];
    if (
      (pending?.messageConfirmedByHost === true && pending.messageId === messageId) ||
      (accepted?.confirmedByHost === true && accepted.messageId === messageId) ||
      state?.messages.some(
        (message) => message.role === "user" && message.messageId === messageId,
      ) === true
    ) {
      stop();
      input.accepted();
      return;
    }
    if (observation.kind === "observe-only") return;
    const handoffs = useInitialChatHandoffStore.getState().handoffs;
    if (!Object.hasOwn(handoffs, key)) {
      stop();
      return;
    }
    const handoff = handoffs[key];
    if (
      handoff.status === "failed" ||
      handoff.hostId !== hostId ||
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
  const stopSeed = observation.kind === "handoff"
    ? useInitialChatHandoffStore.subscribe(check)
    : null;
  const stopSession = subscribeToDraftAuthoritySessionChanges(stop);
  let stopSource: (() => void) | null = null;
  if (observation.kind === "observe-only") {
    const { source } = observation;
    const checkSource = (): void => {
      void readDraftAuthoritySlot(source.slot).then((read) => {
        if (
          read.kind === "missing" ||
          (read.kind === "current" && (
            read.record.kind !== "live" ||
            read.record.draft.occurrence !== source.occurrence ||
            read.record.draft.version !== source.version
          ))
        ) {
          stop();
        }
      }).catch(() => undefined);
    };
    stopSource = subscribeToDraftAuthorityChanges((slot) => {
      if (sameDraftAuthoritySlot(slot, source.slot)) checkSource();
    });
    checkSource();
  }
  reconnect();
}
