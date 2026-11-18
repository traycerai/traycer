import { useMemo, useState } from "react";
import { useStore } from "zustand";
import { ChevronDown } from "lucide-react";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { Button } from "@/components/ui/button";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { useSidebarChatOrder } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { ChatTargetMenu } from "@/components/epic-canvas/renderers/chat-target-menu/chat-target-menu";
import { resolveQuoteChatTargets } from "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets";
import {
  useMaybeOpenEpicHandle,
  useOpenEpicHandle,
} from "@/providers/use-open-epic-handle";
import { useLastFocusedChatStore } from "@/stores/chat/last-focused-chat-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useOpenTileContentIds } from "@/stores/epics/canvas/store";

export function CanvasAnnotationDraftTarget(props: {
  readonly chatId: string;
  readonly record: BrowserAnnotationRecord;
}) {
  const handle = useMaybeOpenEpicHandle();
  const viewTabId = useEpicViewTabId();
  if (handle === null || viewTabId === null) return null;
  return <DraftTarget {...props} viewTabId={viewTabId} />;
}
function DraftTarget(props: {
  readonly chatId: string;
  readonly record: BrowserAnnotationRecord;
  readonly viewTabId: string;
}) {
  const handle = useOpenEpicHandle();
  const hostId = useTabHostId();
  const chats = useStore(handle.store, (state) => state.chats);
  const orderedChatIds = useSidebarChatOrder(handle.epicId);
  const openChatIds = useOpenTileContentIds(props.viewTabId);
  const lastFocusedChatId = useLastFocusedChatStore(
    (state) => state.chatIdByEpicId[handle.epicId] ?? null,
  );
  const targets = useMemo(
    () =>
      resolveQuoteChatTargets({
        orderedChatIds,
        chats,
        openChatIds,
        lastFocusedChatId,
        sourceHostId: hostId,
      }).filter((target) => !target.isOnOtherHost),
    [orderedChatIds, chats, openChatIds, lastFocusedChatId, hostId],
  );
  const [open, setOpen] = useState(false);
  const title =
    targets.find((target) => target.chatId === props.chatId)?.title ?? "Chat";
  return (
    <ChatTargetMenu
      targets={targets}
      open={open}
      onOpenChange={setOpen}
      onClosed={null}
      onSelectNewChat={null}
      onSelectChat={(chatId) => {
        const store = useComposerDraftStore.getState();
        store.addBrowserAnnotation(chatId, props.record);
        if (chatId !== props.chatId)
          store.removeBrowserAnnotation(
            props.chatId,
            props.record.annotationId,
          );
        setOpen(false);
      }}
      trigger={
        <Button size="xs" variant="ghost" aria-label="Change target chat">
          <span className="max-w-48 truncate">{title}</span>
          <ChevronDown />
        </Button>
      }
    />
  );
}
