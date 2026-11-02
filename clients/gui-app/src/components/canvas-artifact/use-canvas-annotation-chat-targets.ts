import { useMemo } from "react";
import { useStore } from "zustand";
import {
  resolveQuoteChatTargets,
  type QuoteChatTarget,
} from "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets";
import { useSidebarChatOrder } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useLastFocusedChatStore } from "@/stores/chat/last-focused-chat-store";
import { useOpenTileContentIds } from "@/stores/epics/canvas/store";
import type { CanvasAnnotationScope } from "./canvas-annotation-action";

/**
 * The chats an artifact selection can be sent to: every chat in the Task, the
 * same roster the markdown text quote offers. An artifact is projected onto
 * every host serving the epic, so no chat is on the wrong host for it, and
 * the one picker serves the selection bar and the comment draft box alike.
 */
export function useCanvasAnnotationChatTargets(
  scope: Pick<CanvasAnnotationScope, "epicId" | "viewTabId">,
): ReadonlyArray<QuoteChatTarget> {
  const handle = useOpenEpicHandle();
  const chats = useStore(handle.store, (state) => state.chats);
  const orderedChatIds = useSidebarChatOrder(scope.epicId);
  const openChatIds = useOpenTileContentIds(scope.viewTabId);
  const lastFocusedChatId = useLastFocusedChatStore(
    (state) => state.chatIdByEpicId[scope.epicId] ?? null,
  );
  return useMemo(
    () =>
      resolveQuoteChatTargets({
        orderedChatIds,
        chats,
        openChatIds,
        lastFocusedChatId,
        sourceHostId: null,
      }),
    [orderedChatIds, chats, openChatIds, lastFocusedChatId],
  );
}
