import { ChevronDown, ChevronUp, Pause, Pencil, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatQueuedItem } from "@traycer/protocol/host/agent/gui/subscribe";
import { useQueuePauseState } from "@/components/chat/queued-message-utils";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";

interface ChatControlStripProps {
  readonly state: Pick<ChatSessionState, "queue">;
  readonly canAct: boolean;
  readonly editingQueueItemId: string | null;
  readonly onQueuePause: () => string | null;
  readonly onResumeQueue: () => string | null;
  readonly onQueueEdit: (item: ChatQueuedItem) => void;
  readonly onQueueCancel: (item: ChatQueuedItem) => void;
  readonly onQueueReorder: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
}

export function ChatControlStrip(props: ChatControlStripProps) {
  if (
    props.state.queue.items.length === 0 &&
    props.editingQueueItemId === null
  ) {
    return null;
  }

  return (
    <div className="border-t border-canvas-border/70 bg-canvas px-4 py-3">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <QueuePanel
          items={props.state.queue.items}
          status={props.state.queue.status}
          canAct={props.canAct}
          editingQueueItemId={props.editingQueueItemId}
          onQueuePause={props.onQueuePause}
          onResumeQueue={props.onResumeQueue}
          onEdit={props.onQueueEdit}
          onCancel={props.onQueueCancel}
          onReorder={props.onQueueReorder}
        />
      </div>
    </div>
  );
}

function QueuePanel(props: {
  readonly items: ReadonlyArray<ChatQueuedItem>;
  readonly status: "idle" | "running" | "paused";
  readonly canAct: boolean;
  readonly editingQueueItemId: string | null;
  readonly onQueuePause: () => string | null;
  readonly onResumeQueue: () => string | null;
  readonly onEdit: (item: ChatQueuedItem) => void;
  readonly onCancel: (item: ChatQueuedItem) => void;
  readonly onReorder: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
}) {
  const { hasPausedItems, hasPausableHumanItems } = useQueuePauseState(
    props.items,
  );
  if (props.items.length === 0) return null;
  return (
    <div
      className="rounded-md border border-canvas-border/70 bg-canvas"
      data-testid="queue-panel"
    >
      <div className="flex items-center justify-between gap-3 border-b border-canvas-border/70 px-3 py-2">
        <div className="text-ui-sm font-medium">
          Queue
          <span className="ml-2 font-normal text-muted-foreground">
            {props.status}
          </span>
        </div>
        {hasPausedItems ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!props.canAct}
            onClick={props.onResumeQueue}
            data-testid="resume-queue-button"
          >
            <Play className="size-3.5" />
            Resume queue
          </Button>
        ) : null}
        {!hasPausedItems && hasPausableHumanItems ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!props.canAct}
            onClick={() => {
              props.onQueuePause();
            }}
            data-testid="pause-queue-button"
          >
            <Pause className="size-3.5" />
            Pause queue
          </Button>
        ) : null}
      </div>
      <div className="divide-y divide-border/70">
        {props.items.map((item, index) => (
          <QueueItemRow
            key={item.queueItemId}
            item={item}
            index={index}
            items={props.items}
            canAct={props.canAct}
            editing={props.editingQueueItemId === item.queueItemId}
            onEdit={props.onEdit}
            onCancel={props.onCancel}
            onReorder={props.onReorder}
          />
        ))}
      </div>
    </div>
  );
}

function QueueItemRow(props: {
  readonly item: ChatQueuedItem;
  readonly index: number;
  readonly items: ReadonlyArray<ChatQueuedItem>;
  readonly canAct: boolean;
  readonly editing: boolean;
  readonly onEdit: (item: ChatQueuedItem) => void;
  readonly onCancel: (item: ChatQueuedItem) => void;
  readonly onReorder: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
}) {
  const preview = previewFromJSONContent(props.item.message.content);
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 text-ui-sm">
        <div className="truncate">
          {preview.length > 0 ? preview : "Queued prompt"}
        </div>
        {props.editing ? (
          <div className="text-ui-xs text-muted-foreground">
            Editing in composer
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={!props.canAct || props.index === 0}
          aria-label="Move queued prompt up"
          onClick={() => {
            props.onReorder(
              props.item,
              props.items[props.index - 1]?.queueItemId ?? null,
            );
          }}
        >
          <ChevronUp className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={!props.canAct || props.index === props.items.length - 1}
          aria-label="Move queued prompt down"
          onClick={() => {
            props.onReorder(
              props.item,
              props.items[props.index + 2]?.queueItemId ?? null,
            );
          }}
        >
          <ChevronDown className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={!props.canAct}
          aria-label="Edit queued prompt"
          onClick={() => {
            props.onEdit(props.item);
          }}
        >
          <Pencil className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={!props.canAct}
          aria-label="Cancel queued prompt"
          onClick={() => {
            props.onCancel(props.item);
          }}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function previewFromJSONContent(content: JsonContent): string {
  const text = extractPlainTextFromComposerJSONContent(content).trim();
  if (text.length <= 120) return text;
  return `${text.slice(0, 117)}...`;
}
