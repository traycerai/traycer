import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import type {
  BackgroundItem,
  ChatActiveTurn,
  ChatApprovalState,
  ChatFileEditApprovalState,
  ChatQueuedItem,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { InterviewAnswer } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatForkMode } from "@/components/chat/chat-message";
import {
  ChatComposer,
  type ChatComposerSideChatInput,
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
import { UnanswerableInterviewNotice } from "@/components/chat/segments/pending-interview/unanswerable-interview-notice";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";
import { ComposerSlotFileEditApprovalQueue } from "@/components/chat/segments/composer-slot-file-edit-approval-queue";
import { ComposerReadonlyWorkspaceModeRow } from "@/components/home/composer/composer-workspace-mode-row";
import {
  chatBackgroundSectionVisible,
  lowerScrollRegionMaxHeightClass,
} from "@/lib/chat/chat-lower-scroll-budget";
import type { WorkspaceComposerAvailability } from "@/lib/composer/workspace-composer-availability";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import {
  useHeldManagedCommandsForChat,
  useRunningManagedCommandsForChat,
} from "@/stores/managed-commands/managed-commands-for-chat";
import { cn } from "@/lib/utils";
import type {
  PendingInterviewView,
  UnanswerableInterviewView,
} from "./chat-tile-types";
import {
  composerHasBlockingApprovals,
  visibleComposerApprovals,
} from "./chat-approval-visibility";

type ComposerSlotBottomSpacing = "normal" | "none";

export interface ChatLowerInteractionSurfacesProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly chatId: string;
  /**
   * The tile's bound host. A prop rather than a `useTabHostId()` read so this
   * surface stays renderable on its own (several suites mount it directly),
   * and so the host it resolves chat-session state under is visible at the
   * boundary like `epicId` and `chatId` already are.
   */
  readonly hostId: string;
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
  readonly backgroundSessionStopPending: boolean;
  readonly onBackgroundItemClick: (item: BackgroundItem) => void;
}

export interface ChatLowerRuntimeState {
  readonly snapshotLoaded: boolean;
}

export interface ChatLowerAccessState {
  readonly isViewer: boolean;
  readonly canAct: boolean;
  /**
   * Why this surface cannot be typed into, when the reason is not the ordinary
   * one. Null means the ordinary one - a viewer's permission - and the notice
   * says so itself.
   *
   * A reason rather than a second boolean because the states are not
   * alternatives to each other: "you may only watch this chat" and "this chat
   * lives on a machine that is asleep, and you are reading its last backup"
   * are both read-only, and telling a user the first when the second is true
   * sends them looking for a permission to ask for.
   */
  readonly readOnlyNotice: string | null;
}

/**
 * Why the composer's send is blocked, for the send button's tooltip. `canAct`
 * folds role and connection: a viewer can never act; a non-viewer with
 * `canAct === false` means the chat stream is not open (host reconnecting
 * after a drop / renderer resume).
 */
function chatSendDisabledHint(access: ChatLowerAccessState): string | null {
  if (access.canAct) return null;
  if (access.readOnlyNotice !== null) return access.readOnlyNotice;
  if (access.isViewer) return "You have view-only access to this chat";
  return "Reconnecting to the host — sending is paused";
}

export interface ChatLowerTurnState {
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  /** Host-projected same-turn steering capability of the running turn's harness. */
  readonly steerCapable: boolean;
  /**
   * Whether the tab's negotiated `chat.subscribe` version understands
   * `after_safe_point` (host handshake minor >= 5). Gates whether `Mod-Enter`
   * can steer at all, keeping a new renderer from steering a <=1.4 host.
   */
  readonly steerProtocolSupported: boolean;
  /** Reads the live active turn at submit time for the Cmd+Enter drift check. */
  readonly getActiveTurnForSteer: () => ChatActiveTurn | null;
  readonly stopDisabled: boolean;
  readonly onStopTurn: () => string | null;
}

export interface ChatLowerInterviewState {
  readonly pending: PendingInterviewView | null;
  // True while an answer/skip for the pending block is in flight or accepted
  // but unresolved (derived from the chat session's pending/accepted actions).
  // Gates the card so the same action cannot be double-sent.
  readonly isBusy: boolean;
  // Host-pending interviews with no answerable card in this transcript. Non-
  // empty means the chat is send-locked with nothing to answer, so the escape-
  // hatch notice renders above whatever else occupies the composer slot.
  readonly unanswerable: ReadonlyArray<UnanswerableInterviewView>;
  // True while a dismissal for any `unanswerable` block is in flight.
  readonly unanswerableBusy: boolean;
  readonly onAnswer: (
    blockId: string,
    answers: ReadonlyArray<InterviewAnswer>,
  ) => string | null;
  readonly onSkip: (
    blockId: string,
    reason: string,
    draftAnswers: ReadonlyArray<InterviewAnswer> | undefined,
  ) => string | null;
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
  readonly editingItem: ChatQueuedPromptItem | null;
  readonly editingItemId: string | null;
  readonly value: ChatSessionState["queue"];
  readonly resumeRequested: boolean;
  readonly keepPausedRequested: boolean;
  readonly onPause: () => string | null;
  readonly onResume: () => string | null;
  readonly onEdit: (item: ChatQueuedPromptItem) => void;
  readonly onCancel: (item: ChatQueuedItem) => void;
  readonly onAbortSteer: (item: ChatQueuedPromptItem) => void;
  readonly onCancelEdit: () => void;
  readonly onStopBackgroundItem: (taskId: string) => string | null;
  readonly onStopAllBackgroundItems: () => string | null;
  readonly onStopBackgroundSession: () => string | null;
  readonly onReorder: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
  readonly onSteerNow: (item: ChatQueuedPromptItem) => void;
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
  /** `/btw` / `/side`: fork this chat and ask there (`startSideChat`). */
  readonly onSideChat: (input: ChatComposerSideChatInput) => boolean;
  readonly onSettingsChange: ((settings: ChatRunSettings) => void) | null;
  /** The Location / Mode+branch / Environment chip cluster (+ context usage). */
  readonly workspaceControls: ReactNode;
  readonly workspaceAvailability: WorkspaceComposerAvailability;
}

interface ComposerSurfaceModel {
  /**
   * The view tab this composer is rendered in. Reaches the composer only for
   * the provider re-auth banner's terminal sign-in: the host creates the PTY
   * and the banner has to open THAT session as a tile in ITS OWN view. In a
   * split view each pane renders its own banner, so a banner that used the
   * app-wide active view would open the terminal in the other pane.
   */
  readonly viewTabId: string;
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
  const turnSteerCapable = props.turn.steerCapable;
  const turnSteerProtocolSupported = props.turn.steerProtocolSupported;
  const turnGetActiveTurnForSteer = props.turn.getActiveTurnForSteer;

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
      steerCapable: turnSteerCapable,
      steerProtocolSupported: turnSteerProtocolSupported,
      getActiveTurnForSteer: turnGetActiveTurnForSteer,
      stopDisabled: turnStopDisabled,
      onStopTurn: requestStopTurn,
    }),
    [
      turnActiveTurnStatus,
      turnSteerCapable,
      turnSteerProtocolSupported,
      turnGetActiveTurnForSteer,
      turnStopDisabled,
      requestStopTurn,
    ],
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
  // Read here rather than inside the dock: the same counts decide the dock's
  // Background section and the spacing of everything below it. Scoped to the
  // tile's bound host - that is the host the tile opened the session under,
  // and a same-id chat on another machine is a different agent.
  const runningManagedCommandCount = useRunningManagedCommandsForChat({
    epicId: props.epicId,
    chatId: props.chatId,
    hostId: props.hostId,
  }).length;
  // A second read rather than a bigger first one: the sets overlap, so this is
  // not a partition, and only the union decides whether the section exists. A
  // hold that only a human can clear belongs to a shell that has FINISHED, so a
  // chat holding output while running nothing - the case Deliver exists for -
  // has a running count of zero and must open the section on this alone.
  const heldManagedCommandCount = useHeldManagedCommandsForChat({
    epicId: props.epicId,
    chatId: props.chatId,
    hostId: props.hostId,
  }).length;
  const backgroundVisible = chatBackgroundSectionVisible({
    backgroundItemCount: props.backgroundItems?.length ?? 0,
    runningManagedCommandCount,
    heldManagedCommandCount,
  });
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
      viewTabId: props.viewTabId,
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
      props.viewTabId,
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
        chatId={props.chatId}
        viewTabId={props.viewTabId}
        selfAgent={stopControls.self}
        activeAgents={activeAgents}
        todo={props.todo}
        restore={props.restoreContext}
        queue={props.queue.value}
        backgroundItems={props.backgroundItems}
        runningManagedCommandCount={runningManagedCommandCount}
        heldManagedCommandCount={heldManagedCommandCount}
        backgroundStopPendingTaskIds={props.backgroundStopPendingTaskIds}
        backgroundStopAllPending={props.backgroundStopAllPending}
        backgroundSessionStopPending={props.backgroundSessionStopPending}
        activeTurnStatus={props.turn.activeTurnStatus}
        canAct={props.access.canAct}
        queueResumeRequested={props.queue.resumeRequested}
        queueKeepPausedRequested={props.queue.keepPausedRequested}
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
        onBackgroundSessionStop={props.queue.onStopBackgroundSession}
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
    // The workspace row is LIVE: its selector targets the reading host and this
    // surface's chat id, and both create/re-bind and remove are real mutations.
    // For a viewer of a live chat that is the chat's own workspace and the row
    // is informative. For a COPY (`readOnlyNotice` is set only by the published
    // and doc-replica surfaces) the binding shown is `null` and the chat id is
    // the one the OWNER minted, so acting on the row would commit a workspace
    // change against whatever local lineage happens to hold that id here.
    // A copy has no live workspace to show, so it shows none.
    const isCopy = model.access.readOnlyNotice !== null;
    return (
      <ComposerSlotShell topSpacing={layout.topSpacing} bottomSpacing="normal">
        <div className="flex flex-col gap-3">
          <ReadOnlyComposerNotice notice={model.access.readOnlyNotice} />
          {isCopy ? null : (
            <ComposerReadonlyWorkspaceModeRow
              workspaceSlot={model.composer.workspaceControls}
            />
          )}
        </div>
      </ComposerSlotShell>
    );
  }
  // The escape hatch stacks ABOVE the card/composer rather than replacing
  // either: a stuck block can coexist with an answerable one, and the composer
  // must stay reachable in case the host would in fact accept a send (only
  // `detached` waits gate it host-side, which the renderer cannot observe).
  const escapeHatch =
    model.interview.unanswerable.length > 0 ? (
      <ComposerSlotShell topSpacing={layout.topSpacing} bottomSpacing="normal">
        <UnanswerableInterviewNotice
          interviews={model.interview.unanswerable}
          isBusy={model.interview.unanswerableBusy}
          onDismiss={
            model.access.canAct
              ? (blockId, reason) =>
                  model.interview.onSkip(blockId, reason, undefined)
              : null
          }
        />
      </ComposerSlotShell>
    ) : null;
  // The notice already paid the surface's top spacing, so whatever follows it
  // connects flush underneath.
  const belowSpacing: ChatLowerSurfaceTopSpacing =
    escapeHatch === null ? layout.topSpacing : "connected";
  if (model.interview.pending !== null) {
    return (
      <>
        {escapeHatch}
        <ComposerSlotShell topSpacing={belowSpacing} bottomSpacing="normal">
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
            onSkip={model.access.canAct ? model.interview.onSkip : null}
            onFork={model.access.canAct ? model.interview.onFork : null}
          />
        </ComposerSlotShell>
      </>
    );
  }
  return (
    <>
      {escapeHatch}
      <LiveChatComposer
        model={model}
        topSpacing={belowSpacing}
        hasPendingApprovals={model.hasPendingApprovals}
      />
    </>
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
      sendDisabledHint={chatSendDisabledHint(model.access)}
      mentionRoots={model.composer.mentionRoots}
      fallbackToGlobalMentionRoots={model.composer.fallbackToGlobalMentionRoots}
      currentEpicId={model.composer.currentEpicId}
      viewTabId={model.viewTabId}
      settingsSeed={
        model.queue.editingItem?.settings ?? model.composer.sessionSettingsSeed
      }
      fallbackSettingsSeed={model.composer.fallbackSettingsSeed}
      onSubmitMessage={model.composer.onSubmitMessage}
      onSideChat={model.composer.onSideChat}
      onSettingsChange={model.composer.onSettingsChange}
      activeTurnStatus={model.turn.activeTurnStatus}
      steerCapable={model.turn.steerCapable}
      steerProtocolSupported={model.turn.steerProtocolSupported}
      getActiveTurnForSteer={model.turn.getActiveTurnForSteer}
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
    <div className="pointer-events-none px-4">
      <div
        className={cn(
          "pointer-events-auto relative mx-auto w-full max-w-3xl bg-canvas",
          props.topSpacing === "normal" ? "pt-4" : "pt-0",
          props.bottomSpacing === "normal" ? "pb-4" : "pb-0",
          props.bottomSpacing === "normal" &&
            "after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-canvas after:content-['']",
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

function ReadOnlyComposerNotice(props: { readonly notice: string | null }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-canvas-border/70 bg-canvas px-3 py-2 text-ui-sm text-muted-foreground">
      {/* The same lock the sidebar row and tab strip mark read-only chats
          with, aligned to the first line of a notice that can wrap. */}
      <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {props.notice ??
          "Read-only viewer. The agent owner can send prompts and manage this queue."}
      </span>
    </div>
  );
}
