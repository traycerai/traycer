import { useReadingWidthStyle } from "@/lib/layout-overrides";
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
import type { SubagentDockView } from "@/components/chat/segments/subagent-open-as-chat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ChatProviderFallbackState } from "@/components/chat/fallback/fallback-state";
import { ChatLowerDock } from "@/components/chat/chat-lower-dock";
import { ChatDockCompactStripProvider } from "@/components/chat/chat-dock-compact-strip";
import {
  type ChatLowerSurfaceTopSpacing,
  type ChatPinnedStackTopSpacing,
} from "@/components/chat/chat-pinned-stack";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import { useAgentStopControls } from "@/hooks/agent/use-agent-stop-controls";
import { useAgentStop } from "@/hooks/agent/use-stop-agent-mutation";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { StopChildrenDialog } from "@/components/chat/chat-stop-children-dialog";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import type { ChatStopConfirmationTarget } from "@/stores/chats/chat-turn-lifecycle";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { PendingInterviewCard } from "@/components/chat/segments/pending-interview/pending-interview-card";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { UnanswerableInterviewNotice } from "@/components/chat/segments/pending-interview/unanswerable-interview-notice";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";
import type { AutoModeRuleDraftWorkspace } from "@/lib/auto-mode/auto-mode-rule-copy";
import type { TabHostSettingsOpts } from "@/stores/tabs/system-overlay-types";
import { ComposerSlotFileEditApprovalQueue } from "@/components/chat/segments/composer-slot-file-edit-approval-queue";
import { ComposerReadonlyWorkspaceModeRow } from "@/components/home/composer/composer-workspace-mode-row";
import {
  chatBackgroundSectionVisible,
  lowerScrollRegionMaxHeightClass,
  lowerSurfaceFrame,
} from "@/lib/chat/chat-lower-scroll-budget";
import type { WorkspaceComposerAvailability } from "@/lib/composer/workspace-composer-availability";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { usePortForwardsForChat } from "@/stores/port-forwards/port-forwards-for-chat";
import {
  useHeldManagedCommandsForChat,
  useManagedCommandsForChat,
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
import {
  failedManagedCommandPulseToken,
  useChatDockChrome,
} from "./use-chat-dock-chrome";

type ComposerSlotBottomSpacing = "normal" | "none";

export interface ChatLowerInteractionSurfacesProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly chatId: string;
  /**
   * The tile's bound host, made explicit for chat-session state lookups.
   * Must match the surrounding TabHostProvider used for stop requests.
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
  /**
   * The chat's provider-fallback state, straight off the frame.
   *
   * It reaches two places from here and only two: the retry row that sits above
   * the dock, and the composer's banner slot (the grace card and the
   * switch-back offer). Threaded as one group rather than two props because
   * both fields travel the same hops and appear and vanish together.
   */
  readonly providerFallback: ChatProviderFallbackState;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  readonly backgroundStopPendingTaskIds: ReadonlySet<string>;
  readonly backgroundStopAllPending: boolean;
  readonly backgroundSessionStopPending: boolean;
  readonly onBackgroundItemClick: (item: BackgroundItem) => void;
  /**
   * Set while a subagent card's conversation covers the transcript, `null`
   * while the transcript itself is showing.
   *
   * Everything this surface draws belongs to the PARENT chat: its model, its
   * context, its workspace, its queue, its running work, and a composer that
   * messages it. Under a subagent's conversation all of that reads as the
   * subagent's, and none of it is - a message typed there went to the parent
   * and queued behind its running turn. So one notice stands in for both,
   * saying whose conversation this is and how to get back: the dock is hidden
   * and the composer is not mounted.
   * Approvals and interview questions stay: one of them may be what the
   * subagent on screen is blocked on.
   */
  readonly subagentView: SubagentDockView | null;
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
  /**
   * Whether that same negotiated line can carry `permissionMode: "auto"`
   * (`@1.12`), or `null` while the session cannot say. A sibling of
   * `steerProtocolSupported` in every respect - same line, same per-session
   * scope - and it gates whether the toolbar may OFFER Auto at all.
   */
  readonly autoPermissionModeProtocolSupported: boolean | null;
  /** Own live stream's draft-blob bridge capability. */
  readonly getDraftBlobBridgeSupported: () => boolean;
  /** Reads the live active turn at submit time for the Cmd+Enter drift check. */
  readonly getActiveTurnForSteer: () => ChatActiveTurn | null;
  /** Reads the live turn lifecycle, including ID-less activation boundaries. */
  readonly getStopConfirmationTarget: () => ChatStopConfirmationTarget;
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
  /** External jump targeting the pending composer card, or null when none. */
  readonly highlightedBlockId: string | null;
  /** Advances on each jump so a repeat to the same card restarts the pulse. */
  readonly highlightedGeneration?: number;
}

export interface ChatLowerApprovalsState {
  readonly pendingFileEditApprovals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly pendingApprovals: ReadonlyArray<ChatApprovalState>;
  readonly onFileEditDecision: (approvalId: string, approved: boolean) => void;
  readonly onApprovalDecision: (approvalId: string, approved: boolean) => void;
  /** External jump targeting a pending composer approval row, or null. */
  readonly highlightedApprovalId: string | null;
  /** Advances on each jump so a repeat to the same row restarts the pulse. */
  readonly highlightedGeneration?: number;
  /** Where this chat runs, for the rules an approval card drafts. */
  readonly ruleDraftWorkspace: AutoModeRuleDraftWorkspace;
  /** Opens Settings from an approval card's links. */
  readonly onOpenSettings: (opts: TabHostSettingsOpts) => void;
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
  /**
   * The host's `suggestedPrompt` (`chat.subscribe@1.20`), offered as the
   * composer's placeholder.
   */
  readonly suggestedPrompt: string | undefined;
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
  readonly providerFallback: ChatProviderFallbackState;
  readonly pendingApprovalCount: number;
  readonly hasPendingApprovals: boolean;
  /** See `ChatLowerInteractionSurfacesProps.subagentView`. */
  readonly subagentView: SubagentDockView | null;
}

interface ComposerSurfaceLayout {
  readonly topSpacing: ChatLowerSurfaceTopSpacing;
  readonly slotBottomSpacing: ComposerSlotBottomSpacing;
}

/**
 * The chat composer's bottom strip: where this chat runs, then how much
 * context is left.
 *
 * The compact chips used to close the left cell, hard against the
 * context-usage cluster. They live above the composer now (A12, L-97), which
 * is where the artifact draws them and where they are adjacent to the rows
 * they open - so this row is back to the two leaves it names.
 */
export function ChatDockWorkspaceControls(props: {
  /** The host + workspace picker cluster, first and left-aligned. */
  readonly hostWorkspaceSelector: ReactNode;
  /** The context-usage leaf, which owns the row's trailing cell. */
  readonly usageChip: ReactNode;
}): ReactNode {
  return (
    <>
      {/* No passive marker on this cell: the host / workspace label marks its
          own root instead - see `host-workspace-selector.tsx`. */}
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        {props.hostWorkspaceSelector}
      </div>
      {props.usageChip}
    </>
  );
}

export function ChatLowerInteractionSurfaces(
  props: ChatLowerInteractionSurfacesProps,
) {
  const stopControls = useAgentStopControls({
    epicId: props.epicId,
    rootAgentId: props.chatId,
  });
  const activeAgents = stopControls.descendants;
  const tabHostClient = useTabHostClient();
  const agentStop = useAgentStop(tabHostClient);
  const [stopConfirmation, setStopConfirmation] = useState<{
    readonly kind: "turn" | "children";
    readonly target: ChatStopConfirmationTarget;
    readonly readTarget: () => ChatStopConfirmationTarget;
  } | null>(null);
  // The SAME signal that puts Stop beside Send (`composer-send-button`), so
  // the confirmation exists exactly where the mis-tap does and desktop is
  // untouched by construction rather than by a second rule agreeing with the
  // first.
  const phoneLayout = useIsMobileViewport();

  // Destructure the turn prop for stable use in callbacks
  const turnOnStopTurn = props.turn.onStopTurn;
  const turnActiveTurnStatus = props.turn.activeTurnStatus;
  const turnStopDisabled = props.turn.stopDisabled;
  const turnSteerCapable = props.turn.steerCapable;
  const turnSteerProtocolSupported = props.turn.steerProtocolSupported;
  const turnAutoPermissionModeProtocolSupported =
    props.turn.autoPermissionModeProtocolSupported;
  const turnGetDraftBlobBridgeSupported =
    props.turn.getDraftBlobBridgeSupported;
  const turnGetActiveTurnForSteer = props.turn.getActiveTurnForSteer;
  const turnGetStopConfirmationTarget = props.turn.getStopConfirmationTarget;

  // Read the store at confirmation time: a queued turn can start before React
  // renders again. Neither dialog may redirect the original Stop to that turn.
  const isConfirmedTurnCurrent = (): boolean => {
    if (
      stopConfirmation === null ||
      stopConfirmation.readTarget !== turnGetStopConfirmationTarget
    ) {
      return false;
    }
    const current = turnGetStopConfirmationTarget();
    return (
      current.turnId === stopConfirmation.target.turnId &&
      current.revision === stopConfirmation.target.revision &&
      current.connectionEpoch === stopConfirmation.target.connectionEpoch
    );
  };

  // Intercept the composer Stop button: when this chat has active
  // sub-agents, raise the cascade prompt instead of stopping only its turn.
  // The button ignores the return value, so `null` here is just "handled".
  const requestStopTurn = useCallback((): string | null => {
    if (activeAgents.length > 0 || phoneLayout) {
      // The lifecycle revision distinguishes separate activations even when
      // both have a null turn ID. Keep it through the child-agent handoff too.
      setStopConfirmation({
        kind: activeAgents.length > 0 ? "children" : "turn",
        target: turnGetStopConfirmationTarget(),
        readTarget: turnGetStopConfirmationTarget,
      });
      return null;
    }
    return turnOnStopTurn();
  }, [
    activeAgents.length,
    phoneLayout,
    turnGetStopConfirmationTarget,
    turnOnStopTurn,
  ]);

  const turnWithCascade = useMemo(
    () => ({
      activeTurnStatus: turnActiveTurnStatus,
      steerCapable: turnSteerCapable,
      steerProtocolSupported: turnSteerProtocolSupported,
      autoPermissionModeProtocolSupported:
        turnAutoPermissionModeProtocolSupported,
      getDraftBlobBridgeSupported: turnGetDraftBlobBridgeSupported,
      getActiveTurnForSteer: turnGetActiveTurnForSteer,
      getStopConfirmationTarget: turnGetStopConfirmationTarget,
      stopDisabled: turnStopDisabled,
      onStopTurn: requestStopTurn,
    }),
    [
      turnActiveTurnStatus,
      turnSteerCapable,
      turnSteerProtocolSupported,
      turnAutoPermissionModeProtocolSupported,
      turnGetDraftBlobBridgeSupported,
      turnGetActiveTurnForSteer,
      turnGetStopConfirmationTarget,
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
  // A third read of the same slice, for the one thing the running list cannot
  // say: a shell that is no longer running because it FAILED. The Background
  // pill's ring is the section's only channel while its row is folded away,
  // and a failure is the one arrival on that strip that is not simply news, so
  // it radiates the destructive tone instead of the primary one.
  const managedCommands = useManagedCommandsForChat(
    props.epicId,
    props.chatId,
    props.hostId,
  );
  const backgroundFailureToken = useMemo(
    () => failedManagedCommandPulseToken(managedCommands),
    [managedCommands],
  );
  // A forward outlives the turn that made it, so an otherwise idle chat can
  // still hold one; it opens the section on its own, like a hold does.
  const portForwards = usePortForwardsForChat({
    epicId: props.epicId,
    chatId: props.chatId,
    hostId: props.hostId,
  });
  const portForwardCount = portForwards.length;
  const backgroundVisible = chatBackgroundSectionVisible({
    backgroundItemCount: props.backgroundItems?.length ?? 0,
    runningManagedCommandCount,
    heldManagedCommandCount,
    portForwardCount,
  });
  const activeAgentsVisible =
    stopControls.self !== null && activeAgents.length > 0;
  const dockShown = props.subagentView === null;
  const chrome = useChatDockChrome({
    snapshotLoaded: props.runtime.snapshotLoaded,
    chatId: props.chatId,
    restore: props.restoreContext,
    selfAgent: stopControls.self,
    activeAgents,
    activeAgentsVisible,
    backgroundVisible,
    backgroundItems: props.backgroundItems,
    runningManagedCommands,
    heldManagedCommands,
    backgroundFailureToken,
    portForwardCount,
    queue: props.queue.value,
    todo: props.todo,
  });
  // What each dock member DRAWS below the transcript, and what that means for
  // the composer's top edge: `lowerSurfaceFrame`
  // (`lib/chat/chat-lower-scroll-budget.ts`) is the one place that decides it,
  // and the browser fixture calls the same function.
  const {
    pinnedStackVisible,
    queueVisible,
    dockAgentsVisible,
    dockBackgroundVisible,
    topSpacing: lowerSurfaceTopSpacing,
  } = lowerSurfaceFrame({
    folded: chrome.folded,
    // The dock is not drawn under a subagent's conversation (see
    // `subagentView`), so none of its members shapes the spacing below it.
    openSection: dockShown ? chrome.openSection : null,
    todoHasContent:
      dockShown && props.runtime.snapshotLoaded && props.todo !== null,
    filesChangedHasContent:
      dockShown && chrome.hotspots.filesChanged.hasContent,
    activeAgentsHasContent: dockShown && activeAgentsVisible,
    backgroundHasContent: dockShown && backgroundVisible,
    queueItemCount: dockShown ? props.queue.value.items.length : 0,
  });
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
      providerFallback: props.providerFallback,
      pendingApprovalCount,
      hasPendingApprovals,
      subagentView: props.subagentView,
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
      props.providerFallback,
      pendingApprovalCount,
      hasPendingApprovals,
      props.subagentView,
    ],
  );

  return (
    <ChatComposerBannerPortalProvider>
      <ChatDockCompactStripProvider value={chrome.strip}>
        <RuntimeGatedApprovalSurface
          model={composerModel}
          layout={approvalLayout}
        />
        {/* Hidden, never unmounted, under a subagent's conversation (see
            `subagentView`): the dock holds state a remount would lose - which
            panel is open, where it is scrolled, the Background rows' own
            memory of their parents. */}
        <div
          className={cn(dockShown ? "contents" : "hidden")}
          inert={!dockShown}
        >
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
            folded={chrome.folded}
            dockOrder={chrome.dockOrder}
            hotspots={chrome.hotspots}
            backgroundItems={props.backgroundItems}
            runningManagedCommandCount={runningManagedCommandCount}
            heldManagedCommandCount={heldManagedCommandCount}
            portForwardCount={portForwardCount}
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
        </div>
        <ChatComposerRegion model={composerModel} layout={composerLayout} />
        <StopChildrenDialog
          open={stopConfirmation?.kind === "children"}
          onOpenChange={(open) => {
            if (!open) setStopConfirmation(null);
          }}
          agents={activeAgents}
          onStopAll={() => {
            setStopConfirmation(null);
            if (!isConfirmedTurnCurrent()) return;
            agentStop.mutate({
              epicId: props.epicId,
              agentId: props.chatId,
              cascade: true,
            });
          }}
          onStopOnlyThis={() => {
            setStopConfirmation(null);
            if (!isConfirmedTurnCurrent()) return;
            turnOnStopTurn();
          }}
        />
        <StopTurnConfirmDialog
          open={stopConfirmation?.kind === "turn"}
          onOpenChange={(open) => {
            if (!open) setStopConfirmation(null);
          }}
          onConfirm={() => {
            setStopConfirmation(null);
            if (stopConfirmation === null || !isConfirmedTurnCurrent()) return;
            // A sub-agent can start while this dialog is open. Go back through
            // the same gate, retaining the turn this confirmation belongs to.
            if (activeAgents.length > 0) {
              setStopConfirmation({ ...stopConfirmation, kind: "children" });
              return;
            }
            turnOnStopTurn();
          }}
        />
      </ChatDockCompactStripProvider>
    </ChatComposerBannerPortalProvider>
  );
}

/** Mounted on its first open only: a tile that never asks does not pay for the dialog. */
function StopTurnConfirmDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  const [everOpened, setEverOpened] = useState(props.open);
  if (props.open && !everOpened) setEverOpened(true);
  if (!props.open && !everOpened) return null;
  return (
    <ConfirmDestructiveDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Stop this turn?"
      description="The agent will stop working on its current response."
      cascadeSummary={null}
      actionLabel="Stop"
      blockedReason={null}
      isPending={false}
      onConfirm={props.onConfirm}
    />
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
        highlightedApprovalId={model.approvals.highlightedApprovalId}
        highlightedGeneration={model.approvals.highlightedGeneration}
        ruleDraftWorkspace={model.approvals.ruleDraftWorkspace}
        onOpenSettings={model.approvals.onOpenSettings}
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
  const tabHostId = useTabHostId();
  if (!model.runtime.snapshotLoaded) {
    return null;
  }
  if (model.access.isViewer) {
    return <ViewerComposerSurface model={model} layout={layout} />;
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
            epicId={model.composer.currentEpicId}
            hostId={tabHostId}
            navigationHighlighted={
              model.interview.highlightedBlockId ===
              model.interview.pending.blockId
            }
            highlightGeneration={model.interview.highlightedGeneration}
          />
        </ComposerSlotShell>
      </>
    );
  }
  // Unmounted under a subagent's conversation, not hidden: a composer that is
  // merely out of sight is still this tile's active one, so the dictation and
  // model-picker chords, the palette's composer commands and its portalled
  // banners all go on acting on the parent chat from behind the notice.
  // Unmounting is the path a pending interview already takes above.
  if (model.subagentView !== null) {
    return (
      <>
        {escapeHatch}
        <ComposerSlotShell topSpacing={belowSpacing} bottomSpacing="normal">
          <SubagentViewNotice view={model.subagentView} />
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

/** What stands in the composer's slot for someone who cannot send. */
function ViewerComposerSurface(props: {
  readonly model: ComposerSurfaceModel;
  readonly layout: ComposerSurfaceLayout;
}): ReactNode {
  const { model, layout } = props;
  if (model.subagentView !== null) {
    return (
      <ComposerSlotShell topSpacing={layout.topSpacing} bottomSpacing="normal">
        <SubagentViewNotice view={model.subagentView} />
      </ComposerSlotShell>
    );
  }
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
      autoPermissionModeProtocolSupported={
        model.turn.autoPermissionModeProtocolSupported
      }
      getDraftBlobBridgeSupported={model.turn.getDraftBlobBridgeSupported}
      getActiveTurnForSteer={model.turn.getActiveTurnForSteer}
      editingQueueItemId={model.queue.editingItem?.queueItemId ?? null}
      onCancelQueueEdit={model.queue.onCancelEdit}
      hasPendingApprovals={props.hasPendingApprovals}
      stopDisabled={model.turn.stopDisabled}
      onStopTurn={model.turn.onStopTurn}
      workspaceControls={model.composer.workspaceControls}
      workspaceAvailability={model.composer.workspaceAvailability}
      providerFallback={model.providerFallback}
      topSpacing={props.topSpacing}
      topSlot={null}
      suggestedPrompt={model.composer.suggestedPrompt}
    />
  );
}

function PendingApprovalQueues(props: {
  readonly pendingFileEditApprovals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly pendingApprovals: ReadonlyArray<ChatApprovalState>;
  readonly canAct: boolean;
  readonly onFileEditDecision: (approvalId: string, approved: boolean) => void;
  readonly onApprovalDecision: (approvalId: string, approved: boolean) => void;
  readonly highlightedApprovalId: string | null;
  readonly highlightedGeneration?: number;
  readonly ruleDraftWorkspace: AutoModeRuleDraftWorkspace;
  readonly onOpenSettings: (opts: TabHostSettingsOpts) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ComposerSlotFileEditApprovalQueue
        approvals={props.pendingFileEditApprovals}
        canAct={props.canAct}
        onDecision={props.onFileEditDecision}
        highlightedApprovalId={props.highlightedApprovalId}
        highlightedGeneration={props.highlightedGeneration}
      />
      <ComposerSlotApprovalQueue
        approvals={props.pendingApprovals}
        canAct={props.canAct}
        onDecision={props.onApprovalDecision}
        highlightedApprovalId={props.highlightedApprovalId}
        highlightedGeneration={props.highlightedGeneration}
        ruleDraftWorkspace={props.ruleDraftWorkspace}
        onOpenSettings={props.onOpenSettings}
      />
    </div>
  );
}

/**
 * The box every centered lower surface is painted in: the edge-lane outer, the
 * reading column, the canvas fill, the top and bottom spacing, and the
 * pseudo-element that seals the seam over the transcript's scrollbar.
 *
 * Exported for ONE other caller, the layout editor's sample workspace (L-87,
 * L-98). The sample used to hand-roll this stack and drifted: it paid no top
 * padding at all, so the pill row sat flush on the composer's border in the
 * editor while the real chat held it a clear step above (L-153). The scene is
 * a picture of the real thing, so it uses the real thing.
 */
export function ComposerSlotShell(props: {
  readonly children: ReactNode;
  readonly topSpacing: ChatLowerSurfaceTopSpacing;
  readonly bottomSpacing: ComposerSlotBottomSpacing;
}) {
  const readingWidth = useReadingWidthStyle();
  return (
    <div className="pointer-events-none px-4">
      <div
        className={cn(
          "pointer-events-auto relative mx-auto w-full bg-canvas",
          readingWidth.className,
          props.topSpacing === "normal" ? "pt-4" : "pt-0",
          props.bottomSpacing === "normal" ? "pb-4" : "pb-0",
          props.bottomSpacing === "normal" &&
            "after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-canvas after:content-['']",
        )}
        style={{ maxWidth: readingWidth.maxWidth }}
      >
        {props.children}
      </div>
    </div>
  );
}

/**
 * Stands where the composer does while a subagent's conversation is open. The
 * same frame as the viewer's read-only notice, because it is the same fact
 * about this surface - nothing can be typed here - for a different reason.
 */
function SubagentViewNotice(props: { readonly view: SubagentDockView }) {
  const { view } = props;
  return (
    <div
      data-testid="subagent-view-notice"
      className="flex items-center gap-2 rounded-md border border-canvas-border/70 bg-canvas px-3 py-2 text-ui-sm text-muted-foreground"
    >
      <Lock className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {view.name === null
          ? "You're viewing a subagent's conversation."
          : `You're viewing ${view.name}'s conversation.`}{" "}
        Subagents can't take messages.
      </span>
      {view.runningCount > 0 ? (
        <Badge variant="secondary" className="shrink-0">
          {view.runningCount} running
        </Badge>
      ) : null}
      <Button type="button" variant="outline" size="xs" onClick={view.close}>
        Back to chat
      </Button>
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
