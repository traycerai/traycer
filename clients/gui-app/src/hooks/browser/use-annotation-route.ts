import { useState, useSyncExternalStore } from "react";

import { useSidebarChatOrder } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import {
  resolveAnnotationRoute,
  type AnnotationRoute,
} from "@/lib/browser-view/annotation/browser-annotation-router";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useLastFocusedChatStore } from "@/stores/chat/last-focused-chat-store";
import { EMPTY_CHATS_SLICE } from "@/stores/epics/open-epic/types";
import type { ChatsSlice } from "@/stores/epics/open-epic/types";

function useEpicChats(): ChatsSlice {
  const handle = useMaybeOpenEpicHandle();
  return useSyncExternalStore(
    (onStoreChange) => {
      if (handle === null) return () => undefined;
      return handle.store.subscribe(onStoreChange);
    },
    () => (handle === null ? EMPTY_CHATS_SLICE : handle.store.getState().chats),
    () => (handle === null ? EMPTY_CHATS_SLICE : handle.store.getState().chats),
  );
}

export function useAnnotationRoute(input: {
  readonly epicId: string;
  readonly tileInstanceId: string;
  readonly browserHostId: string;
  readonly preferredChatId: string | null;
  readonly fallbackChatId: string | null;
}): AnnotationRoute {
  const lastFocusedChatId = useLastFocusedChatStore(
    (state) => state.chatIdByEpicId[input.epicId] ?? null,
  );
  const chats = useEpicChats();
  const orderedChatIds = useSidebarChatOrder(input.epicId);
  const [remembered, setRemembered] = useState({
    tileInstanceId: input.tileInstanceId,
    chatId: input.preferredChatId,
  });
  const rememberedChatId =
    remembered.tileInstanceId === input.tileInstanceId
      ? remembered.chatId
      : null;
  const nextRememberedChatId = input.preferredChatId ?? rememberedChatId;
  if (
    remembered.tileInstanceId !== input.tileInstanceId ||
    remembered.chatId !== nextRememberedChatId
  ) {
    setRemembered({
      tileInstanceId: input.tileInstanceId,
      chatId: nextRememberedChatId,
    });
  }
  const preferredChatId = nextRememberedChatId ?? input.fallbackChatId;
  return resolveAnnotationRoute({
    orderedChatIds,
    chats,
    browserHostId: input.browserHostId,
    preferredChatId,
    lastFocusedChatId,
  });
}
