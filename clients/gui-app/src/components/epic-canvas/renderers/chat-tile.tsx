import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useChatMessageActions } from "./use-chat-message-actions";
import { useChatQueueActions } from "./use-chat-queue-actions";
import type { ChatForkMode } from "@/components/chat/chat-message";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { useTabProvidersList } from "@/hooks/providers/use-tab-providers-list-query";
import { TombstonedProfileProvider } from "@/components/chat/tombstoned-profile-provider";
import type {
  InterviewAnswer,
  Message,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
import type {
  BackgroundItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import {
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import { ChatMarkdownLinkProvider } from "@/components/chat/chat-markdown-link-provider";
import {
  ChatForkDialog,
  type ChatForkDialogTarget,
} from "@/components/chat/chat-fork-dialog";
import {
  ChatDiffTargetContext,
  type ChatSnapshotDiffOpener,
} from "@/components/chat/chat-diff-target";
import {
  ChatScrollToBlockContext,
  type ChatScrollCardKind,
} from "@/components/chat/chat-scroll-to-block";
import {
  ChatPlanActionsContext,
  type ChatPlanActionsContextValue,
} from "@/components/chat/chat-plan-actions-context";
import {
  WorkingVerbContext,
  pickWorkingVerb,
} from "@/components/chat/working-verb";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import { ChatRestoreProvider } from "@/components/chat/chat-restore-context";
import { RevertOnEditDialog } from "@/components/chat/segments/revert-on-edit-dialog";
import { SteerSettingsConflictDialog } from "@/components/chat/segments/steer-settings-conflict-dialog";
import { accumulatedFileChangesFromMessages } from "@/lib/chat/accumulated-file-changes-from-messages";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { buildPinnedTodoRenderState } from "@/components/chat/chat-pinned-todos";
import {
  buildChatUserMessageMinimapItems,
  type ChatUserMinimapItem,
} from "@/components/chat/chat-user-message-minimap-items";
import type { ChatMessageActions } from "@/components/chat/chat-message";
import type { NextStepActionHandler } from "@/components/chat/segments/next-steps-action-group";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import {
  useChatById,
  useEpicLiveArtifactTitle,
  useOpenEpicId,
} from "@/lib/epic-selectors";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import {
  mentionRootsFromWorktreeBinding,
  useWorkspaceMentionRoots,
  worktreeBindingIsFolderless,
} from "@/hooks/composer/use-workspace-mention-roots";
import { useChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { useSubagentOpenStore } from "@/stores/chats/subagent-open-store";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
} from "@/stores/chats/rendered-messages";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostClient, useHostBinding } from "@/lib/host";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import {
  useEpicCreateChat,
  useEpicUpdateChatRunSettings,
} from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { cloneChatOnHostSwitch } from "@/lib/commands/actions/clone-chat-on-host-switch";
import { enqueuePersistChatRunSettings } from "@/lib/chats/chat-run-settings-write-queue";
import { ChatDeadTileBanner } from "./dead-tile-banner";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { flattenCollaborators } from "@/hooks/epics/use-epic-collaborators-query";
import {
  useGuiHarnessCatalog,
  type GuiHarnessCatalogEntry,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useInitialChatHandoffDriver } from "@/hooks/chats/use-initial-chat-handoff-driver";
import { useChatActions } from "@/hooks/chats/use-chat-actions";
import { useChatSetupFailureRestoreDriver } from "@/hooks/chats/use-chat-setup-failure-restore-driver";
import { useSetupTerminalListRefreshDriver } from "@/hooks/chats/use-setup-terminal-list-refresh-driver";
import { useSetupTerminalTabRegisterDriver } from "@/hooks/chats/use-setup-terminal-tab-register-driver";
import { emitChatStreamErrorNotification } from "@/stores/notifications/app-local-notifications-store";
import { type InitialChatHandoffScope } from "@/stores/epics/initial-chat-handoff-store";
import { contentBlocksText } from "@/lib/chat/content-block-text";
import { buildSubmittedChatJSONContent } from "@/lib/composer/tiptap-json-content";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import {
  deriveWorktreeBindingWorkspaceAvailability,
  effectiveMissingWorktreePaths,
  type WorkspaceComposerAvailability,
} from "@/lib/composer/workspace-composer-availability";
import { useWorktreeListBindingsForEpicForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  agentModelKey,
  resolveAgentReasoningLabel,
  resolveAgentSenderDisplay,
  resolveSenderLabel,
  type SenderDisplayContext,
} from "@/lib/chat/sender-display";
import {
  useComposerRunSettingsStore,
  type ComposerRunSettingsEntry,
} from "@/stores/composer/composer-run-settings-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useAnySystemOverlayActive } from "@/stores/tabs/use-system-tab-modal";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  makeSnapshotCumulativeBundleDiffTile,
  makeSnapshotCumulativeDiffTile,
  makeSnapshotHashDiffTile,
  makeSnapshotSegmentDiffTile,
} from "@/lib/chat/snapshot-diff-tile";
import {
  useActivePaneEffect,
  usePaneVisible,
} from "@/components/epic-tabs/pane-visibility-context";
import { useTabBodySelected } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import {
  localSnapshotsClearedAt,
  useLocalSnapshotClearStore,
} from "@/stores/settings/local-snapshot-clear-store";
import { ChatTileErrorNoticeToasts } from "./chat-tile-error-notice-toasts";
import { HostWorkspaceSelector } from "@/components/home/host-workspace-selector/host-workspace-selector";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { TraycerNextStepOption } from "@/markdown/traycer-next-steps";
import {
  ChatLowerInteractionSurfaces,
  InertChatComposer,
} from "./chat-tile-lower-surfaces";
import { composerHasBlockingApprovals } from "./chat-approval-visibility";
import {
  chatTileUiReducer,
  createInitialChatTileUiState,
  normalizeInlineEditForSession,
  canModifyChatMessages,
  shouldGenerateChatTitleForSubmittedMessage,
  showRestoreResultToast,
  userMessageSenderForProfile,
  plainTextPromptContent,
  composerTurnStatus,
  resolvedTurnStatus,
  chatTileCanAct,
  findPendingInterview,
} from "./chat-tile-session-state";
import { ChatTileLoading, ChatTileError } from "./chat-tile-runtime-gate";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { ChatStatusWorktreePrPills } from "@/components/worktree/worktree-owner-metadata";

const EMPTY_MENTION_ROOTS: ReadonlyArray<string> = [];
const EMPTY_WORKSPACE_PATH_SET: ReadonlySet<string> = new Set();
const EMPTY_BACKGROUND_STOP_TASK_IDS: ReadonlySet<string> = new Set();

interface ChatTileProps {
  node: EpicNodeRef;
  viewTabId: string;
  /**
   * True when this tile is the active leaf in the epic canvas. The
   * value is drilled into `ChatComposer` so only the active tile's
   * composer registers itself with the focused-composer-controls
   * registry that powers the command palette's "Switch model" etc.
   */
  isActive: boolean;
}

interface ChatTileSessionViewProps {
  readonly handle: ChatSessionStoreHandle;
  readonly node: EpicNodeRef;
  readonly viewTabId: string;
  readonly isActive: boolean;
  readonly currentEpicId: string;
}

function buildModelReasoningLabels(
  harnesses: ReadonlyArray<GuiHarnessCatalogEntry>,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  return new Map(
    harnesses.flatMap((harness) =>
      harness.models.map((model) =>
        reasoningLabelEntry(
          harness.id,
          model.slug,
          new Map(
            model.supportedReasoningEfforts.map((option) => [
              option.id,
              option.label,
            ]),
          ),
        ),
      ),
    ),
  );
}

function reasoningLabelEntry(
  harnessId: GuiHarnessCatalogEntry["id"],
  modelSlug: string,
  labels: ReadonlyMap<string, string>,
): readonly [string, ReadonlyMap<string, string>] {
  return [agentModelKey(harnessId, modelSlug), labels];
}

/**
 * Chat history rendered from `chat.subscribe`. The Epic session still supplies
 * the chat tile identity, title, tree placement, and mention catalog, but chat
 * content now comes from the host-owned per-chat stream.
 */
export function ChatTile(props: ChatTileProps) {
  const { node, viewTabId, isActive } = props;
  const epicId = useOpenEpicId();
  // Gate the host `chat.subscribe` on the chat record existing in the epic
  // projection (mirrors the terminal tile's `enabled: agent !== null`). The
  // create seeds the chat into the epic doc, so the record arrives in the epic
  // snapshot; until then we render the loading skeleton and never open the epic
  // ahead of the create - closing the local-first subscribe-first race.
  const chatRecord = useChatById(node.id);
  const tabHostId = useTabHostId();
  const handle = useChatSessionHandle(node.id, tabHostId, chatRecord !== null);
  const reachability = useHostReachability(tabHostId);
  // Feeds `TombstonedProfileProvider` below - "ran on <label> (removed)" for
  // a message anchored to a since-tombstoned profile. Shares the same
  // tab-scoped query the reauth gate/rate-limit prompt already read, so this
  // costs no extra host RPC.
  const providersList = useTabProvidersList({
    enabled: true,
    subscribed: false,
  });
  // The clone-offer hook runs `useEpicCreateChat`, which subscribes to
  // the host runtime. Mount it only when the banner is actually
  // shown so the live render path does not pay the subscription cost
  // (and tests that omit the host runtime provider stay green).
  const deadTileBanner =
    reachability.status === "unreachable" ? (
      <ChatDeadTileBannerContainer
        epicId={epicId}
        tabId={viewTabId}
        chatId={node.id}
        sourceHostId={tabHostId}
        hostLabel={reachability.hostLabel}
        testId={`chat-dead-tile-${node.id}`}
      />
    ) : null;

  if (handle === null) {
    return (
      <div
        data-testid="chat-tile"
        data-node-id={node.id}
        className="flex h-full min-h-0 flex-col"
      >
        {deadTileBanner}
        <ChatTileLoading />
        <ChatTileFallbackComposer
          node={node}
          viewTabId={viewTabId}
          isActive={isActive}
          currentEpicId={epicId}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-node-id={node.id}>
      {deadTileBanner}
      <TombstonedProfileProvider
        providers={providersList.data?.providers ?? []}
      >
        <ChatTileSessionView
          handle={handle}
          node={node}
          viewTabId={viewTabId}
          isActive={isActive}
          currentEpicId={epicId}
        />
      </TombstonedProfileProvider>
    </div>
  );
}

function ChatTileFallbackComposer(props: {
  readonly node: EpicNodeRef;
  readonly viewTabId: string;
  readonly isActive: boolean;
  readonly currentEpicId: string;
}): ReactNode {
  const hostId = useTabHostId();
  const workspaceControls = useMemo(
    () => (
      <HostWorkspaceSelector
        surface={{
          kind: "chat",
          hostId,
          epicId: props.currentEpicId,
          tabId: props.viewTabId,
          ownerId: props.node.id,
          binding: null,
          isOwnerActive: false,
          hasActiveTurn: false,
          // Pre-subscribe setup state: no binding resolved yet, so the chip shows
          // its loading affordance (never a "no folders" terminal state).
          missingWorktreePaths: [],
          bindingResolved: false,
          onBindingCommitted: null,
        }}
      />
    ),
    [hostId, props.currentEpicId, props.node.id, props.viewTabId],
  );
  return (
    <InertChatComposer
      taskId={props.node.id}
      isActive={props.isActive}
      mentionRoots={EMPTY_MENTION_ROOTS}
      fallbackToGlobalMentionRoots
      currentEpicId={props.currentEpicId}
      workspaceControls={workspaceControls}
      topSpacing="normal"
    />
  );
}

interface ChatDeadTileBannerContainerProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly chatId: string;
  readonly sourceHostId: string;
  readonly hostLabel: string;
  readonly testId: string;
}

function ChatDeadTileBannerContainer(
  props: ChatDeadTileBannerContainerProps,
): ReactNode {
  const chatRecord = useChatById(props.chatId);
  const offer = useChatCloneOnHostSwitch({
    epicId: props.epicId,
    tabId: props.tabId,
    sourceHostId: props.sourceHostId,
    sourceSettings: chatRecord?.settings ?? null,
  });
  return (
    <ChatDeadTileBanner
      hostLabel={props.hostLabel}
      onClone={offer.clone}
      cloning={offer.cloning}
      className={undefined}
      testId={props.testId}
    />
  );
}

interface UseChatCloneOnHostSwitchArgs {
  readonly epicId: string;
  readonly tabId: string;
  readonly sourceHostId: string;
  readonly sourceSettings: ChatRunSettings | null;
}

/**
 * Wires the chat dead-tile banner's Clone action to
 * `cloneChatOnHostSwitch`. Targets the directory's currently selected
 * host (the user's active default). Tracks the returned cancel in a
 * ref and disposes it on unmount so an aborted clone doesn't leak the
 * projection-wait subscription (ticket 10).
 */
function useChatCloneOnHostSwitch(args: UseChatCloneOnHostSwitchArgs): {
  readonly clone: () => void;
  readonly cloning: boolean;
} {
  const binding = useHostBinding();
  const createChat = useEpicCreateChat();
  const navigateNestedFocus = useEpicNestedFocusNavigation();
  const cancelRef = useRef<(() => void) | null>(null);
  const [cloning, setCloning] = useState(false);

  useEffect(() => {
    const cancelHandle = cancelRef;
    return () => {
      if (cancelHandle.current !== null) {
        cancelHandle.current();
        cancelHandle.current = null;
      }
    };
  }, []);

  const clone = useCallback(() => {
    if (binding === null) return;
    const target = binding.directory.getSelected();
    if (target === null) return;
    if (target.hostId === args.sourceHostId) return;
    if (cancelRef.current !== null) cancelRef.current();
    setCloning(true);
    cancelRef.current = cloneChatOnHostSwitch({
      epicId: args.epicId,
      tabId: args.tabId,
      sourceHostId: args.sourceHostId,
      targetHostId: target.hostId,
      directory: binding.directory,
      sourceSettings: args.sourceSettings,
      globalClient: binding.hostClient,
      onProfileFallbackToAmbient: () => {
        toast(
          "Continuing on the Terminal account - your profile isn't available on this host.",
        );
      },
      navigateNestedFocus,
      createChat: (request, callbacks) => {
        createChat.mutate(request, { onSuccess: callbacks.onSuccess });
      },
    });
  }, [
    binding,
    createChat,
    navigateNestedFocus,
    args.epicId,
    args.tabId,
    args.sourceHostId,
    args.sourceSettings,
  ]);

  return { clone, cloning };
}

interface ChatTileAccessFlags {
  readonly isOwner: boolean;
  readonly isViewer: boolean;
}

function chatTileAccessFlags(
  access: ChatSessionState["access"],
): ChatTileAccessFlags {
  const isOwner = access?.role === "owner";
  return {
    isOwner,
    isViewer: access !== null && !isOwner,
  };
}

type BackgroundBlockSearchNode =
  | MessageSegment
  | {
      readonly id: string;
      readonly children: ReadonlyArray<BackgroundBlockSearchNode>;
    }
  | {
      readonly id: string;
      readonly files: ReadonlyArray<BackgroundBlockSearchNode>;
    }
  | {
      readonly id: string;
      readonly segments: ReadonlyArray<BackgroundBlockSearchNode>;
    }
  | {
      readonly id: string;
      readonly group: {
        readonly segments: ReadonlyArray<BackgroundBlockSearchNode>;
      };
    };

function segmentContainsBackgroundBlock(
  segment: BackgroundBlockSearchNode,
  blockId: string,
): boolean {
  if (segment.id === blockId) return true;
  return backgroundBlockSearchChildren(segment).some((child) =>
    segmentContainsBackgroundBlock(child, blockId),
  );
}

function backgroundBlockSearchChildren(
  segment: BackgroundBlockSearchNode,
): ReadonlyArray<BackgroundBlockSearchNode> {
  if ("children" in segment) return segment.children;
  if ("files" in segment) return segment.files;
  if ("segments" in segment) return segment.segments;
  if ("group" in segment) return segment.group.segments;
  return [];
}

function messageIdForBlock(
  messages: ReadonlyArray<ChatMessageModel>,
  blockId: string,
): string | null {
  const owner = messages.find((message) =>
    message.segments.some((segment) =>
      segmentContainsBackgroundBlock(segment, blockId),
    ),
  );
  return owner?.id ?? null;
}

interface BackgroundClickTarget {
  readonly blockId: string;
  readonly card: ChatScrollCardKind;
}

// Both a plain agent and a workflow run render as a `subagent`-block card (a
// workflow is a dedicated rendering of that same block, never a distinct
// persisted type), so either kind opens via the same subagent open-store.
function backgroundItemCardKind(
  kind: BackgroundItem["kind"],
): ChatScrollCardKind {
  return kind === "subagent" || kind === "workflow" ? "subagent" : "tool";
}

/**
 * A nested agent - and anything it owns (commands/monitors, or a workflow's
 * fleet-attributed background work) - has no card of its own in the
 * transcript; it only renders inside its top-level ancestor's "Sub-agents"
 * section. Clicking its panel row must therefore scroll to and expand the
 * ANCESTOR card, walking up `parentTaskId` until a top-level item (null
 * parent) is reached. If the chain runs into an ancestor that already
 * settled (no longer in the live `allItems` list, so its blockId is
 * unknown) or a cycle, the walk stops at the deepest item it could still
 * resolve - an honest best-effort target rather than a wrong guess.
 */
function resolveBackgroundClickTarget(
  item: BackgroundItem,
  allItems: ReadonlyArray<BackgroundItem>,
): BackgroundClickTarget {
  const itemsByTaskId = new Map(
    allItems.map((entry) => [entry.taskId, entry] as const),
  );
  const visited = new Set<string>([item.taskId]);
  let current = item;
  while (current.parentTaskId !== null && !visited.has(current.parentTaskId)) {
    const parent = itemsByTaskId.get(current.parentTaskId);
    if (parent === undefined) break;
    visited.add(parent.taskId);
    current = parent;
  }
  return {
    blockId: current.blockId,
    card: backgroundItemCardKind(current.kind),
  };
}

function ChatTileSessionView(props: ChatTileSessionViewProps) {
  const view = useChatTileSessionViewModel(props);
  const hostId = useTabHostId();
  const systemOverlayActive = useAnySystemOverlayActive();
  const tileNavigation = useEpicTileNavigation();
  const [backgroundScrollRequest, setBackgroundScrollRequest] =
    useState<ChatMessageScrollRequest | null>(null);
  const backgroundScrollRequestIdRef = useRef(0);
  // Shared transcript jump: resolve the owning message, expand the card via its
  // open-store, and bump the scroll request the messages surface watches. Both
  // the Background panel rows and the autonomous-resume marker route through
  // here so the two navigations behave identically.
  const scrollToBlock = useCallback(
    (blockId: string, card: ChatScrollCardKind): void => {
      const messageId = messageIdForBlock(view.messages, blockId);
      if (messageId === null) return;
      if (card === "subagent") {
        useSubagentOpenStore
          .getState()
          .setOpen(props.node.instanceId, blockId, true);
      } else {
        useToolOpenStore
          .getState()
          .setOpen(props.node.instanceId, blockId, true);
      }
      backgroundScrollRequestIdRef.current += 1;
      setBackgroundScrollRequest({
        messageId,
        blockId,
        requestId: backgroundScrollRequestIdRef.current,
      });
    },
    [props.node.instanceId, view.messages],
  );
  const scrollToBackgroundItem = useCallback(
    (item: BackgroundItem): void => {
      const target = resolveBackgroundClickTarget(
        item,
        view.lower.backgroundItems ?? [],
      );
      scrollToBlock(target.blockId, target.card);
    },
    [scrollToBlock, view.lower.backgroundItems],
  );
  // Canvas-owned implementation of the chat file-change click contract. The
  // chat components receive only inert row handlers; they do not know about
  // canvas stores, tab ids, or tile factories.
  const diffOpener = useMemo<ChatSnapshotDiffOpener>(
    () => ({
      segment: (request) => {
        const tile = makeSnapshotSegmentDiffTile({
          hostId,
          chatId: view.node.id,
          sourceBlockIds: request.sourceBlockIds,
          filePath: request.filePath,
        });
        return {
          onClick: () =>
            tileNavigation.openTilePreviewInTab(view.viewTabId, tile),
          onDoubleClick: () =>
            tileNavigation.openTileInTab(view.viewTabId, tile),
        };
      },
      cumulative: (filePath) => {
        const tile = makeSnapshotCumulativeDiffTile({
          hostId,
          chatId: view.node.id,
          filePath,
        });
        return {
          onClick: () =>
            tileNavigation.openTilePreviewInTab(view.viewTabId, tile),
          onDoubleClick: () =>
            tileNavigation.openTileInTab(view.viewTabId, tile),
        };
      },
      cumulativeBundle: (filePaths) => {
        const tile = makeSnapshotCumulativeBundleDiffTile({
          hostId,
          chatId: view.node.id,
          filePaths,
        });
        return () => tileNavigation.openTileInTab(view.viewTabId, tile);
      },
      hash: (request) => {
        const tile = makeSnapshotHashDiffTile({
          hostId,
          chatId: view.node.id,
          filePath: request.filePath,
          beforeHash: request.beforeHash,
          afterHash: request.afterHash,
          title: request.title,
        });
        return {
          onClick: () =>
            tileNavigation.openTilePreviewInTab(view.viewTabId, tile),
          onDoubleClick: () =>
            tileNavigation.openTileInTab(view.viewTabId, tile),
        };
      },
    }),
    [hostId, tileNavigation, view.node.id, view.viewTabId],
  );

  return (
    <ChatDiffTargetContext.Provider value={diffOpener}>
      <ChatScrollToBlockContext.Provider value={scrollToBlock}>
        <div
          data-testid="chat-tile"
          data-node-id={view.node.id}
          className="flex h-full min-h-0 flex-col"
        >
          <ChatSessionMessagesSurface
            snapshotLoaded={view.snapshotLoaded}
            fatalClose={view.fatalClose}
            onRetry={view.onChatRetry}
            restoreContext={view.restoreContext}
            node={view.node}
            epicId={view.currentEpicId}
            viewTabId={view.viewTabId}
            tabHostId={view.tabHostId}
            workspaceRoots={view.linkResolutionRoots}
            messages={view.messages}
            backgroundItems={view.lower.backgroundItems}
            minimapItems={view.minimapItems}
            scrollRequest={backgroundScrollRequest}
            surfaceVisible={view.surfaceVisible}
            systemOverlayActive={systemOverlayActive}
            getMessageActions={view.getMessageActions}
            nextStepActions={view.nextStepActions}
            planActions={view.planActions}
          />
          <ChatTileErrorNoticeToasts handle={view.handle} />
          {/*
           * SurfaceActivityProvider narrows catalog/provider query subscriptions
           * to the pane+tab that is actually visible. Hidden keep-alive chat panes
           * (surfaceVisible = false) mark their harness-catalog and model-list
           * queries as subscribed:false, releasing their cache observer slots. The
           * queries remain in the cache and refetch on resubscribe (i.e. when the
           * pane becomes visible again), so the composer never shows stale data on
           * return. Providers compose by narrowing only — the context can never
           * widen past the parent.
           */}
          <SurfaceActivityProvider active={view.surfaceVisible}>
            <ChatLowerInteractionSurfaces
              epicId={view.currentEpicId}
              chatId={view.node.id}
              runtime={view.lower.runtime}
              access={view.lower.access}
              turn={view.lower.turn}
              interview={view.lower.interview}
              approvals={view.lower.approvals}
              queue={view.lower.queue}
              composer={view.lower.composer}
              todo={view.todo}
              restoreContext={view.restoreContext}
              backgroundItems={view.lower.backgroundItems}
              backgroundStopPendingTaskIds={
                view.lower.backgroundStopPendingTaskIds
              }
              backgroundStopAllPending={view.lower.backgroundStopAllPending}
              onBackgroundItemClick={scrollToBackgroundItem}
            />
          </SurfaceActivityProvider>
          <RevertOnEditDialog
            open={view.revertOnEdit.open}
            onOpenChange={view.revertOnEdit.onOpenChange}
            onRevert={view.revertOnEdit.onRevert}
            onDontRevert={view.revertOnEdit.onDontRevert}
            artifactCount={view.revertOnEdit.artifactCount}
          />
          <SteerSettingsConflictDialog
            open={view.steerRestart.open}
            onOpenChange={view.steerRestart.onOpenChange}
            onRestart={view.steerRestart.onRestart}
            changed={view.steerRestart.changed}
          />
          <ChatForkDialog
            open={view.fork.open}
            target={view.fork.target}
            epicId={view.currentEpicId}
            tabId={view.viewTabId}
            onOpenChange={view.fork.onOpenChange}
          />
        </div>
      </ChatScrollToBlockContext.Provider>
    </ChatDiffTargetContext.Provider>
  );
}

// Aggregates the full chat-tile view model (session handle, ui reducer, derived
// run/permission/handoff state). The branch count reflects the number of
// independent UI concerns surfaced for one tile, not reducible nesting.
// eslint-disable-next-line complexity
function useChatTileSessionViewModel(props: ChatTileSessionViewProps) {
  const { handle, node, viewTabId, isActive, currentEpicId } = props;
  const projectedChatTitle = useEpicLiveArtifactTitle(node.id);
  // Surface visibility for the stream-flush coordinator's tiered flush rate:
  // on screen = the pane is shown AND this tab is the pane's front tab. Pane
  // focus (`isActive`'s `globallyActive` half) is deliberately excluded - an
  // unfocused split pane is still visible. The same chat rendered by several
  // surfaces rolls up to visible-if-any inside the handle.
  const paneVisible = usePaneVisible();
  const tabSelected = useTabBodySelected();
  const surfaceVisible = paneVisible && tabSelected;
  useEffect(() => {
    handle.setSurfaceVisibility(viewTabId, surfaceVisible);
    return () => {
      handle.clearSurfaceVisibility(viewTabId);
    };
  }, [handle, surfaceVisible, viewTabId]);
  const [uiState, dispatchUi] = useReducer(
    chatTileUiReducer,
    undefined,
    createInitialChatTileUiState,
  );
  const [forkTarget, setForkTarget] = useState<ChatForkDialogTarget | null>(
    null,
  );
  const [prevForkNodeId, setPrevForkNodeId] = useState(node.id);
  if (node.id !== prevForkNodeId) {
    setPrevForkNodeId(node.id);
    setForkTarget(null);
  }
  const replaceDraftContent = useComposerDraftStore(
    (state) => state.replaceDraft,
  );
  const clearDraftContent = useComposerDraftStore((state) => state.clearDraft);
  const defaultPermission = useSettingsStore(
    (state) => state.defaultPermission,
  );
  const defaultSelection = useSettingsStore((state) => state.defaultSelection);
  const defaultReasoning = useSettingsStore((state) => state.defaultReasoning);
  const defaultServiceTier = useSettingsStore(
    (state) => state.defaultServiceTier,
  );
  const defaultAgentMode = useSettingsStore((state) => state.defaultAgentMode);
  const defaultRunSettings = useMemo(
    () =>
      buildChatRunSettings({
        selection: defaultSelection,
        permission: defaultPermission,
        reasoning: defaultReasoning,
        serviceTier: defaultServiceTier,
        agentMode: defaultAgentMode,
      }),
    [
      defaultAgentMode,
      defaultPermission,
      defaultReasoning,
      defaultServiceTier,
      defaultSelection,
    ],
  );
  const profile = useAuthStore((state) => state.profile);
  const activeHostId = useTabHostId();
  const currentUserId = profile?.userId ?? null;
  const localSnapshotClearMarker = useLocalSnapshotClearStore((store) =>
    localSnapshotsClearedAt(
      store.clearedAtByScope,
      currentUserId,
      activeHostId,
    ),
  );
  const collaborators = useCachedCollaborators(currentEpicId);
  const modelCatalog = useGuiHarnessCatalog(null, {
    enabled: true,
    subscribed: surfaceVisible,
  });
  const modelLabels = useMemo<ReadonlyMap<string, string>>(
    () =>
      new Map(
        modelCatalog.harnesses.flatMap((harness) =>
          harness.models.map((model) => [
            agentModelKey(harness.id, model.slug),
            model.label,
          ]),
        ),
      ),
    [modelCatalog.harnesses],
  );
  const modelReasoningLabels = useMemo(
    () => buildModelReasoningLabels(modelCatalog.harnesses),
    [modelCatalog.harnesses],
  );
  const handoffScope = useMemo<InitialChatHandoffScope>(
    () => ({
      hostId: activeHostId,
      userId: profile?.userId ?? null,
      epicId: currentEpicId,
    }),
    [activeHostId, currentEpicId, profile?.userId],
  );
  // The handoff state is owned by `useInitialChatHandoffDriver` below;
  // this component does not subscribe to the handoff store to avoid
  // re-rendering the entire tile whenever the handoff transitions.
  const state = useStore(
    handle.store,
    useShallow((s) => ({
      connectionStatus: s.connectionStatus,
      fatalClose: s.fatalClose,
      snapshotLoaded: s.snapshotLoaded,
      chat: s.chat,
      access: s.access,
      messages: s.messages,
      events: s.events,
      queue: s.queue,
      runStatus: s.runStatus,
      activeTurn: s.activeTurn,
      turnInProgress: s.turnInProgress,
      pendingApprovals: s.pendingApprovals,
      pendingFileEditApprovals: s.pendingFileEditApprovals,
      pendingInterviews: s.pendingInterviews,
      accumulatedFileChanges: s.accumulatedFileChanges,
      backgroundItems: s.backgroundItems,
      pendingBackgroundStops: s.pendingBackgroundStops,
      pendingBackgroundStopAll: s.pendingBackgroundStopAll,
      restore: s.restore,
      pendingActions: s.pendingActions,
      acceptedActions: s.acceptedActions,
      pendingUserMessages: s.pendingUserMessages,
      currentComposerSettings: s.currentComposerSettings,
      liveAssistantMessage: s.liveAssistantMessage,
      worktreeBinding: s.worktreeBinding,
      missingWorktreePaths: s.missingWorktreePaths,
      refreshMissingWorktreePaths: s.refreshMissingWorktreePaths,
    })),
  );
  const chatWorktreeStagingKeyId = useMemo(
    () =>
      worktreeStagingKeyString({
        surface: "owner",
        epicId: currentEpicId,
        ownerKind: "chat",
        ownerId: node.id,
      }),
    [currentEpicId, node.id],
  );
  const stagedChatWorktreeIntent = useWorktreeIntentStagingStore(
    (s) => s.intentByKey[chatWorktreeStagingKeyId],
  );
  const stagedChatWorkspacePaths = useMemo<ReadonlySet<string>>(() => {
    if (stagedChatWorktreeIntent === undefined) {
      return EMPTY_WORKSPACE_PATH_SET;
    }
    return new Set(
      stagedChatWorktreeIntent.entries.map((entry) => entry.workspacePath),
    );
  }, [stagedChatWorktreeIntent]);
  const effectiveMissingPaths = effectiveMissingWorktreePaths(
    state.missingWorktreePaths,
    stagedChatWorkspacePaths,
  );
  const refreshMissingWorktreePaths = state.refreshMissingWorktreePaths;
  const clearMissingPathsAfterBindingCommit = useCallback(
    (changedWorkspacePaths: ReadonlyArray<string>): void => {
      if (changedWorkspacePaths.length === 0) return;
      const changedPathSet = new Set(changedWorkspacePaths);
      refreshMissingWorktreePaths((current) =>
        current.filter((workspacePath) => !changedPathSet.has(workspacePath)),
      );
    },
    [refreshMissingWorktreePaths],
  );

  // A chat's mention roots are its own working directories, taken from the
  // per-device worktree binding (the source the host workspace selector
  // renders). The epic snapshot's workspace folders are a separate,
  // epic-level set that can be empty even when the chat is bound to a folder.
  const mentionRoots = useMemo(
    () => mentionRootsFromWorktreeBinding(state.worktreeBinding),
    [state.worktreeBinding],
  );
  const isFolderlessWorkspace = worktreeBindingIsFolderless(
    state.worktreeBinding,
  );
  // Roots that markdown link resolution (the chat link policy) resolves
  // relative assistant links against. In inherited workspace mode, an empty
  // binding falls back to the Epic folders. Explicit folderless mode disables
  // that fallback so workspace file/folder links don't resolve through unrelated
  // global roots.
  const linkResolutionRoots = useWorkspaceMentionRoots(
    mentionRoots,
    !isFolderlessWorkspace,
  );
  // The composer is runnable when the chat carries its own folder binding OR
  // when the epic has at least one workspace folder (the chat then runs local
  // against it). The workspace selector itself stays owner-scoped to the
  // chat's binding so sibling chat folders do not appear in this chip.
  const workspaceAvailability = useChatWorkspaceAvailability(
    currentEpicId,
    state.worktreeBinding,
    state.snapshotLoaded,
    effectiveMissingPaths,
  );
  // Pair the missing-folder send-disable with an on-focus / pane-activation
  // re-check so restoring a deleted folder clears the disable without a send or
  // reload. Syncs the fresh server-side missing set into the same store field
  // the gate (and the recovery toast) read.
  useChatMissingWorktreeFocusRefresh({
    handle,
    epicId: currentEpicId,
    chatId: node.id,
    surfaceVisible,
    hasBinding:
      state.worktreeBinding !== null &&
      state.worktreeBinding.entries.length > 0,
  });

  const displayContext = useMemo<SenderDisplayContext>(
    () => ({ profile, collaborators, modelLabels, modelReasoningLabels }),
    [collaborators, modelLabels, modelReasoningLabels, profile],
  );
  const renderedDisplayContext = useMemo<RenderedMessagesDisplayContext>(
    () => ({
      resolveUserSenderLabel: (sender) =>
        resolveSenderLabel(sender, displayContext),
      resolveAgentSenderDisplay: (sender) =>
        resolveAgentSenderDisplay(sender, displayContext),
      resolveAgentReasoningLabel: (sender, reasoningEffort) =>
        resolveAgentReasoningLabel(sender, reasoningEffort, displayContext),
      contentBlocksText,
    }),
    [displayContext],
  );
  const activeTurnId = state.activeTurn?.turnId ?? null;
  // In-progress UI (restore gating, owner-active, the per-row "Working…" /
  // "Stopping…" indicator below) is driven by the host-owned chat
  // `runStatus` - the single source of truth that covers the first turn and
  // every multi-turn send and flips to `stopping` the moment a stop is
  // requested. We map it onto the composer's turn-status prop shape
  // (`running`/`stopping`/null).
  const activeTurnStatus = composerTurnStatus(state.runStatus);
  // Several consumers below (the row indicator, the composer Stop/Send
  // toggle, restore gating) need a narrower question than the label above:
  // `runStatus` also reads "running" while a queued item is pending or
  // visible background work outlives the turn (Bash `run_in_background` / a
  // subagent / Monitor) - neither of which corresponds to an active turn
  // they can act on or attribute an indicator to. See
  // `resolvedTurnStatus`'s doc comment for the exact derivation.
  const composerActiveTurnStatus = resolvedTurnStatus(state, activeTurnStatus);
  const renderedMessages = useRenderedMessages(
    {
      messages: state.messages,
      events: state.events,
      pendingUserMessages: state.pendingUserMessages,
      liveAssistantMessage: state.liveAssistantMessage,
      activeTurn: state.activeTurn,
      pendingApprovals: state.pendingApprovals,
      pendingFileEditApprovals: state.pendingFileEditApprovals,
      pendingInterviews: state.pendingInterviews,
      // Narrowed, not the raw `state.runStatus`: this drives the per-row
      // "Working…"/"Stopping…" indicator, which belongs to a genuinely
      // active turn - passing the raw value synthesizes a duplicate, live
      // indicator row during background-only phase (no active turn) even
      // after the real row has already settled to its "done" footer.
      runStatus: composerActiveTurnStatus ?? "idle",
      // Binding identity for the in-transcript setup card (replaces the old
      // strip's mount-time tuple): epic + chat owner route the retry mutation
      // and scope the terminal-liveness query; `viewTabId` rides the synthetic
      // segment for the focus-terminal path.
      epicId: currentEpicId,
      ownerId: node.id,
      ownerKind: "chat",
      viewTabId,
    },
    renderedDisplayContext,
  );
  const editingQueueItem =
    state.queue.items.find(
      (item) => item.queueItemId === uiState.editingQueueItemId,
    ) ?? null;
  const activeEditingQueueItemId = editingQueueItem?.queueItemId ?? null;
  const chatSettingsSeed = state.chat?.settings ?? null;
  const {
    composerFallbackSettingsSeed,
    epicRunSettings,
    globalLastRunSettings,
    initialComposerSettings,
    setEpicRunSettings,
  } = useChatTileComposerSettingsSeeds({
    currentEpicId,
    persistedChatSettings: chatSettingsSeed,
    defaultRunSettings,
  });
  useInitializeChatComposerSettings({
    snapshotLoaded: state.snapshotLoaded,
    currentComposerSettings: state.currentComposerSettings,
    initialSettings: initialComposerSettings,
    setCurrentComposerSettings:
      handle.store.getState().setCurrentComposerSettings,
  });

  // Single owner for the initial-chat-handoff state machine. Replaces
  // five sibling effects that previously coordinated handoff failure
  // detection, failed-send restoration, sending→consumed transitions
  // (via acceptedActions or via persisted messages), and the
  // waitingChat→sendMessage→markSending hop.
  useInitialChatHandoffDriver({
    handle,
    nodeId: node.id,
    scope: handoffScope,
    profileUserId: profile?.userId ?? null,
  });
  useChatSetupFailureRestoreDriver({
    handle,
    nodeId: node.id,
  });
  // Surface the server-spawned setup terminal in the Terminals sidebar while it
  // runs - its PTY isn't created via the renderer, so nothing else refetches
  // `terminal.list`.
  useSetupTerminalListRefreshDriver({ handle });
  // Persist the setup terminal as a saved (background) canvas tab so it survives
  // a restart like a user-opened terminal, instead of vanishing (no saved tab).
  useSetupTerminalTabRegisterDriver({ handle, viewTabId });

  // A chat is editable only by its own owner; every other user is read-only.
  // Gate on a KNOWN non-owner (access resolved AND not the owner) rather than a
  // positive `role === "viewer"` check, so any non-owner is treated as
  // read-only. During the optimistic create-flow window `access` is null
  // (unknown) - the creator owns the chat, so we must not flash a viewer banner
  // then; the real snapshot resolves the role.
  const accessFlags = chatTileAccessFlags(state.access);
  const canAct = chatTileCanAct(
    state.connectionStatus,
    state.access?.canAct === true,
    profile !== null,
  );
  const stopPending = Object.values(state.pendingActions).some(
    (action) => action.action === "stop",
  );
  const approvalDecisionPending = Object.values(state.pendingActions).some(
    (action) => action.action === "approvalDecision",
  );
  const turnStopBusy = stopPending || composerActiveTurnStatus === "stopping";
  const stopDisabled = !canAct || turnStopBusy;
  const chatActions = useChatActions(handle);
  const restoreActionPending = useMemo(
    () =>
      Object.values(state.pendingActions).some(
        (action) =>
          action.action === "restoreCheckpoint" ||
          action.action === "revertFileChanges" ||
          // A revert-on-edit runs its cumulative revert under the
          // `editUserMessage` action (before the new turn starts), so include
          // it here to keep the accumulated-changes panel locked during it.
          action.action === "editUserMessage",
      ),
    [state.pendingActions],
  );
  const accumulatedFileChanges = useMemo(
    () =>
      accumulatedFileChangesFromMessages(
        renderedMessages,
        state.accumulatedFileChanges,
        activeTurnId,
      ),
    [activeTurnId, renderedMessages, state.accumulatedFileChanges],
  );
  const restoreContext = useMemo(
    () => ({
      accessRole: state.access?.role ?? null,
      currentUserId,
      activeHostId,
      // Restoring/reverting files while a turn is actively writing is unsafe,
      // but that's a turn-scoped concern, same as the composer's Stop button -
      // `runStatus` alone also reads non-idle during background-only phase
      // (Bash `run_in_background` / a subagent / Monitor with no active
      // turn), which restore/revert can't conflict with. Use the same
      // narrowed value the Stop button uses instead of the raw one, or this
      // would show "Wait for the active turn to finish" and block restore
      // during a window where nothing is actually running against it.
      activeTurnStatus: composerActiveTurnStatus,
      localSnapshotsClearedAt: localSnapshotClearMarker,
      restore: state.restore,
      restoreActionPending,
      restoreCheckpoint: chatActions.restoreCheckpoint,
      accumulatedFileChanges,
      revertFileChanges: chatActions.revertFileChanges,
    }),
    [
      accumulatedFileChanges,
      activeHostId,
      composerActiveTurnStatus,
      chatActions.restoreCheckpoint,
      chatActions.revertFileChanges,
      currentUserId,
      localSnapshotClearMarker,
      restoreActionPending,
      state.access?.role,
      state.restore,
    ],
  );
  // Memoize: `currentSettingsForChatTile` returns a fresh object every call, so
  // without this `currentComposerSettings` churns identity every render. It feeds
  // `steerQueuedItemNow` (→ lowerQueue → composerModel), so an unstable identity
  // defeats the `ChatComposerRegion` memo and re-renders the whole composer on
  // every streamed token. Inputs are stream-stable. See RENDER_PERF_INVARIANTS.md.
  const currentComposerSettings = useMemo(
    () =>
      currentSettingsForChatTile({
        liveSettings: state.currentComposerSettings,
        editingQueueItemSettings:
          editingQueueItem === null ? null : editingQueueItem.settings,
        persistedChatSettings: state.chat?.settings ?? null,
        epicRunSettings,
        globalLastRunSettings,
        defaultRunSettings,
      }),
    [
      state.currentComposerSettings,
      editingQueueItem,
      state.chat?.settings,
      epicRunSettings,
      globalLastRunSettings,
      defaultRunSettings,
    ],
  );
  const nextStepSettings = currentComposerSettings;
  const editSettings = nextStepSettings;
  const canModifyMessages = canModifyChatMessages({ canAct, state });
  const activeInlineEdit = normalizeInlineEditForSession(
    uiState.inlineEdit,
    state,
  );

  const displayedMessages = useMemo(() => {
    if (activeInlineEdit === null) return renderedMessages;
    if (
      renderedMessages.some(
        (message) =>
          message.persistentMessageId === activeInlineEdit.targetMessageId,
      )
    ) {
      return renderedMessages;
    }
    return [...renderedMessages, activeInlineEdit.originalMessage];
  }, [activeInlineEdit, renderedMessages]);
  // The rendered rows are the full history, so the pinned snapshot and the
  // inline todo/task-tool stripping derive from the same walk.
  const pinnedTodoRenderState = useMemo(
    () => buildPinnedTodoRenderState(displayedMessages),
    [displayedMessages],
  );
  // Minimap rail entries mirror the user rows Virtuoso renders; ids are the
  // rendered row ids (including queue-steer rows), so minimap clicks resolve
  // directly against the list.
  const minimapItems = useMemo(
    () => buildChatUserMessageMinimapItems(pinnedTodoRenderState.messages),
    [pinnedTodoRenderState.messages],
  );
  const hostPendingInterviewIds = useMemo(
    () =>
      new Set(state.pendingInterviews.map((interview) => interview.blockId)),
    [state.pendingInterviews],
  );
  // First host-pending streaming interview block found in chat history.
  // Rendered in the composer slot; inline rendering is suppressed in
  // `chat-message-assistant-body.tsx`.
  const pendingInterview = useMemo(
    () =>
      findPendingInterview(renderedMessages, (id) =>
        hostPendingInterviewIds.has(id),
      ),
    [hostPendingInterviewIds, renderedMessages],
  );
  const showCompletedRestoreToast = useCallback(() => {
    if (state.restore === null || state.restore.kind !== "completed") return;
    showRestoreResultToast(state.restore.results);
  }, [state.restore]);
  useActivePaneEffect(showCompletedRestoreToast);
  // All pending approvals route to the composer slot - single or many
  // share one canonical surface. Inline rendering for pending approvals
  // is suppressed; resolved approvals stay inline as turn history.
  const dispatchApprovalDecision = useCallback(
    (approvalId: string, approved: boolean) => {
      chatActions.approvalDecision(approvalId, { approved });
    },
    [chatActions],
  );
  const dispatchFileEditApprovalDecision = useCallback(
    (approvalId: string, approved: boolean) => {
      chatActions.fileEditApprovalDecision(approvalId, { approved });
    },
    [chatActions],
  );
  const handleInterviewAnswer = useCallback(
    (blockId: string, answers: ReadonlyArray<InterviewAnswer>) => {
      return chatActions.interviewAnswer(blockId, answers);
    },
    [chatActions],
  );
  const handleInterviewError = useCallback(
    (blockId: string, reason: string) => {
      return chatActions.interviewError(blockId, reason);
    },
    [chatActions],
  );

  const { messageActionsFor, forkAtAssistantMessage, revertOnEdit } =
    useChatMessageActions({
      dispatchUi,
      activeInlineEdit,
      canModifyMessages,
      canAct,
      currentComposerSettings,
      editSettings,
      mentionRoots,
      currentEpicId,
      node,
      chatTitle: projectedChatTitle ?? state.chat?.title ?? null,
      chatParentId: state.chat?.parentId ?? null,
      messages: state.messages,
      events: state.events,
      profile,
      chatActions,
      confirmingDeleteMessageId: uiState.confirmingDeleteMessageId,
      setForkTarget,
      worktreeBinding: state.worktreeBinding,
      revertOnEditOpen: uiState.revertOnEditOpen,
    });

  const submitMessage = useCallback(
    (input: ChatComposerSubmitInput): boolean => {
      if (!canAct) return false;
      if (profile === null) return false;
      const sender: UserMessageSender = {
        type: "user",
        userId: profile.userId,
      };
      if (activeEditingQueueItemId !== null) {
        const actionId = chatActions.queueEdit(
          activeEditingQueueItemId,
          input.content,
        );
        if (actionId === null) return false;
        if (
          chatActions.queueSettingsUpdate(
            activeEditingQueueItemId,
            input.settings,
          ) === null
        ) {
          return false;
        }
        dispatchUi({ type: "setEditingQueueItemId", editingQueueItemId: null });
        return true;
      }
      const expectedTitle = state.chat?.title ?? node.name;
      const shouldMarkTitlePending = shouldGenerateChatTitleForSubmittedMessage(
        {
          chat: state.chat,
          messages: state.messages,
          pendingUserMessages: state.pendingUserMessages,
          content: input.content,
        },
      );
      const sent = chatActions.sendMessage(
        input.content,
        sender,
        input.settings,
      );
      if (sent === null) return false;
      if (shouldMarkTitlePending) {
        useEpicCanvasStore
          .getState()
          .markChatTitlePending(node.id, expectedTitle);
      }
      return true;
    },
    [
      activeEditingQueueItemId,
      canAct,
      chatActions,
      node.id,
      node.name,
      profile,
      state.chat,
      state.messages,
      state.pendingUserMessages,
    ],
  );
  const canSendNextStep =
    canAct &&
    !turnStopBusy &&
    !composerHasBlockingApprovals(
      state.pendingApprovals,
      state.pendingFileEditApprovals.length,
    );
  const sendNextStep = useCallback(
    (option: TraycerNextStepOption): boolean => {
      if (!canSendNextStep) return false;
      const sender = userMessageSenderForProfile(profile);
      if (sender === null) return false;
      const content = buildSubmittedChatJSONContent(
        plainTextPromptContent(option.prompt),
      );
      return (
        chatActions.sendMessage(content, sender, nextStepSettings) !== null
      );
    },
    [canSendNextStep, chatActions, nextStepSettings, profile],
  );
  const nextStepActions = useMemo(
    () => ({
      canSend: canSendNextStep,
      onSend: sendNextStep,
    }),
    [canSendNextStep, sendNextStep],
  );
  const sendImplementPlanMessage = useCallback((): boolean => {
    if (!canAct) return false;
    const sender = userMessageSenderForProfile(profile);
    if (sender === null) return false;
    const content = buildSubmittedChatJSONContent(
      plainTextPromptContent("Implement the plan above."),
    );
    return chatActions.sendMessage(content, sender, nextStepSettings) !== null;
  }, [canAct, chatActions, nextStepSettings, profile]);
  const planActions = useMemo<ChatPlanActionsContextValue>(
    () => ({
      epicId: currentEpicId,
      chatId: node.id,
      canAct,
      pending: approvalDecisionPending,
      onImplement: sendImplementPlanMessage,
    }),
    [
      approvalDecisionPending,
      canAct,
      currentEpicId,
      node.id,
      sendImplementPlanMessage,
    ],
  );
  // Durable settings sync: mirror composer selection changes onto the host's
  // per-chat record so headless turns (incoming A2A messages) run on the
  // freshly picked profile. Best-effort - an old host rejects the optional
  // method with E_HOST_UNSUPPORTED and behavior degrades to persist-on-send.
  // Routed through the module-scoped `enqueuePersistChatRunSettings` (not a
  // local chain) so a task-wide switch's sibling writes
  // (`useTaskProfileRateLimitSwitch`) serialize against THIS chat's own
  // composer writes too, not just against each other.
  const updateChatRunSettings = useEpicUpdateChatRunSettings();
  const updateChatRunSettingsMutateAsync = updateChatRunSettings.mutateAsync;
  const persistChatRunSettings = useCallback(
    (settings: ChatRunSettings): void => {
      enqueuePersistChatRunSettings(updateChatRunSettingsMutateAsync, {
        epicId: currentEpicId,
        chatId: node.id,
        settings,
      });
    },
    [currentEpicId, node.id, updateChatRunSettingsMutateAsync],
  );
  const {
    editQueuedItem,
    cancelQueuedItem,
    abortSteerQueuedItem,
    cancelQueueEditMode,
    reorderQueuedItem,
    steerQueuedItemNow,
    handleComposerSettingsChange,
    steerRestart,
  } = useChatQueueActions({
    chatActions,
    handle,
    nodeId: node.id,
    replaceDraftContent,
    clearDraftContent,
    currentComposerSettings,
    currentEpicId,
    editingQueueItemId: uiState.editingQueueItemId,
    activeEditingQueueItemId,
    dispatchUi,
    setEpicRunSettings,
    persistChatRunSettings,
  });
  const handleForkOpenChange = useCallback((open: boolean): void => {
    if (!open) setForkTarget(null);
  }, []);
  // The chip renders as a sibling block below the composer (mirroring
  // the landing page) so the input box stays focused on prompt editing
  // and the binding affordances live alongside it. The selector reads
  // the chat session's `worktreeBinding` (populated from
  // `chat.subscribe`) and the cascading menu drives create / import /
  // re-bind through the existing modals.
  const hostWorkspaceSelector = useMemo(
    () => (
      <HostWorkspaceSelector
        surface={{
          kind: "chat",
          hostId: activeHostId,
          epicId: currentEpicId,
          tabId: viewTabId,
          ownerId: node.id,
          binding: state.worktreeBinding,
          isOwnerActive: activeTurnStatus !== null,
          // Distinguishes WHY the owner reads active, for the disabled-remove
          // tooltip wording only (the disable decision itself stays on the
          // broader `isOwnerActive`, unchanged - a live background Bash/Monitor
          // could still be reading or writing in the folder even with no
          // foreground turn active). `false` here means it's active purely
          // because of visible background work, not a turn the "stop" wording
          // would make sense for.
          hasActiveTurn: composerActiveTurnStatus !== null,
          missingWorktreePaths: effectiveMissingPaths,
          bindingResolved: state.snapshotLoaded,
          onBindingCommitted: clearMissingPathsAfterBindingCommit,
        }}
      />
    ),
    [
      activeHostId,
      currentEpicId,
      node.id,
      state.worktreeBinding,
      effectiveMissingPaths,
      state.snapshotLoaded,
      activeTurnStatus,
      composerActiveTurnStatus,
      clearMissingPathsAfterBindingCommit,
      viewTabId,
    ],
  );
  const usageChip = useMemo(
    () => <ContextUsageChipForChat handle={handle} />,
    [handle],
  );
  // Composer v3 cluster: host select + Workspace rail picker on the left, with
  // the context-usage leaf owning its trailing chip and optional full-width
  // pinned strip. Per-folder Environment config lives inside the selected
  // Workspace panel.
  const workspaceControls = useMemo(
    () => (
      <>
        <div className="min-w-0 overflow-hidden">{hostWorkspaceSelector}</div>
        <ChatStatusWorktreePrPills
          hostId={activeHostId}
          epicId={currentEpicId}
          chatId={node.id}
          binding={state.worktreeBinding}
          enabled={surfaceVisible}
        />
        {usageChip}
      </>
    ),
    [
      activeHostId,
      currentEpicId,
      hostWorkspaceSelector,
      node.id,
      state.worktreeBinding,
      surfaceVisible,
      usageChip,
    ],
  );

  const lowerRuntime = useMemo(
    () => ({
      snapshotLoaded: state.snapshotLoaded,
    }),
    [state.snapshotLoaded],
  );

  const lowerAccess = useMemo(
    () => ({
      isViewer: accessFlags.isViewer,
      canAct,
    }),
    [accessFlags.isViewer, canAct],
  );

  const lowerTurn = useMemo(
    () => ({
      activeTurnStatus: composerActiveTurnStatus,
      stopDisabled,
      onStopTurn: chatActions.stopTurn,
    }),
    [composerActiveTurnStatus, stopDisabled, chatActions.stopTurn],
  );

  const forkPendingInterviewAssistantMessageId =
    pendingInterview?.assistantMessageId ?? null;
  const forkFromPendingInterview = useMemo(
    () =>
      forkPendingInterviewAssistantMessageId === null
        ? null
        : (mode: ChatForkMode) =>
            forkAtAssistantMessage(
              forkPendingInterviewAssistantMessageId,
              mode,
            ),
    [forkPendingInterviewAssistantMessageId, forkAtAssistantMessage],
  );
  const lowerInterview = useMemo(
    () => ({
      pending: pendingInterview,
      onAnswer: handleInterviewAnswer,
      onError: handleInterviewError,
      onFork: forkFromPendingInterview,
    }),
    [
      pendingInterview,
      handleInterviewAnswer,
      handleInterviewError,
      forkFromPendingInterview,
    ],
  );

  const lowerApprovals = useMemo(
    () => ({
      pendingFileEditApprovals: state.pendingFileEditApprovals,
      pendingApprovals: state.pendingApprovals,
      onFileEditDecision: dispatchFileEditApprovalDecision,
      onApprovalDecision: dispatchApprovalDecision,
    }),
    [
      state.pendingFileEditApprovals,
      state.pendingApprovals,
      dispatchFileEditApprovalDecision,
      dispatchApprovalDecision,
    ],
  );

  const lowerQueue = useMemo(
    () => ({
      editingItem: editingQueueItem,
      editingItemId: activeEditingQueueItemId,
      value: state.queue,
      onPause: chatActions.pauseQueue,
      onResume: chatActions.resumeQueue,
      onEdit: editQueuedItem,
      onCancel: cancelQueuedItem,
      onAbortSteer: abortSteerQueuedItem,
      onCancelEdit: cancelQueueEditMode,
      onStopBackgroundItem: chatActions.stopBackgroundItem,
      onStopAllBackgroundItems: chatActions.stopAllBackgroundItems,
      onReorder: reorderQueuedItem,
      onSteerNow: steerQueuedItemNow,
    }),
    [
      editingQueueItem,
      activeEditingQueueItemId,
      state.queue,
      chatActions.pauseQueue,
      chatActions.resumeQueue,
      editQueuedItem,
      cancelQueuedItem,
      abortSteerQueuedItem,
      cancelQueueEditMode,
      chatActions.stopBackgroundItem,
      chatActions.stopAllBackgroundItems,
      reorderQueuedItem,
      steerQueuedItemNow,
    ],
  );

  const lowerComposer = useMemo(
    () => ({
      sessionSettingsSeed: state.currentComposerSettings ?? chatSettingsSeed,
      fallbackSettingsSeed: composerFallbackSettingsSeed,
      nodeId: node.id,
      isActive,
      mentionRoots,
      fallbackToGlobalMentionRoots: !isFolderlessWorkspace,
      currentEpicId,
      onSubmitMessage: submitMessage,
      onSettingsChange: handleComposerSettingsChange,
      workspaceControls,
      workspaceAvailability,
    }),
    [
      state.currentComposerSettings,
      chatSettingsSeed,
      composerFallbackSettingsSeed,
      node.id,
      isActive,
      mentionRoots,
      isFolderlessWorkspace,
      currentEpicId,
      submitMessage,
      handleComposerSettingsChange,
      workspaceControls,
      workspaceAvailability,
    ],
  );

  const backgroundStopPendingTaskIds = useMemo<ReadonlySet<string>>(() => {
    const taskIds = [
      ...Object.keys(state.pendingBackgroundStops),
      ...(state.pendingBackgroundStopAll === null
        ? []
        : Array.from(state.pendingBackgroundStopAll.taskIds)),
    ];
    if (taskIds.length === 0) return EMPTY_BACKGROUND_STOP_TASK_IDS;
    return new Set(taskIds);
  }, [state.pendingBackgroundStopAll, state.pendingBackgroundStops]);

  return {
    handle,
    node,
    viewTabId,
    tabHostId: activeHostId,
    mentionRoots,
    linkResolutionRoots,
    currentEpicId,
    snapshotLoaded: state.snapshotLoaded,
    fatalClose: state.fatalClose,
    onChatRetry: () => handle.store.getState().retry(),
    restoreContext,
    messages: pinnedTodoRenderState.messages,
    minimapItems,
    surfaceVisible,
    getMessageActions: messageActionsFor,
    nextStepActions,
    planActions,
    lower: {
      runtime: lowerRuntime,
      access: lowerAccess,
      turn: lowerTurn,
      interview: lowerInterview,
      approvals: lowerApprovals,
      queue: lowerQueue,
      composer: lowerComposer,
      backgroundItems: state.backgroundItems,
      backgroundStopPendingTaskIds,
      backgroundStopAllPending:
        state.pendingBackgroundStopAll !== null ||
        backgroundStopPendingTaskIds.size > 0,
    },
    todo: pinnedTodoRenderState.todo,
    revertOnEdit,
    steerRestart,
    fork: {
      open: forkTarget !== null,
      target: forkTarget,
      onOpenChange: handleForkOpenChange,
    },
    chatTitle: projectedChatTitle ?? state.chat?.title ?? node.name,
  };
}

interface ChatSessionMessagesSurfaceProps {
  readonly snapshotLoaded: boolean;
  readonly fatalClose: FatalErrorDetails | null;
  readonly onRetry: () => void;
  readonly restoreContext: ChatRestoreContextValue;
  readonly node: EpicNodeRef;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly tabHostId: string | null;
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  readonly minimapItems: ReadonlyArray<ChatUserMinimapItem>;
  readonly scrollRequest: ChatMessageScrollRequest | null;
  readonly surfaceVisible: boolean;
  readonly systemOverlayActive: boolean;
  readonly getMessageActions: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  readonly nextStepActions: NextStepActionHandler;
  readonly planActions: ChatPlanActionsContextValue;
}

/**
 * Subscribes directly to the chat store for the chip's two inputs
 * (`liveTurnUsage` and the last assistant message's persisted usage) so
 * that ONLY the chip re-renders on `usage.updated` and streaming text
 * deltas - the surrounding tile (composer, message list, host picker,
 * banners) stays unaffected. liveTurnUsage takes precedence over the
 * persisted fallback so the chip shows live in-flight numbers during a
 * turn and carries the final usage forward across the gap between
 * turn.completed and the next snapshot.
 */
function selectContextUsage(s: ChatSessionState): TokenUsage | null {
  return s.liveTurnUsage ?? findLastAssistantUsage(s.messages);
}

function findLastAssistantUsage(
  messages: ReadonlyArray<Message>,
): TokenUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.usage !== null) {
      return message.usage;
    }
  }
  return null;
}

function ContextUsageChipForChat(props: {
  readonly handle: ChatSessionStoreHandle;
}): ReactNode {
  const usage = useStore(props.handle.store, selectContextUsage);
  return <ContextUsageChip usage={usage} />;
}

function ChatSessionMessagesSurface(
  props: ChatSessionMessagesSurfaceProps,
): ReactNode {
  useEffect(() => {
    if (props.fatalClose === null) return;
    emitChatStreamErrorNotification({
      epicId: props.epicId,
      chatId: props.node.id,
      details: props.fatalClose,
    });
  }, [props.fatalClose, props.epicId, props.node.id]);

  // A fatal close before any snapshot (CHAT_INVALID, CHAT_NOT_VISIBLE, …) means
  // the host will never send one. Surface the reason + a retry instead of an
  // indefinite spinner.
  if (!props.snapshotLoaded && props.fatalClose !== null) {
    return <ChatTileError details={props.fatalClose} onRetry={props.onRetry} />;
  }
  // Show the loading skeleton until the real `chat.subscribe` snapshot lands
  // (~0.5s - the host is local-first). The snapshot then renders the user
  // message + real turn state in one transition; there is no optimistic seed.
  if (!props.snapshotLoaded) return <ChatTileLoading />;
  // Pick the in-progress "thinking" verb once per turn, seeded on the chat plus
  // its completed-turn count - NOT the indicator row id, which flips from
  // `assistant:live` to `assistant:<turnId>` mid-turn and would otherwise
  // reshuffle the word. The count only advances when a turn finishes, so it
  // stays fixed for the whole run while still varying turn-to-turn.
  const completedTurnCount = props.messages.filter(
    (message) => message.role === "assistant" && message.completedAt !== null,
  ).length;
  const workingVerb = pickWorkingVerb(`${props.node.id}:${completedTurnCount}`);
  return (
    <ChatRestoreProvider value={props.restoreContext}>
      <ChatPlanActionsContext.Provider value={props.planActions}>
        <WorkingVerbContext.Provider value={workingVerb}>
          <ChatMarkdownLinkProvider
            tabId={props.viewTabId}
            hostId={props.tabHostId}
            workspaceRoots={props.workspaceRoots}
          >
            <ChatMessages
              taskTitle={props.node.name}
              taskId={props.node.id}
              messages={props.messages}
              backgroundItems={props.backgroundItems}
              minimapItems={props.minimapItems}
              scrollRequest={props.scrollRequest}
              scrollStateKey={props.node.instanceId}
              getMessageActions={props.getMessageActions}
              nextStepActions={props.nextStepActions}
              instanceId={props.node.instanceId}
              visible={props.surfaceVisible}
              systemOverlayActive={props.systemOverlayActive}
            />
          </ChatMarkdownLinkProvider>
        </WorkingVerbContext.Provider>
      </ChatPlanActionsContext.Provider>
    </ChatRestoreProvider>
  );
}

function useChatTileComposerSettingsSeeds(input: {
  readonly currentEpicId: string;
  readonly persistedChatSettings: ChatRunSettings | null;
  readonly defaultRunSettings: ChatRunSettings;
}) {
  const { globalLastRunSettings, epicRunSettingsEntry, setEpicRunSettings } =
    useComposerRunSettingsStore(
      useShallow((state) => ({
        globalLastRunSettings: state.globalLastRunSettings,
        epicRunSettingsEntry: Object.hasOwn(
          state.epicRunSettingsByEpicId,
          input.currentEpicId,
        )
          ? state.epicRunSettingsByEpicId[input.currentEpicId]
          : null,
        setEpicRunSettings: state.setEpicRunSettings,
      })),
    );
  const epicRunSettings =
    settingsFromEpicRunSettingsEntry(epicRunSettingsEntry);
  const composerFallbackSettingsSeed = fallbackSettingsSeedForChatComposer(
    epicRunSettings,
    globalLastRunSettings,
  );
  const initialComposerSettings = currentSettingsForChatTile({
    liveSettings: null,
    editingQueueItemSettings: null,
    persistedChatSettings: input.persistedChatSettings,
    epicRunSettings,
    globalLastRunSettings,
    defaultRunSettings: input.defaultRunSettings,
  });

  return {
    composerFallbackSettingsSeed,
    epicRunSettings,
    globalLastRunSettings,
    initialComposerSettings,
    setEpicRunSettings,
  };
}

/**
 * Re-checks the chat's bound folders for on-disk existence whenever this pane is
 * visible and the window regains focus, and syncs the fresh missing set into the
 * chat store. This is what makes the composer's missing-folder send-disable
 * recoverable: `worktree.getBinding` recomputes `missingWorktreePaths`
 * server-side, so restoring a deleted folder and returning to the window lifts
 * the disable without a send or reload (the on-send re-stat is otherwise the
 * only recompute trigger, which a disabled composer can never reach).
 *
 * Scoped to the visible SURFACE (pane visible AND this tab selected) via the
 * `enabled` gate so backgrounded keep-alive chats - including a non-front tab
 * stacked in the same visible pane - don't all re-stat on every window focus;
 * selecting the tab re-enables the query (with `staleTime: 0`) and refetches,
 * which doubles as the surface-activation re-check.
 */
function useChatMissingWorktreeFocusRefresh(args: {
  readonly handle: ChatSessionStoreHandle;
  readonly epicId: string;
  readonly chatId: string;
  readonly surfaceVisible: boolean;
  readonly hasBinding: boolean;
}): void {
  const client = useTabHostClient();
  const bindingQuery = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "worktree.getBinding",
    params: { epicId: args.epicId, ownerId: args.chatId, ownerKind: "chat" },
    options: {
      enabled: args.hasBinding && args.surfaceVisible,
      staleTime: 0,
      refetchOnWindowFocus: true,
    },
  });
  const refreshedMissing = bindingQuery.data?.missingWorktreePaths ?? null;
  const refreshMissingWorktreePaths =
    args.handle.store.getState().refreshMissingWorktreePaths;
  useEffect(() => {
    if (refreshedMissing === null) return;
    refreshMissingWorktreePaths(refreshedMissing);
  }, [refreshedMissing, refreshMissingWorktreePaths]);
}

function useChatWorkspaceAvailability(
  currentEpicId: string,
  worktreeBinding: WorktreeBinding | null,
  snapshotLoaded: boolean,
  missingWorktreePaths: ReadonlyArray<string>,
): WorkspaceComposerAvailability {
  const client = useTabHostClient();
  const epicWorkspaces = useWorktreeListBindingsForEpicForClient({
    client,
    epicId: currentEpicId,
    enabled: client !== null,
  });
  const epicWorkspaceCount =
    epicWorkspaces.data === undefined ? null : epicWorkspaces.data.rows.length;

  return deriveWorktreeBindingWorkspaceAvailability(
    worktreeBinding,
    snapshotLoaded,
    epicWorkspaceCount,
    missingWorktreePaths,
  );
}

function fallbackSettingsSeedForChatComposer(
  epicRunSettings: ChatRunSettings | null,
  globalLastRunSettings: ChatRunSettings | null,
): ChatRunSettings | null {
  return epicRunSettings ?? globalLastRunSettings;
}

function settingsFromEpicRunSettingsEntry(
  entry: ComposerRunSettingsEntry | null,
): ChatRunSettings | null {
  return entry === null ? null : entry.settings;
}

function useInitializeChatComposerSettings(input: {
  readonly snapshotLoaded: boolean;
  readonly currentComposerSettings: ChatRunSettings | null;
  readonly initialSettings: ChatRunSettings;
  readonly setCurrentComposerSettings: (settings: ChatRunSettings) => void;
}): void {
  const {
    snapshotLoaded,
    currentComposerSettings,
    initialSettings,
    setCurrentComposerSettings,
  } = input;
  useEffect(() => {
    if (!snapshotLoaded) return;
    if (currentComposerSettings !== null) return;
    if (!chatRunSettingsModelResolved(initialSettings)) return;
    setCurrentComposerSettings(initialSettings);
  }, [
    currentComposerSettings,
    initialSettings,
    setCurrentComposerSettings,
    snapshotLoaded,
  ]);
}

function chatRunSettingsModelResolved(settings: ChatRunSettings): boolean {
  return settings.model.length > 0;
}

function currentSettingsForChatTile(input: {
  readonly liveSettings: ChatRunSettings | null;
  readonly editingQueueItemSettings: ChatRunSettings | null;
  readonly persistedChatSettings: ChatRunSettings | null;
  readonly epicRunSettings: ChatRunSettings | null;
  readonly globalLastRunSettings: ChatRunSettings | null;
  readonly defaultRunSettings: ChatRunSettings;
}): ChatRunSettings {
  return (
    input.liveSettings ??
    input.editingQueueItemSettings ??
    input.persistedChatSettings ??
    input.epicRunSettings ??
    input.globalLastRunSettings ??
    input.defaultRunSettings
  );
}

function useCachedCollaborators(
  epicId: string,
): SenderDisplayContext["collaborators"] {
  const client = useHostClient();
  const { data } = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "epic.listCollaborators",
    params: { epicId },
    options: { enabled: false },
  });
  return useMemo(() => flattenCollaborators(data?.collaborators ?? []), [data]);
}
