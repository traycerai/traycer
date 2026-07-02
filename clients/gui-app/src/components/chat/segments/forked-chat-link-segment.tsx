import { GitBranch } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

interface ForkedChatLinkSegmentProps {
  readonly viewTabId: string;
  readonly sourceChatId: string;
  readonly sourceChatTitle: string;
  readonly sourceHostId: string;
}

export function ForkedChatLinkSegment(props: ForkedChatLinkSegmentProps) {
  const { viewTabId, sourceChatId, sourceChatTitle, sourceHostId } = props;
  const openTileInTab = useEpicCanvasStore((state) => state.openTileInTab);

  const openSourceConversation = (): void => {
    openTileInTab(viewTabId, {
      id: sourceChatId,
      instanceId: uuidv4(),
      type: "chat",
      name: sourceChatTitle,
      hostId: sourceHostId,
    });
  };

  return (
    <div
      data-testid="forked-chat-link"
      className="flex w-full items-center gap-3 py-4 text-ui-sm text-muted-foreground"
    >
      <div className="h-px min-w-0 flex-1 bg-border" aria-hidden />
      <button
        type="button"
        data-find-include="true"
        className="inline-flex min-w-0 items-center gap-1.5 text-primary underline underline-offset-4 transition-colors hover:text-primary/80 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        aria-label={`Open source conversation ${sourceChatTitle}`}
        title={sourceChatTitle}
        onClick={openSourceConversation}
      >
        <GitBranch
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="truncate">Forked from conversation</span>
      </button>
      <div className="h-px min-w-0 flex-1 bg-border" aria-hidden />
    </div>
  );
}
