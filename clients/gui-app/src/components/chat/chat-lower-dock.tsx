import type {
  BackgroundItem,
  ChatActiveTurn,
  ChatQueuedItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { PinnedStackSections } from "@/components/chat/chat-pinned-stack";
import { hasChatPinnedStackContent } from "@/components/chat/chat-pinned-stack-utils";
import { ActiveAgentsPanel } from "@/components/chat/chat-active-agents-panel";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";
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
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  readonly backgroundStopPendingTaskIds: ReadonlySet<string>;
  readonly backgroundStopAllPending: boolean;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly editingQueueItemId: string | null;
  readonly topSpacing: ChatPinnedStackTopSpacing;
  readonly scrollRegionMaxHeightClass: string;
  readonly onQueuePause: () => string | null;
  readonly onQueueResume: () => string | null;
  readonly onQueueEdit: (item: ChatQueuedItem) => void;
  readonly onQueueCancel: (item: ChatQueuedItem) => void;
  readonly onQueueAbortSteer: (item: ChatQueuedItem) => void;
  readonly onQueueReorder: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
  readonly onQueueSteerNow: (item: ChatQueuedItem) => void;
  readonly onBackgroundItemClick: (item: BackgroundItem) => void;
  readonly onBackgroundItemStop: (taskId: string) => string | null;
  readonly onBackgroundItemsStopAll: () => string | null;
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
  const backgroundVisible =
    props.backgroundItems !== undefined && props.backgroundItems.length > 0;

  if (!pinnedVisible && !queueVisible && !agentsVisible && !backgroundVisible) {
    return null;
  }

  const topPadding = props.topSpacing === "compact" ? "pt-2" : "pt-4";

  return (
    <div
      className={cn("bg-canvas px-4", topPadding)}
      data-testid="chat-lower-dock"
    >
      <div className="mx-auto w-full max-w-3xl">
        <div className="@container mx-3 -mb-px overflow-hidden rounded-t-lg border border-b-0 border-border bg-muted/30">
          <QueueSection visible={queueVisible} dock={props} />
          <PinnedSection
            visible={pinnedVisible}
            separated={queueVisible}
            dock={props}
          />
          <AgentsSection
            visible={agentsVisible}
            separated={queueVisible || pinnedVisible}
            dock={props}
          />
          <BackgroundSection
            visible={backgroundVisible}
            separated={queueVisible || pinnedVisible || agentsVisible}
            dock={props}
          />
        </div>
      </div>
    </div>
  );
}

function QueueSection(props: {
  readonly visible: boolean;
  readonly dock: ChatLowerDockProps;
}) {
  if (!props.visible) return null;
  const { dock } = props;
  return (
    <QueuedMessagePanel
      queue={dock.queue}
      activeTurnStatus={dock.activeTurnStatus}
      canAct={dock.canAct}
      readOnly={dock.readOnly}
      editingQueueItemId={dock.editingQueueItemId}
      scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
      separated={false}
      onPause={dock.onQueuePause}
      onResume={dock.onQueueResume}
      onEdit={dock.onQueueEdit}
      onCancel={dock.onQueueCancel}
      onAbortSteer={dock.onQueueAbortSteer}
      onReorder={dock.onQueueReorder}
      onSteerNow={dock.onQueueSteerNow}
    />
  );
}

function PinnedSection(props: {
  readonly visible: boolean;
  readonly separated: boolean;
  readonly dock: ChatLowerDockProps;
}) {
  if (!props.visible) return null;
  const { dock } = props;
  return (
    <div data-testid="chat-pinned-stack">
      <PinnedStackSections
        todo={dock.todo}
        restore={dock.restore}
        scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
        separated={props.separated}
      />
    </div>
  );
}

function AgentsSection(props: {
  readonly visible: boolean;
  readonly separated: boolean;
  readonly dock: ChatLowerDockProps;
}) {
  const { dock } = props;
  const selfAgent = dock.selfAgent;
  if (!props.visible || selfAgent === null) return null;
  return (
    <ActiveAgentsPanel
      epicId={dock.epicId}
      self={selfAgent}
      descendants={dock.activeAgents}
      scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
      separated={props.separated}
    />
  );
}

function BackgroundSection(props: {
  readonly visible: boolean;
  readonly separated: boolean;
  readonly dock: ChatLowerDockProps;
}) {
  const { dock } = props;
  const items = dock.backgroundItems;
  if (!props.visible || items === undefined) return null;
  return (
    <BackgroundItemsPanel
      items={items}
      canAct={dock.canAct}
      readOnly={dock.readOnly}
      pendingStopTaskIds={dock.backgroundStopPendingTaskIds}
      stopAllPending={dock.backgroundStopAllPending}
      scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
      separated={props.separated}
      onItemClick={dock.onBackgroundItemClick}
      onStopItem={dock.onBackgroundItemStop}
      onStopAll={dock.onBackgroundItemsStopAll}
    />
  );
}
