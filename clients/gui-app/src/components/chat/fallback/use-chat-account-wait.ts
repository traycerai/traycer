import { useCallback, useSyncExternalStore } from "react";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";
import {
  assistantRowId,
  assistantSliceRowId,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { ProvidersListResponse } from "@traycer/protocol/host/provider-schemas";
import { create, useStore } from "zustand";
import type { ChatAccountWait } from "@traycer/protocol/host/agent/gui/subscribe";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { listOffersSignIns } from "@/components/providers/provider-profile-model";

const noWait = create<{ accountWait: ChatAccountWait | null }>()(() => ({
  accountWait: null,
}));

/** The composer already observes this computer's provider list. Adds no list reader. */
export function useChatAccountWait(input: {
  readonly fallbackCardVisible: boolean;
  readonly providersList: ProvidersListResponse | undefined;
  readonly epicId: string | null;
  readonly chatId: string;
  readonly hostId: string;
}): ChatAccountWait | null {
  const handle = useExistingChatSessionHandle(
    input.epicId ?? "",
    input.chatId,
    input.hostId,
  );
  const wait = useStore(
    handle === null ? noWait : handle.store,
    (state) => state.accountWait,
  );
  return input.epicId !== null &&
    !input.fallbackCardVisible &&
    listOffersSignIns(input.providersList)
    ? wait
    : null;
}

/** The failed turn's already-hydrated context; never searches or hydrates history. */
export function useChatAccountWaitAnchor(
  epicId: string | null,
  chatId: string,
  hostId: string,
): ChatSessionAnchor | null {
  const handle = useExistingChatSessionHandle(epicId ?? "", chatId, hostId);
  const subscribe = useCallback(
    (listener: () => void) =>
      handle === null ? () => undefined : handle.store.subscribe(listener),
    [handle],
  );
  const getSnapshot = useCallback((): ChatSessionAnchor | null => {
    if (handle === null) return null;
    const state = handle.store.getState();
    const attempt = state.lastFailedAttempt;
    if (attempt === undefined) return null;
    const rowId = assistantRowId(attempt.turnId);
    const splitRowId = assistantSliceRowId(attempt.turnId, 0, true);
    const context = Object.hasOwn(state.transcriptRowContext, rowId)
      ? state.transcriptRowContext[rowId]
      : null;
    const knownContext =
      context ??
      (Object.hasOwn(state.transcriptRowContext, splitRowId)
        ? state.transcriptRowContext[splitRowId]
        : null);
    if (knownContext?.profileWalkUnprovable === true) return null;
    if (knownContext?.sessionAnchor !== undefined)
      return knownContext.sessionAnchor;
    const message = state.transcriptWindow.records.messages.get(
      attempt.userMessageId,
    )?.record;
    return message?.role === "user" ? message.sessionAnchor : null;
  }, [handle]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
