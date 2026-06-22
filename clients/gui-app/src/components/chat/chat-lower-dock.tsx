import type {
  ChatActiveTurn,
  ChatQueuedItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { PinnedStackSections } from "@/components/chat/chat-pinned-stack";
import { hasChatPinnedStackContent } from "@/components/chat/chat-pinned-stack-utils";
import { ActiveAgentsPanel } from "@/components/chat/chat-active-agents-panel";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";
import { QueuedMessagePanel } from "@/components/chat/queued-message-surface";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { cn } from "@/lib/utils";
import type { ChatPinnedStackTopSpacing } from "@/components/chat/chat-pinned-stack";

export interface ChatLowerDockProps {
  readonly snapshotLoaded: boolean;
  readonly epicId: string;
  readonly selfAgent: AgentRow | null;
  readonly activeAgents: ReadonlyArray<AgentRow>;
  readonly todo: PinnedTodoSnapshot | null;
  readonly restore: ChatRestoreContextValue;
  readonly queue: ChatSessionState["queue"];
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly editingQueueItemId: string | null;
  readonly topSpacing: ChatPinnedStackTopSpacing;
  readonly scrollRegionMaxHeightClass: string;
  readonly onQueueResume: () => string | null;
  readonly onQueueEdit: (item: ChatQueuedItem) => void;
  readonly onQueueCancel: (item: ChatQueuedItem) => void;
  readonly onQueueAbortSteer: (item: ChatQueuedItem) => void;
  readonly onQueueReorder: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
  readonly onQueueSteerNow: (item: ChatQueuedItem) => void;
}

export function ChatLowerDock(props: ChatLowerDockProps) {
  const pinnedVisible =
    props.snapshotLoaded &&
    hasChatPinnedStackContent(props.todo, props.restore);
  // User-owned and received A2A queue items both surface here (the latter
  // read-only); the panel itself decides how each row renders.
  const queueVisible = props.queue.items.length > 0;
  const agentsVisible =
    props.activeAgents.length > 0 && props.selfAgent !== null;

  if (!pinnedVisible && !queueVisible && !agentsVisible) return null;

  const topPadding = props.topSpacing === "compact" ? "pt-2" : "pt-4";

  return (
    <div
      className={cn("bg-canvas px-4", topPadding)}
      data-testid="chat-lower-dock"
    >
      <div className="mx-auto w-full max-w-3xl">
        <div className="@container mx-3 -mb-px overflow-hidden rounded-t-lg border border-b-0 border-border bg-muted/30">
          {queueVisible ? (
            <QueuedMessagePanel
              queue={props.queue}
              activeTurnStatus={props.activeTurnStatus}
              canAct={props.canAct}
              readOnly={props.readOnly}
              editingQueueItemId={props.editingQueueItemId}
              scrollRegionMaxHeightClass={props.scrollRegionMaxHeightClass}
              separated={false}
              onResume={props.onQueueResume}
              onEdit={props.onQueueEdit}
              onCancel={props.onQueueCancel}
              onAbortSteer={props.onQueueAbortSteer}
              onReorder={props.onQueueReorder}
              onSteerNow={props.onQueueSteerNow}
            />
          ) : null}
          {pinnedVisible ? (
            <div data-testid="chat-pinned-stack">
              <PinnedStackSections
                todo={props.todo}
                restore={props.restore}
                scrollRegionMaxHeightClass={props.scrollRegionMaxHeightClass}
                separated={queueVisible}
              />
            </div>
          ) : null}
          {props.selfAgent !== null && props.activeAgents.length > 0 ? (
            <ActiveAgentsPanel
              epicId={props.epicId}
              self={props.selfAgent}
              descendants={props.activeAgents}
              scrollRegionMaxHeightClass={props.scrollRegionMaxHeightClass}
              separated={queueVisible || pinnedVisible}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
