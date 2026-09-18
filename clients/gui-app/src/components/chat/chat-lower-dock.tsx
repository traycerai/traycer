import type { ReactNode } from "react";
import type {
  BackgroundItem,
  ChatActiveTurn,
  ChatQueuedItem,
  ChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { PinnedTodoPanel } from "@/components/chat/chat-pinned-stack";
import { ChatAccumulatedChangesPanel } from "@/components/chat/chat-accumulated-changes-panel";
import { ActiveAgentsPanel } from "@/components/chat/chat-active-agents-panel";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import type { ChatDockSection } from "@/components/chat/chat-dock-compact-context";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";
import { QueuedMessagePanel } from "@/components/chat/queued-message-surface";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import type { DockSection } from "@/stores/settings/layout-store";
import { cn } from "@/lib/utils";
import type { ChatPinnedStackTopSpacing } from "@/components/chat/chat-pinned-stack";

/** One dock row's hotspot, registered by the tile regardless of which of the
 *  three anchors (ghost row here, real row here, or the compact chip in the
 *  composer strip) currently carries it. */
export interface DockRowHotspot {
  readonly hotspotRef: (node: HTMLElement | null) => void;
  /** No content at all - the setting has nothing to anchor to but this row's
   *  own ghost placeholder, regardless of the Visible/Compact preference. */
  readonly ghost: boolean;
  readonly condition: string;
  readonly editing: boolean;
}

interface LiveChatLowerDockProps {
  readonly snapshotLoaded: boolean;
  readonly epicId: string;
  /** The chat this dock belongs to - the strip's managed-command join key. */
  readonly chatId: string;
  readonly viewTabId: string;
  readonly selfAgent: AgentRow | null;
  readonly activeAgents: ReadonlyArray<AgentRow>;
  readonly todo: PinnedTodoSnapshot | null;
  readonly restore: ChatRestoreContextValue;
  /**
   * The queue as this dock should render it. The caller may have removed the
   * received-A2A rows from it - see `folded` - so this is not always the
   * session's whole queue.
   */
  readonly queue: ChatSessionState["queue"];
  /**
   * Sections currently standing as a chip in the composer's bottom strip
   * instead of as a row here. Decided by the caller, which needs the same
   * answer to size everything below the dock.
   */
  readonly folded: ReadonlySet<ChatDockSection>;
  /** The vertical order of the three reorderable rows below Todo. */
  readonly dockOrder: ReadonlyArray<DockSection>;
  /** This tile's Customize hotspot for each of the three reorderable rows. */
  readonly hotspots: Readonly<Record<DockSection, DockRowHotspot>>;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  /**
   * This chat's running managed commands, counted by the parent because the
   * surfaces around the dock size themselves from the same number - see
   * `chatBackgroundSectionVisible`.
   */
  readonly runningManagedCommandCount: number;
  /**
   * This chat's held shells, counted by the parent for the same reason - and
   * counted separately because the hold a human has to clear sits on a shell
   * that has FINISHED, which the running count above will never see. A chat
   * whose only background state is a hold opens the section on this alone.
   */
  readonly heldManagedCommandCount: number;
  readonly backgroundStopPendingTaskIds: ReadonlySet<string>;
  readonly backgroundStopAllPending: boolean;
  readonly backgroundSessionStopPending: boolean;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly canAct: boolean;
  readonly queueResumeRequested: boolean;
  readonly queueKeepPausedRequested: boolean;
  readonly readOnly: boolean;
  readonly editingQueueItemId: string | null;
  readonly topSpacing: ChatPinnedStackTopSpacing;
  readonly scrollRegionMaxHeightClass: string;
  readonly onQueuePause: () => string | null;
  readonly onQueueResume: () => string | null;
  readonly onQueueEdit: (item: ChatQueuedPromptItem) => void;
  readonly onQueueCancel: (item: ChatQueuedItem) => void;
  readonly onQueueAbortSteer: (item: ChatQueuedPromptItem) => void;
  readonly onQueueReorder: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
  readonly onQueueSteerNow: (item: ChatQueuedPromptItem) => void;
  readonly onBackgroundItemClick: (item: BackgroundItem) => void;
  readonly onBackgroundItemStop: (taskId: string) => string | null;
  readonly onBackgroundItemsStopAll: () => string | null;
  readonly onBackgroundSessionStop: () => string | null;
}

interface DockRowPlan {
  readonly section: DockSection;
  readonly hotspot: DockRowHotspot;
  readonly showGhost: boolean;
  readonly showRow: boolean;
}

interface PresentationChatLowerDockProps {
  readonly presentationRows: Readonly<Record<DockSection, ReactNode>>;
  readonly folded: ReadonlySet<ChatDockSection>;
  readonly dockOrder: ReadonlyArray<DockSection>;
  readonly hotspots: Readonly<Record<DockSection, DockRowHotspot>>;
  readonly topSpacing: ChatPinnedStackTopSpacing;
}
export type ChatLowerDockProps =
  | LiveChatLowerDockProps
  | PresentationChatLowerDockProps;

function planDockRow(
  section: DockSection,
  hotspot: DockRowHotspot,
  folded: ReadonlySet<ChatDockSection>,
): DockRowPlan {
  return {
    section,
    hotspot,
    showGhost: hotspot.ghost && hotspot.editing,
    showRow: !hotspot.ghost && !folded.has(section),
  };
}

export function ChatLowerDock(props: ChatLowerDockProps) {
  const live = "presentationRows" in props ? null : props;
  const todoVisible =
    live !== null && live.snapshotLoaded && live.todo !== null;
  const queueVisible = live !== null && live.queue.items.length > 0;
  const rows = props.dockOrder.map((section) =>
    planDockRow(section, props.hotspots[section], props.folded),
  );
  const anyRowVisible = rows.some((row) => row.showGhost || row.showRow);

  if (!todoVisible && !queueVisible && !anyRowVisible) {
    return null;
  }

  const topPadding = props.topSpacing === "compact" ? "pt-2" : "pt-4";

  return (
    <div className="pointer-events-none px-4" data-testid="chat-lower-dock">
      <div
        className={cn(
          "pointer-events-auto mx-auto w-full max-w-3xl bg-canvas",
          topPadding,
        )}
      >
        <div className="@container mx-3 -mb-px overflow-hidden rounded-t-lg border border-b-0 border-border bg-muted/30">
          {live ? <QueueSection visible={queueVisible} dock={live} /> : null}
          {todoVisible ? (
            <PinnedTodoPanel
              todo={live.todo}
              scrollRegionMaxHeightClass={live.scrollRegionMaxHeightClass}
              separated={queueVisible}
            />
          ) : null}
          {dockRows({
            rows,
            separatedBefore: queueVisible || todoVisible,
            dock: props,
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Plain functions, never JSX components (never invoked as `<X .../>`): each
 * dock row's hotspot ref is a plain callback threaded through here as data,
 * and the react-compiler's ref-safety check treats a same-named prop crossing
 * an actual COMPONENT boundary as a suspect ref access even though this one
 * is not - see the identical `dockHotspot`/`hotspotRef` shape that passes
 * clean one function up, inlined into `ChatLowerDock`'s own render instead of
 * split into child components. Calling these as ordinary functions (not JSX)
 * keeps everything in the one component the compiler already trusts.
 */
function dockRows(props: {
  readonly rows: ReadonlyArray<DockRowPlan>;
  readonly separatedBefore: boolean;
  readonly dock: ChatLowerDockProps;
}): ReactNode {
  let separated = props.separatedBefore;
  const nodes: ReactNode[] = [];
  for (const row of props.rows) {
    if (row.showGhost) {
      nodes.push(
        dockGhostRow({
          key: row.section,
          hotspotRef: row.hotspot.hotspotRef,
          condition: row.hotspot.condition,
          separated,
        }),
      );
      separated = true;
      continue;
    }
    if (!row.showRow) continue;
    nodes.push(
      dockRow({
        key: row.section,
        section: row.section,
        editing: row.hotspot.editing,
        hotspotRef: row.hotspot.hotspotRef,
        separated,
        dock: props.dock,
      }),
    );
    separated = true;
  }
  return nodes;
}

function dockGhostRow(props: {
  readonly key: string;
  readonly hotspotRef: (node: HTMLElement | null) => void;
  readonly condition: string;
  readonly separated: boolean;
}): ReactNode {
  return (
    <div
      key={props.key}
      ref={props.hotspotRef}
      data-testid="chat-dock-ghost-row"
      className={cn(
        "flex items-center px-3 py-2 text-ui-xs text-muted-foreground/60",
        props.separated && "border-t border-border/50",
      )}
    >
      <span className="border-b border-dashed border-muted-foreground/40 pb-px">
        {props.condition}
      </span>
    </div>
  );
}

function dockRow(props: {
  readonly key: string;
  readonly section: DockSection;
  readonly editing: boolean;
  readonly hotspotRef: (node: HTMLElement | null) => void;
  readonly separated: boolean;
  readonly dock: ChatLowerDockProps;
}): ReactNode {
  const { dock } = props;
  if ("presentationRows" in dock)
    return (
      <div
        key={props.key}
        ref={props.hotspotRef}
        className={cn(
          "min-w-0",
          props.separated && "border-t border-border/50",
        )}
      >
        {dock.presentationRows[props.section]}
      </div>
    );
  if (props.section === "filesChanged") {
    return (
      <span
        key={props.key}
        className={cn(props.editing ? "block min-w-0" : "contents")}
        ref={props.hotspotRef}
      >
        <ChatAccumulatedChangesPanel
          restore={dock.restore}
          separated={props.separated}
          scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
        />
      </span>
    );
  }
  if (props.section === "activeAgents") {
    if (dock.selfAgent === null) return null;
    return (
      <span
        key={props.key}
        className={cn(props.editing ? "block min-w-0" : "contents")}
        ref={props.hotspotRef}
      >
        <ActiveAgentsPanel
          epicId={dock.epicId}
          viewTabId={dock.viewTabId}
          self={dock.selfAgent}
          descendants={dock.activeAgents}
          scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
          separated={props.separated}
        />
      </span>
    );
  }
  // An undefined `backgroundItems` is "the host has not said yet"; the
  // managed-command rows come from a different stream and need not wait on it.
  const items = dock.backgroundItems ?? [];
  return (
    <span
      key={props.key}
      className={cn(props.editing ? "block min-w-0" : "contents")}
      ref={props.hotspotRef}
    >
      <BackgroundItemsPanel
        items={items}
        epicId={dock.epicId}
        chatId={dock.chatId}
        viewTabId={dock.viewTabId}
        canAct={dock.canAct}
        readOnly={dock.readOnly}
        pendingStopTaskIds={dock.backgroundStopPendingTaskIds}
        stopAllPending={dock.backgroundStopAllPending}
        sessionStopPending={dock.backgroundSessionStopPending}
        turnActive={dock.activeTurnStatus !== null}
        scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
        separated={props.separated}
        onItemClick={dock.onBackgroundItemClick}
        onStopItem={dock.onBackgroundItemStop}
        onStopAll={dock.onBackgroundItemsStopAll}
        onStopSession={dock.onBackgroundSessionStop}
      />
    </span>
  );
}

function QueueSection(props: {
  readonly visible: boolean;
  readonly dock: LiveChatLowerDockProps;
}) {
  if (!props.visible) return null;
  const { dock } = props;
  return (
    <QueuedMessagePanel
      queue={dock.queue}
      activeTurnStatus={dock.activeTurnStatus}
      canAct={dock.canAct}
      resumeRequested={dock.queueResumeRequested}
      keepPausedRequested={dock.queueKeepPausedRequested}
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
