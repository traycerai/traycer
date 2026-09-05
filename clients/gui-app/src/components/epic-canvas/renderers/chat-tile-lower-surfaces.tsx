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
import type {
  HeldManagedCommandUpdate,
  ManagedCommand,
} from "@traycer/protocol/host/managed-command/unary-schemas";
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
  ChatDockCompactStripProvider,
  type ChatDockCompactChipModel,
  type ChatDockCompactStripValue,
  type ChatDockSection,
} from "@/components/chat/chat-dock-compact-strip";
import { isReceivedAgentResponse } from "@/components/chat/chat-queue-utils";
import {
  type ChatLowerSurfaceTopSpacing,
  type ChatPinnedStackTopSpacing,
} from "@/components/chat/chat-pinned-stack";
import {
  chatChangesPanelHasContent,
  chatPinnedStackVisible,
} from "@/components/chat/chat-pinned-stack-utils";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import {
  useAgentStopControls,
  type AgentRow,
} from "@/hooks/agent/use-agent-stop-controls";
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
import { accumulatedDiffTotals } from "@/lib/chat/accumulated-change-rows";
import {
  backgroundHeaderSummary,
  backgroundRunningRowCount,
} from "@/lib/chat/background-item-tree";
import type { WorkspaceComposerAvailability } from "@/lib/composer/workspace-composer-availability";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import {
  useHeldManagedCommandsForChat,
  useRunningManagedCommandsForChat,
} from "@/stores/managed-commands/managed-commands-for-chat";
import { useLayoutStore } from "@/stores/settings/layout-store";
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
  // Read here rather than inside the dock: the same counts decide the dock's
  // Background section and the spacing of everything below it. Scoped to the
  // tile's bound host - that is the host the tile opened the session under,
  // and a same-id chat on another machine is a different agent.
  const runningManagedCommands = useRunningManagedCommandsForChat({
    epicId: props.epicId,
    chatId: props.chatId,
    hostId: props.hostId,
  });
  const runningManagedCommandCount = runningManagedCommands.length;
  // A second read rather than a bigger first one: the sets overlap, so this is
  // not a partition, and only the union decides whether the section exists. A
  // hold that only a human can clear belongs to a shell that has FINISHED, so a
  // chat holding output while running nothing - the case Deliver exists for -
  // has a running count of zero and must open the section on this alone.
  const heldManagedCommands = useHeldManagedCommandsForChat({
    epicId: props.epicId,
    chatId: props.chatId,
    hostId: props.hostId,
  });
  const heldManagedCommandCount = heldManagedCommands.length;
  const backgroundVisible = chatBackgroundSectionVisible({
    backgroundItemCount: props.backgroundItems?.length ?? 0,
    runningManagedCommandCount,
    heldManagedCommandCount,
  });
  const activeAgentsVisible =
    stopControls.self !== null && activeAgents.length > 0;
  const chrome = useChatDockChrome({
    snapshotLoaded: props.runtime.snapshotLoaded,
    restore: props.restoreContext,
    selfAgent: stopControls.self,
    activeAgentCount: activeAgents.length,
    activeAgentsVisible,
    backgroundVisible,
    backgroundItems: props.backgroundItems,
    runningManagedCommands,
    heldManagedCommands,
    queue: props.queue.value,
  });
  const pinnedStackVisible =
    props.runtime.snapshotLoaded &&
    chatPinnedStackVisible({
      todo: props.todo,
      restore: props.restoreContext,
      changesFolded: chrome.folded.has("filesChanged"),
    });
  // Show the queue surface whenever it holds anything - user-typed sends and
  // received A2A responses alike (the latter render read-only). Received rows
  // follow the Active agents mode, so a folded chip takes them with it and this
  // reads the queue the dock will actually be handed.
  const queueVisible = chrome.dockQueue.items.length > 0;
  const dockAgentsVisible =
    activeAgentsVisible && !chrome.folded.has("activeAgents");
  const dockBackgroundVisible =
    backgroundVisible && !chrome.folded.has("background");
  const approvalVisible = approvalSurfaceVisible(
    props.runtime.snapshotLoaded,
    props.access.isViewer,
    pendingApprovalCount,
  );
  const scrollRegionMaxHeightClass = lowerScrollRegionMaxHeightClass({
    pinnedStackVisible,
    queueVisible,
    backgroundVisible: dockBackgroundVisible,
    activeAgentsVisible: dockAgentsVisible,
    approvalVisible,
  });
  const lowerSurfaceTopSpacing: ChatLowerSurfaceTopSpacing =
    pinnedStackVisible ||
    queueVisible ||
    dockAgentsVisible ||
    dockBackgroundVisible
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
      <ChatDockCompactStripProvider value={chrome.strip}>
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
          queue={chrome.dockQueue}
          folded={chrome.folded}
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
      </ChatDockCompactStripProvider>
    </ChatComposerBannerPortalProvider>
  );
}

interface ChatDockChrome {
  /** Sections standing as a chip right now, for the dock and for the spacing. */
  readonly folded: ReadonlySet<ChatDockSection>;
  /** The queue as the dock should render it - see `foldedQueue`. */
  readonly dockQueue: ChatSessionState["queue"];
  readonly strip: ChatDockCompactStripValue;
}

interface ChatDockChromeInput {
  readonly snapshotLoaded: boolean;
  readonly restore: ChatRestoreContextValue;
  readonly selfAgent: AgentRow | null;
  readonly activeAgentCount: number;
  readonly activeAgentsVisible: boolean;
  readonly backgroundVisible: boolean;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  readonly runningManagedCommands: ReadonlyArray<ManagedCommand>;
  readonly heldManagedCommands: ReadonlyArray<HeldManagedCommandUpdate>;
  readonly queue: ChatSessionState["queue"];
}

const NO_BACKGROUND_ITEMS: ReadonlyArray<BackgroundItem> = [];

/**
 * Which dock rows are folded into a chip, what those chips say, and how the
 * user gets a row back.
 *
 * Expansion is component state, so it dies with the tile and is never written
 * to the setting: `compact` is a statement about how a chat OPENS, and having
 * one glance at a row silently redefine that for every chat is the failure a
 * per-tile reveal exists to avoid.
 */
function useChatDockChrome(input: ChatDockChromeInput): ChatDockChrome {
  const composer = useLayoutStore((state) => state.composer);
  const [expanded, setExpanded] = useState<ReadonlySet<ChatDockSection>>(
    () => new Set<ChatDockSection>(),
  );
  const onToggle = useCallback((section: ChatDockSection) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(section)) next.add(section);
      return next;
    });
  }, []);

  const changesPresent =
    input.snapshotLoaded && chatChangesPanelHasContent(input.restore);
  const receivedAgentCount = input.queue.items.filter(
    isReceivedAgentResponse,
  ).length;
  // The root agent counts as running too when it is itself active, exactly as
  // `ActiveAgentsPanel`'s own header counts it.
  const agentsRunningCount =
    input.selfAgent === null
      ? 0
      : input.activeAgentCount + (input.selfAgent.activity === false ? 0 : 1);
  const backgroundItems = input.backgroundItems ?? NO_BACKGROUND_ITEMS;
  const backgroundRunning = useMemo(
    () =>
      backgroundRunningRowCount({
        items: backgroundItems,
        runningManagedCommandIds: input.runningManagedCommands.map(
          (command) => command.id,
        ),
        heldManagedCommandIds: input.heldManagedCommands.map(
          (held) => held.commandId,
        ),
      }),
    [backgroundItems, input.runningManagedCommands, input.heldManagedCommands],
  );
  const backgroundSummary = useMemo(
    () =>
      backgroundHeaderSummary({
        runningCount: backgroundRunning,
        heldCount: input.heldManagedCommands.length,
        waitingWakeCount: backgroundItems.filter(
          (item) => item.kind === "wakeup",
        ).length,
      }),
    [backgroundRunning, input.heldManagedCommands, backgroundItems],
  );
  const changeTotals = useMemo(
    () => accumulatedDiffTotals(input.restore.accumulatedFileChanges),
    [input.restore.accumulatedFileChanges],
  );
  const changedFileCount =
    input.restore.accumulatedFileChanges.length +
    input.restore.undeliveredChangeCount;

  // A chip exists for every compact section that HAS something to show, whether
  // or not its row is currently revealed - the chip is the way back, so it
  // cannot be the thing that disappears when the row appears.
  const filesChip = composer.filesChanged === "compact" && changesPresent;
  // Received A2A rows follow this mode, so the chip is also owed when they are
  // the only thing folded: without it, folding would make them unreachable.
  const agentsChip =
    composer.activeAgents === "compact" &&
    (input.activeAgentsVisible || receivedAgentCount > 0);
  const backgroundChip =
    composer.background === "compact" && input.backgroundVisible;

  // A reveal belongs to a chip, so it dies with one. Per-tile stickiness is the
  // point - a revealed row stays revealed for as long as the tile lives - but
  // stickiness across a section going EMPTY is a different thing: the user
  // reverts every change, the chip goes away, and the next turn's changes would
  // otherwise arrive as a full row in a chat configured to fold them.
  // Adjusted during render, and the pruned set is what this render uses, so the
  // correction never costs a painted frame.
  const chipPresent: Readonly<Record<ChatDockSection, boolean>> = {
    filesChanged: filesChip,
    activeAgents: agentsChip,
    background: backgroundChip,
  };
  const revealed = prunedReveals(expanded, chipPresent);
  if (revealed !== expanded) setExpanded(revealed);

  const folded = useMemo(() => {
    const sections = new Set<ChatDockSection>();
    if (filesChip && !revealed.has("filesChanged")) {
      sections.add("filesChanged");
    }
    if (agentsChip && !revealed.has("activeAgents")) {
      sections.add("activeAgents");
    }
    if (backgroundChip && !revealed.has("background")) {
      sections.add("background");
    }
    return sections;
  }, [filesChip, agentsChip, backgroundChip, revealed]);

  const dockQueue = useMemo(
    () => foldedQueue(input.queue, folded.has("activeAgents")),
    [input.queue, folded],
  );

  const chips = useMemo<ReadonlyArray<ChatDockCompactChipModel>>(() => {
    const models: ChatDockCompactChipModel[] = [];
    if (filesChip) {
      models.push({
        section: "filesChanged",
        text: changeCountsShortForm(changeTotals, changedFileCount),
        label: `Files changed. ${fileCountPhrase(changedFileCount)}, ${changeTotals.additions} added and ${changeTotals.deletions} removed.`,
        // Constant, so this fires on the chip's arrival and never again -
        // which is the first change of the chat, since the chip exists only
        // once there is one. Keying it on the line counts instead reads well
        // in the abstract and is unbearable in practice: they are summed per
        // edit while a turn is still writing, so a turn touching twelve files
        // rang the chip beside the input twelve times.
        pulseToken: "changed",
      });
    }
    if (agentsChip) {
      models.push({
        section: "activeAgents",
        text:
          receivedAgentCount > 0
            ? `${agentsRunningCount} · ${receivedAgentCount}`
            : `${agentsRunningCount}`,
        label: `Active agents. ${agentsRunningCount} running${receivedAgentCount > 0 ? `, ${receivedAgentCount} received from other agents and queued` : ""}.`,
        // Only the first agent starting is worth an eye-flick - which is the
        // moment this chip appears; a count moving between two non-zero values
        // is the same fact, updated.
        pulseToken: agentsRunningCount > 0 ? "running" : null,
      });
    }
    if (backgroundChip) {
      models.push({
        section: "background",
        text: `${backgroundRunning}`,
        // The number on the chip is the running count, but the section can be
        // on screen for a held shell or a pending wake with nothing running at
        // all - so the sentence is the header's own summary, which names every
        // part rather than letting a bare `0` stand for "nothing here".
        label: `Background. ${backgroundSummary}.`,
        pulseToken: backgroundRunning > 0 ? "running" : null,
      });
    }
    return models;
  }, [
    filesChip,
    agentsChip,
    backgroundChip,
    backgroundSummary,
    changeTotals,
    changedFileCount,
    agentsRunningCount,
    receivedAgentCount,
    backgroundRunning,
  ]);

  const strip = useMemo<ChatDockCompactStripValue>(
    () => ({ chips, expanded: revealed, onToggle }),
    [chips, revealed, onToggle],
  );

  return { folded, dockQueue, strip };
}

/**
 * `expanded` minus any section whose chip is no longer there, or `expanded`
 * itself when there is nothing to drop - identity is the loop guard, since this
 * runs during render and feeds its own state.
 */
function prunedReveals(
  expanded: ReadonlySet<ChatDockSection>,
  chipPresent: Readonly<Record<ChatDockSection, boolean>>,
): ReadonlySet<ChatDockSection> {
  const stale = [...expanded].filter((section) => !chipPresent[section]);
  if (stale.length === 0) return expanded;
  const next = new Set(expanded);
  for (const section of stale) next.delete(section);
  return next;
}

/**
 * The queue minus its received-A2A rows when the Active agents chip is standing
 * for them, and the identical object otherwise - the dock's queue section and
 * the surrounding spacing both key off this array's length, so handing back a
 * fresh copy of an unchanged queue would churn both.
 */
function foldedQueue(
  queue: ChatSessionState["queue"],
  agentsFolded: boolean,
): ChatSessionState["queue"] {
  if (!agentsFolded) return queue;
  const items = queue.items.filter((item) => !isReceivedAgentResponse(item));
  if (items.length === queue.items.length) return queue;
  return { status: queue.status, items };
}

function fileCountPhrase(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

/**
 * Line counts only, as the panel's own header prints them - and the file count
 * instead when there are none to print, which is the state a summary stream
 * still in flight (or a set of changes with no diff to count) leaves behind.
 */
function changeCountsShortForm(
  totals: { readonly additions: number; readonly deletions: number },
  fileCount: number,
): string {
  const parts: string[] = [];
  if (totals.additions > 0) parts.push(`+${totals.additions}`);
  if (totals.deletions > 0) parts.push(`−${totals.deletions}`);
  return parts.length > 0 ? parts.join(" ") : `${fileCount}`;
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
