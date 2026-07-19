import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import type {
  BackgroundItem,
  ChatActiveTurn,
  ChatApprovalState,
  ChatFileEditApprovalState,
  ChatQueuedItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { InterviewAnswer } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatForkMode } from "@/components/chat/chat-message";
import {
  ChatComposer,
  type ChatComposerSubmitInput,
} from "@/components/chat/composer/chat-composer";
import { ChatComposerBannerPortalProvider } from "@/components/chat/composer/chat-composer-banner-portal";
import { ChatLowerDock } from "@/components/chat/chat-lower-dock";
import {
  type ChatLowerSurfaceTopSpacing,
  type ChatPinnedStackTopSpacing,
} from "@/components/chat/chat-pinned-stack";
import { hasChatPinnedStackContent } from "@/components/chat/chat-pinned-stack-utils";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import { useAgentStopControls } from "@/hooks/agent/use-agent-stop-controls";
import { useAgentStop } from "@/hooks/agent/use-stop-agent-mutation";
import { StopChildrenDialog } from "@/components/chat/chat-stop-children-dialog";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { PendingInterviewCard } from "@/components/chat/segments/pending-interview/pending-interview-card";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";
import { ComposerSlotFileEditApprovalQueue } from "@/components/chat/segments/composer-slot-file-edit-approval-queue";
import { ComposerReadonlyWorkspaceModeRow } from "@/components/home/composer/composer-workspace-mode-row";
import { lowerScrollRegionMaxHeightClass } from "@/lib/chat/chat-lower-scroll-budget";
import type { WorkspaceComposerAvailability } from "@/lib/composer/workspace-composer-availability";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { cn } from "@/lib/utils";
import type { PendingInterviewView } from "./chat-tile-types";
import {
  composerHasBlockingApprovals,
  visibleComposerApprovals,
} from "./chat-approval-visibility";

type ComposerSlotBottomSpacing = "normal" | "none";

export interface ChatLowerInteractionSurfacesProps {
  readonly epicId: string;
  readonly chatId: string;
  readonly runtime: ChatLowerRuntimeState;
  readonly access: ChatLowerAccessState;
  readonly turn: ChatLowerTurnState;
  readonly interview: ChatLowerInterviewState;
  readonly approvals: ChatLowerApprovalsState;
  readonly queue: ChatLowerQueueState;
  readonly composer: ChatLowerComposerState;
  readonly todo: PinnedTodoSnapshot | null;
  readonly restoreContext: ChatRestoreContextValue;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  readonly backgroundStopPendingTaskIds: ReadonlySet<string>;
  readonly backgroundStopAllPending: boolean;
  readonly onBackgroundItemClick: (item: BackgroundItem) => void;
}

export interface ChatLowerRuntimeState {
  readonly snapshotLoaded: boolean;
}

export interface ChatLowerAccessState {
  readonly isViewer: boolean;
  readonly canAct: boolean;
}

export interface ChatLowerTurnState {
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly stopDisabled: boolean;
  readonly onStopTurn: () => string | null;
}

export interface ChatLowerInterviewState {
  readonly pending: PendingInterviewView | null;
  // True while an answer/skip for the pending block is in flight or accepted
  // but unresolved (derived from the chat session's pending/accepted actions).
  // Gates the card so the same action cannot be double-sent.
  readonly isBusy: boolean;
  readonly onAnswer: (
    blockId: string,
    answers: ReadonlyArray<InterviewAnswer>,
  ) => string | null;
  readonly onError: (blockId: string, reason: string) => string | null;
  // Branch the chat at the pending question (see ChatForkMode). null when the
  // pending interview has no stable fork boundary.
  readonly onFork: ((mode: ChatForkMode) => void) | null;
}

export interface ChatLowerApprovalsState {
  readonly pendingFileEditApprovals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly pendingApprovals: ReadonlyArray<ChatApprovalState>;
  readonly onFileEditDecision: (approvalId: string, approved: boolean) => void;
  readonly onApprovalDecision: (approvalId: string, approved: boolean) => void;
}

export interface ChatLowerQueueState {
  readonly editingItem: ChatQueuedItem | null;
  readonly editingItemId: string | null;
  readonly value: ChatSessionState["queue"];
  readonly onPause: () => string | null;
  readonly onResume: () => string | null;
  readonly onEdit: (item: ChatQueuedItem) => void;
  readonly onCancel: (item: ChatQueuedItem) => void;
  readonly onAbortSteer: (item: ChatQueuedItem) => void;
  readonly onCancelEdit: () => void;
  readonly onStopBackgroundItem: (taskId: string) => string | null;
  readonly onStopAllBackgroundItems: () => string | null;
  readonly onReorder: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
  readonly onSteerNow: (item: ChatQueuedItem) => void;
}

export interface ChatLowerComposerState {
  readonly sessionSettingsSeed: ChatRunSettings | null;
  readonly fallbackSettingsSeed: ChatRunSettings | null;
  readonly nodeId: string;
  readonly isActive: boolean;
  readonly mentionRoots: ReadonlyArray<string>;
  readonly fallbackToGlobalMentionRoots: boolean;
  readonly currentEpicId: string;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
  readonly onSettingsChange: ((settings: ChatRunSettings) => void) | null;
  /** The Location / Mode+branch / Environment chip cluster (+ context usage). */
  readonly workspaceControls: ReactNode;
  readonly workspaceAvailability: WorkspaceComposerAvailability;
}

interface ComposerSurfaceModel {
  readonly runtime: ChatLowerRuntimeState;
  readonly access: ChatLowerAccessState;
  readonly turn: ChatLowerTurnState;
  readonly interview: ChatLowerInterviewState;
  readonly approvals: ChatLowerApprovalsState;
  readonly queue: ChatLowerQueueState;
  readonly composer: ChatLowerComposerState;
  readonly pendingApprovalCount: number;
  readonly hasPendingApprovals: boolean;
}

interface ComposerSurfaceLayout {
  readonly topSpacing: ChatLowerSurfaceTopSpacing;
  readonly slotBottomSpacing: ComposerSlotBottomSpacing;
}

export function ChatLowerInteractionSurfaces(
  props: ChatLowerInteractionSurfacesProps,
) {
  const stopControls = useAgentStopControls({
    epicId: props.epicId,
    rootAgentId: props.chatId,
  });
  const activeAgents = stopControls.descendants;
  const agentStop = useAgentStop();
  const [stopChildrenOpen, setStopChildrenOpen] = useState(false);

  // Destructure the turn prop for stable use in callbacks
  const turnOnStopTurn = props.turn.onStopTurn;
  const turnActiveTurnStatus = props.turn.activeTurnStatus;
  const turnStopDisabled = props.turn.stopDisabled;

  // Intercept the composer Stop button: when this chat has active
  // sub-agents, raise the cascade prompt instead of stopping only its turn.
  // The button ignores the return value, so `null` here is just "handled".
  const requestStopTurn = useCallback((): string | null => {
    if (activeAgents.length > 0) {
      setStopChildrenOpen(true);
      return null;
    }
    return turnOnStopTurn();
  }, [activeAgents.length, turnOnStopTurn]);

  const turnWithCascade = useMemo(
    () => ({
      activeTurnStatus: turnActiveTurnStatus,
      stopDisabled: turnStopDisabled,
      onStopTurn: requestStopTurn,
    }),
    [turnActiveTurnStatus, turnStopDisabled, requestStopTurn],
  );

  // Memoize on the underlying approvals array: `visibleComposerApprovals`
  // returns a fresh array every call (`.filter`), so without this the derived
  // `composerModel` memo would get a new dependency identity each render and
  // re-render the composer on every streaming token. Render-count proof:
  // chat-tile-composer-rerender.test.tsx.
  const visiblePendingApprovals = useMemo(
    () => visibleComposerApprovals(props.approvals.pendingApprovals),
    [props.approvals.pendingApprovals],
  );
  const pendingApprovalCount =
    props.approvals.pendingFileEditApprovals.length +
    visiblePendingApprovals.length;
  const hasPendingApprovals = composerHasBlockingApprovals(
    props.approvals.pendingApprovals,
    props.approvals.pendingFileEditApprovals.length,
  );
  const pinnedStackVisible =
    props.runtime.snapshotLoaded &&
    hasChatPinnedStackContent(props.todo, props.restoreContext);
  // Show the queue surface whenever it holds anything - user-typed sends and
  // received A2A responses alike (the latter render read-only).
  const queueVisible = props.queue.value.items.length > 0;
  const backgroundVisible =
    props.backgroundItems !== undefined && props.backgroundItems.length > 0;
  const activeAgentsVisible =
    stopControls.self !== null && activeAgents.length > 0;
  const approvalVisible = approvalSurfaceVisible(
    props.runtime.snapshotLoaded,
    props.access.isViewer,
    pendingApprovalCount,
  );
  const scrollRegionMaxHeightClass = lowerScrollRegionMaxHeightClass({
    pinnedStackVisible,
    queueVisible,
    backgroundVisible,
    activeAgentsVisible,
    approvalVisible,
  });
  const lowerSurfaceTopSpacing: ChatLowerSurfaceTopSpacing =
    pinnedStackVisible ||
    queueVisible ||
    activeAgents.length > 0 ||
    backgroundVisible
      ? "connected"
      : "normal";
  const pinnedStackTopSpacing: ChatPinnedStackTopSpacing = approvalVisible
    ? "compact"
    : "normal";

  // Memoize layout props since they depend on visibility flags that only change
  // when content appears/disappears, not per token
  const approvalLayout = useMemo(
    () => ({
      topSpacing: "normal" as const,
      slotBottomSpacing:
        pinnedStackVisible || queueVisible
          ? ("none" as const)
          : ("normal" as const),
    }),
    [pinnedStackVisible, queueVisible],
  );

  const composerLayout = useMemo(
    () => ({
      topSpacing: lowerSurfaceTopSpacing,
      slotBottomSpacing: "normal" as const,
    }),
    [lowerSurfaceTopSpacing],
  );

  const composerModel = useMemo(
    () => ({
      runtime: props.runtime,
      access: props.access,
      turn: turnWithCascade,
      interview: props.interview,
      approvals: {
        ...props.approvals,
        pendingApprovals: visiblePendingApprovals,
      },
      queue: props.queue,
      composer: props.composer,
      pendingApprovalCount,
      hasPendingApprovals,
    }),
    [
      props.runtime,
      props.access,
      turnWithCascade,
      props.interview,
      props.approvals,
      visiblePendingApprovals,
      props.queue,
      props.composer,
      pendingApprovalCount,
      hasPendingApprovals,
    ],
  );

  return (
    <ChatComposerBannerPortalProvider>
      <RuntimeGatedApprovalSurface
        model={composerModel}
        layout={approvalLayout}
      />
      <ChatLowerDock
        snapshotLoaded={props.runtime.snapshotLoaded}
        epicId={props.epicId}
        selfAgent={stopControls.self}
        activeAgents={activeAgents}
        todo={props.todo}
        restore={props.restoreContext}
        queue={props.queue.value}
        backgroundItems={props.backgroundItems}
        backgroundStopPendingTaskIds={props.backgroundStopPendingTaskIds}
        backgroundStopAllPending={props.backgroundStopAllPending}
        activeTurnStatus={props.turn.activeTurnStatus}
        canAct={props.access.canAct}
        readOnly={props.access.isViewer}
        editingQueueItemId={props.queue.editingItemId}
        topSpacing={pinnedStackTopSpacing}
        scrollRegionMaxHeightClass={scrollRegionMaxHeightClass}
        onQueuePause={props.queue.onPause}
        onQueueResume={props.queue.onResume}
        onQueueEdit={props.queue.onEdit}
        onQueueCancel={props.queue.onCancel}
        onQueueAbortSteer={props.queue.onAbortSteer}
        onQueueReorder={props.queue.onReorder}
        onQueueSteerNow={props.queue.onSteerNow}
        onBackgroundItemClick={props.onBackgroundItemClick}
        onBackgroundItemStop={props.queue.onStopBackgroundItem}
        onBackgroundItemsStopAll={props.queue.onStopAllBackgroundItems}
      />
      <ChatComposerRegion model={composerModel} layout={composerLayout} />
      <StopChildrenDialog
        open={stopChildrenOpen}
        onOpenChange={setStopChildrenOpen}
        agents={activeAgents}
        onStopAll={() => {
          agentStop.mutate({
            epicId: props.epicId,
            agentId: props.chatId,
            cascade: true,
          });
          setStopChildrenOpen(false);
        }}
        onStopOnlyThis={() => {
          props.turn.onStopTurn();
          setStopChildrenOpen(false);
        }}
      />
    </ChatComposerBannerPortalProvider>
  );
}

function approvalSurfaceVisible(
  snapshotLoaded: boolean,
  isViewer: boolean,
  pendingApprovalCount: number,
): boolean {
  return snapshotLoaded && !isViewer && pendingApprovalCount > 0;
}

function RuntimeGatedApprovalSurface(props: {
  readonly model: ComposerSurfaceModel;
  readonly layout: ComposerSurfaceLayout;
}): ReactNode {
  const { model, layout } = props;
  if (
    !model.runtime.snapshotLoaded ||
    model.access.isViewer ||
    model.pendingApprovalCount === 0
  ) {
    return null;
  }
  return (
    <ComposerSlotShell
      topSpacing={layout.topSpacing}
      bottomSpacing={layout.slotBottomSpacing}
    >
      <PendingApprovalQueues
        pendingFileEditApprovals={model.approvals.pendingFileEditApprovals}
        pendingApprovals={model.approvals.pendingApprovals}
        canAct={model.access.canAct}
        onFileEditDecision={model.approvals.onFileEditDecision}
        onApprovalDecision={model.approvals.onApprovalDecision}
      />
    </ComposerSlotShell>
  );
}

const ChatComposerRegion = memo(function ChatComposerRegion(props: {
  readonly model: ComposerSurfaceModel;
  readonly layout: ComposerSurfaceLayout;
}): ReactNode {
  const { model, layout } = props;
  return <ComposerSurface model={model} layout={layout} />;
});

function ComposerSurface(props: {
  readonly model: ComposerSurfaceModel;
  readonly layout: ComposerSurfaceLayout;
}): ReactNode {
  const { model, layout } = props;
  if (!model.runtime.snapshotLoaded) {
    return null;
  }
  if (model.access.isViewer) {
    return (
      <ComposerSlotShell topSpacing={layout.topSpacing} bottomSpacing="normal">
        <div className="flex flex-col gap-3">
          <ReadOnlyComposerNotice />
          <ComposerReadonlyWorkspaceModeRow
            workspaceSlot={model.composer.workspaceControls}
            agentMode={model.composer.sessionSettingsSeed?.agentMode ?? null}
          />
        </div>
      </ComposerSlotShell>
    );
  }
  if (model.interview.pending !== null) {
    return (
      <ComposerSlotShell topSpacing={layout.topSpacing} bottomSpacing="normal">
        <PendingInterviewCard
          key={`${model.composer.nodeId}:${model.interview.pending.blockId}`}
          chatId={model.composer.nodeId}
          blockId={model.interview.pending.blockId}
          toolName={model.interview.pending.toolName}
          title={model.interview.pending.title}
          description={model.interview.pending.description}
          questions={model.interview.pending.questions}
          isActive={model.composer.isActive}
          isBusy={model.interview.isBusy}
          onSubmit={model.access.canAct ? model.interview.onAnswer : null}
          onSkip={model.access.canAct ? model.interview.onError : null}
          onFork={model.access.canAct ? model.interview.onFork : null}
        />
      </ComposerSlotShell>
    );
  }
  return (
    <LiveChatComposer
      model={model}
      topSpacing={layout.topSpacing}
      hasPendingApprovals={model.hasPendingApprovals}
    />
  );
}

function LiveChatComposer(props: {
  readonly model: ComposerSurfaceModel;
  readonly topSpacing: ChatLowerSurfaceTopSpacing;
  readonly hasPendingApprovals: boolean;
}) {
  const { model } = props;
  return (
    <ChatComposer
      key={model.queue.editingItem?.queueItemId}
      taskId={model.composer.nodeId}
      isActive={model.composer.isActive}
      sendDisabled={!model.access.canAct}
      mentionRoots={model.composer.mentionRoots}
      fallbackToGlobalMentionRoots={model.composer.fallbackToGlobalMentionRoots}
      currentEpicId={model.composer.currentEpicId}
      settingsSeed={
        model.queue.editingItem?.settings ?? model.composer.sessionSettingsSeed
      }
      fallbackSettingsSeed={model.composer.fallbackSettingsSeed}
      onSubmitMessage={model.composer.onSubmitMessage}
      onSettingsChange={model.composer.onSettingsChange}
      activeTurnStatus={model.turn.activeTurnStatus}
      editingQueueItemId={model.queue.editingItem?.queueItemId ?? null}
      onCancelQueueEdit={model.queue.onCancelEdit}
      hasPendingApprovals={props.hasPendingApprovals}
      stopDisabled={model.turn.stopDisabled}
      onStopTurn={model.turn.onStopTurn}
      workspaceControls={model.composer.workspaceControls}
      workspaceAvailability={model.composer.workspaceAvailability}
      topSpacing={props.topSpacing}
      topSlot={null}
    />
  );
}

function PendingApprovalQueues(props: {
  readonly pendingFileEditApprovals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly pendingApprovals: ReadonlyArray<ChatApprovalState>;
  readonly canAct: boolean;
  readonly onFileEditDecision: (approvalId: string, approved: boolean) => void;
  readonly onApprovalDecision: (approvalId: string, approved: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ComposerSlotFileEditApprovalQueue
        approvals={props.pendingFileEditApprovals}
        canAct={props.canAct}
        onDecision={props.onFileEditDecision}
      />
      <ComposerSlotApprovalQueue
        approvals={props.pendingApprovals}
        canAct={props.canAct}
        onDecision={props.onApprovalDecision}
      />
    </div>
  );
}

function ComposerSlotShell(props: {
  readonly children: ReactNode;
  readonly topSpacing: ChatLowerSurfaceTopSpacing;
  readonly bottomSpacing: ComposerSlotBottomSpacing;
}) {
  return (
    <div
      className={cn(
        "bg-canvas px-4",
        props.topSpacing === "normal" ? "pt-4" : "pt-0",
        props.bottomSpacing === "normal" ? "pb-4" : "pb-0",
      )}
    >
      <div className="mx-auto w-full max-w-3xl">{props.children}</div>
    </div>
  );
}

function ReadOnlyComposerNotice() {
  return (
    <div className="rounded-md border border-canvas-border/70 bg-canvas px-3 py-2 text-ui-sm text-muted-foreground">
      Read-only viewer. The chat owner can send prompts and manage this queue.
    </div>
  );
}
