import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SetupCardWindowIdentity } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { useMeasuredElementHeight } from "@/hooks/ui/use-measured-element-height";
import { useChatMessageActions } from "./use-chat-message-actions";
import { useChatQueueActions } from "./use-chat-queue-actions";
import type { ChatForkMode } from "@/components/chat/chat-message";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useTabProvidersList } from "@/hooks/providers/use-tab-providers-list-query";
import { TombstonedProfileProvider } from "@/components/chat/tombstoned-profile-provider";
import type {
  InterviewAnswer,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  BackgroundItem,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
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
  ChatAttachmentScopeContext,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import {
  WorkingVerbContext,
  pickWorkingVerb,
} from "@/components/chat/working-verb";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import { ChatRestoreProvider } from "@/components/chat/chat-restore-context";
import { RevertOnEditDialog } from "@/components/chat/segments/revert-on-edit-dialog";
import { SteerSettingsConflictDialog } from "@/components/chat/segments/steer-settings-conflict-dialog";
import {
  accumulatedChangeRows,
  hostAccumulatedChangeRows,
  accumulatedSummarySetComplete,
  undeliveredHostChangeCount,
} from "@/lib/chat/accumulated-change-rows";
import { TeardownCommitDialog } from "@/components/worktree/teardown-commit-dialog";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import {
  droppedRunDirectoriesFromDraft,
  teardownHolderSetDrifted,
} from "@/lib/worktree/owner-teardown-snapshot";
import {
  takeArmedTeardownSubmit,
  worktreeCommitCaptureIsStale,
  type ArmedTeardownSubmit,
  type WorktreeCommitCapture,
} from "@/lib/worktree/worktree-commit-capture";
import { useOwnerTeardownSnapshot } from "@/hooks/worktree/use-owner-teardown-snapshot";
import {
  readStagedWorktreeIntent,
  stagedWorktreeIntentRevision,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { buildPinnedTodoRenderState } from "@/components/chat/chat-pinned-todos";
import type { ChatMessageActions } from "@/components/chat/chat-message";
import type { NextStepActionHandler } from "@/components/chat/segments/next-steps-action-group";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import {
  useChatById,
  useEpicLiveArtifactTitle,
  useEpicPermissionRole,
  useOpenEpicId,
} from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import {
  mentionRootsFromWorktreeBinding,
  mentionRootsFromWorktreeBindingAndIntent,
  useWorkspaceMentionRoots,
  worktreeBindingIsFolderless,
} from "@/hooks/composer/use-workspace-mention-roots";
import { useChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  isWindowedTranscript,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import type {
  OrdinalRange,
  TranscriptWindow,
} from "@/stores/chats/transcript-window";
import {
  chatTranscriptEventRowId,
  chatTranscriptJumpKey,
  useChatTranscriptJumpStore,
} from "@/stores/chats/chat-transcript-jump-store";
import { useSubagentOpenStore } from "@/stores/chats/subagent-open-store";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
} from "@/stores/chats/rendered-messages";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOwnedByViewer } from "@/hooks/chats/use-owned-by-viewer";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import type { TranscriptRowLocator } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  coldJumpOrdinal,
  hostLocatorForJumpTarget,
  messageIdForBlock,
  messageIdForTranscriptTarget,
  sentMessageAnchorId,
} from "@/components/epic-canvas/renderers/chat-tile-jump-logic";
import { useChatLocateRow } from "@/hooks/chats/use-chat-locate-row";
import { useHostBinding } from "@/lib/host";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import {
  useHostReachability,
  resolvedHostLabel,
} from "@/hooks/agent/use-host-reachability";
import { useBoundedHostLoad } from "@/hooks/host/use-bounded-host-load";
import { TileHostLoadState } from "./tile-host-load-state";
import { useEpicUpdateChatRunSettings } from "@/hooks/epic/use-epic-chat-mutations";
import { useChatCloneOnHostSwitch } from "@/components/epic-canvas/renderers/use-chat-clone-on-host-switch";
import { CloneProfileRecovery } from "@/components/epic-canvas/renderers/clone-profile-recovery";
import { enqueuePersistChatRunSettings } from "@/lib/chats/chat-run-settings-write-queue";
import {
  findManualCompactCommand,
  promoteQueuedMessageToFront,
} from "@/lib/chats/compact-conversation";
import { useSlashCommands } from "@/hooks/composer/use-slash-commands";
import { chatTileActivationQueryPolicy } from "./chat-tile-activation-query-policy";
import {
  ChatDeadTileBanner,
  ChatHostStartingBanner,
  type ChatDeadTileBannerReason,
} from "./dead-tile-banner";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useCloudChatList } from "@/hooks/chats/use-cloud-chat-queries";
import { cloudRowIsViewersOwn } from "@/lib/chats/unified-chat-list";
import { flattenCollaborators } from "@/hooks/epics/use-epic-collaborators-query";
import {
  useGuiHarnessCatalogForClient,
  type GuiHarnessCatalogEntry,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useInitialChatHandoffDriver } from "@/hooks/chats/use-initial-chat-handoff-driver";
import { useChatActions } from "@/hooks/chats/use-chat-actions";
import { useChatSetupFailureRestoreDriver } from "@/hooks/chats/use-chat-setup-failure-restore-driver";
import { useSetupTerminalListRefreshDriver } from "@/hooks/chats/use-setup-terminal-list-refresh-driver";
import { useSetupTerminalTabRegisterDriver } from "@/hooks/chats/use-setup-terminal-tab-register-driver";
import { useCloneSourceOwnerUserId } from "@/hooks/chats/use-clone-source-owner";
import { type InitialChatHandoffScope } from "@/stores/epics/initial-chat-handoff-store";
import { contentBlocksPreview } from "@/lib/chat/content-block-text";
import {
  buildSubmittedChatJSONContent,
  type SlashCommandCatalog,
} from "@/lib/composer/tiptap-json-content";
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
  selectEpicRunSettingsEntry,
  selectGlobalLastRunSettings,
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
  usePaneFocused,
  usePaneVisible,
} from "@/components/epic-tabs/pane-visibility-context";
import { useTabBodySelected } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import {
  localSnapshotsClearedAt,
  useLocalSnapshotClearStore,
} from "@/stores/settings/local-snapshot-clear-store";
import { ChatTileErrorNoticeToasts } from "./chat-tile-error-notice-toasts";
import { ChatTileRestoreResultToasts } from "./chat-tile-restore-result-toasts";
import { HostWorkspaceSelector } from "@/components/home/host-workspace-selector/host-workspace-selector";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { TraycerNextStepOption } from "@/markdown/traycer-next-steps";
import { ChatLowerInteractionSurfaces } from "./chat-tile-lower-surfaces";
import { composerHasBlockingApprovals } from "./chat-approval-visibility";
import {
  chatTileUiReducer,
  createInitialChatTileUiState,
  normalizeInlineEditForSession,
  canModifyChatMessages,
  shouldGenerateChatTitleForSubmittedMessage,
  userMessageSenderForProfile,
  plainTextPromptContent,
  composerTurnStatus,
  resolvedTurnStatus,
  chatTileCanAct,
  findPendingInterview,
  findUnanswerableInterviews,
  forkableAssistantMessageIdAfter,
  latestForkableAssistantMessageId,
  selectContextUsage,
} from "./chat-tile-session-state";
import { toast } from "sonner";
import type { ChatSurfaceNode } from "./chat-tile-types";
import { ChatTileLoading, ChatTileError } from "./chat-tile-runtime-gate";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { chatTileCatalogActivity } from "./chat-tile-surface-activity";

const EMPTY_WORKSPACE_PATH_SET: ReadonlySet<string> = new Set();
const EMPTY_BACKGROUND_STOP_TASK_IDS: ReadonlySet<string> = new Set();
// How long a compact-conversation click stays locked out against a repeat
// click. Not tied to the send settling - just long enough that a double-click
// or double-tap can't fire the compaction twice.
const COMPACT_ACTION_LOCK_MS = 1500;

/**
 * Stable identity for the legacy line's "no whole-log partition".
 *
 * A fresh `[]` per render would change the identity of a `useMemo` dependency
 * every time and re-partition the setup lifecycle on every streamed token.
 */
const EMPTY_SETUP_CARD_WINDOWS: ReadonlyArray<SetupCardWindowIdentity> = [];

/** Per-chat compact-conversation state, keyed by `handle.chatId` - see the comment on `compactConversation`. */
interface CompactChatState {
  locked: boolean;
  lockTimeoutId: number | null;
  cancelPromotion: (() => void) | null;
}

interface ChatTileProps {
  node: EpicNodeRef;
  viewTabId: string;
  tileId: string;
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
  readonly node: ChatSurfaceNode;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
  readonly currentEpicId: string;
  /**
   * Why this surface's composer is locked, when the reason is not a viewer's
   * permission. `null` on every live tile - the ordinary path is untouched.
   */
  readonly readOnlyNotice: string | null;
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
  // Gate the host `chat.subscribe` on this tile having some EVIDENCE that the
  // chat exists (mirrors the terminal tile's `enabled: agent !== null`). The
  // gate exists for exactly one race - a chat created here, subscribed to
  // before the create landed - so the bar is evidence of existence, not
  // evidence of a doc record.
  //
  // The doc record used to be the whole gate, on the premise that "the create
  // seeds the chat into the epic doc". That premise died with ticket 19
  // (creation no longer projects) and ticket 20 (`ChatDocEntrySweep` deletes
  // every entry whose publication it has proven), which together made "no doc
  // record" the ORDINARY steady state of a healthy owned chat. Left as-is,
  // this gate refused `chat.subscribe` for every migrated chat on its own
  // connected host - the second, independent half of ticket 49's
  // permanently-read-only defect (the first is `tab-group-view.tsx`'s
  // substitution arm, which cannot even observe a `CHAT_NOT_VISIBLE`
  // terminate until this gate lets the open through).
  const chatRecord = useChatById(node.id);
  const tabHostId = useTabHostId();
  // A CROSS-HOST live open (a connected peer host's chat, opened from the
  // unified sidebar) may never get a local projection record at all - the
  // chat lives in the owner host's registry, not this device's. The record
  // gate exists only to close the local-first subscribe-first race, and that
  // race is a same-host phenomenon: the chat was just created on the host
  // that was active here. So the gate applies exactly when this tab bound
  // the then-active host. Decided ONCE at mount (a `useState` initializer,
  // never a reactive active-host read - tabs are bound to a host for life
  // and must not change behavior when the active host swaps).
  const hostBinding = useHostBinding();
  // The host whose PROJECTION this tile's record gate reads: the Epic
  // session's (the canvas host), not the app-wide effective one this used to
  // compare against. "Same host" here means "same as the projection", and
  // that projection is the session's - which for the whole of a re-point in
  // flight is not the effective host. The three record-gate readers
  // (`tab-group-view`, the route sync, this) resolve the one identity.
  const projectionHostId = useCanvasHostId();
  const [isCrossHostOpen] = useState(() => {
    // A null host id is ignorance (binding still resolving), not evidence of
    // a cross-host open - exempting on it would reopen the subscribe-first
    // race for every chat mounted during bootstrap. Only a KNOWN, different
    // host earns the exemption.
    //
    // RESOLVED against the directory, not the derived id alone, because that
    // is what the active slot answered before P4.2 deleted it: a host whose
    // row has not arrived was `null` here, and the ignorance arm above is
    // written for exactly that state. Reading the bare id would promote
    // "derived but unresolved" into KNOWN and start exempting chats a beat
    // earlier than this gate was measured for.
    const projectionEntry =
      hostBinding === null || projectionHostId === null
        ? null
        : hostBinding.hostClient.resolveHostById(projectionHostId);
    return projectionEntry !== null && projectionEntry.hostId !== tabHostId;
  });
  // The record-less same-host case (ticket 49): a published cloud row is
  // existence evidence too, and it is the ONLY evidence a swept chat has
  // left locally. Consulted only when the two gates above have already
  // refused, so the ordinary live path costs nothing extra.
  //
  // This cannot reopen the create race it replaces evidence for. A chat is
  // published by its owning host well AFTER `epic.createChat` returns, so a
  // create in flight is cloud-UNKNOWN by construction and stays gated - the
  // suppression for that window remains the canvas's
  // `pendingCreateArtifactIds` (`tab-group-view.tsx`) and the handoff
  // driver's own readiness deadline, neither of which this touches.
  //
  // `useTabHostClient` rather than the app-wide client: this is a tab, and
  // the tab's bound host is the one whose registry would have to hold the
  // chat. For a same-host tab that resolves to the same host id the canvas's
  // `useCloudChatList` already keyed its copy of `epic.listCloudChats` under,
  // so the two share one cache entry and one request.
  const tabHostClientForRecordEvidence = useTabHostClient();
  const wantsCloudRecordEvidence = chatRecord === null && !isCrossHostOpen;
  const cloudChatsForRecordEvidence = useCloudChatList({
    client: tabHostClientForRecordEvidence,
    taskId: epicId,
    enabled: wantsCloudRecordEvidence,
  });
  // The OWNER is half the identity, not a refinement of the id: `chatId` is
  // host-minted and the list deliberately carries every task-visible row
  // including collaborators'. A local chat ref is the viewer's own by
  // construction, so an id-only match could open a collaborator's chat under
  // this tab. Same rule `tab-group-view.tsx`'s arm applies to the same list.
  const isCloudKnown =
    wantsCloudRecordEvidence &&
    (cloudChatsForRecordEvidence.data?.chats.some(
      (chat) => chat.identity.chatId === node.id && cloudRowIsViewersOwn(chat),
    ) ??
      false);
  const handle = useChatSessionHandle(
    node.id,
    tabHostId,
    chatRecord !== null || isCrossHostOpen || isCloudKnown,
  );
  const reachability = useHostReachability(tabHostId);
  // The chat's own bounded load (invariant 6). `handle === null` is this
  // tile's spinner-forever shape and it has THREE causes that look identical
  // from here: the tab's host client is null so every `useHostQuery` disabled
  // itself (audit S3), the subscription is live but nothing has arrived (S4),
  // or the directory has not answered at all (S5's `checking`, which this tile
  // had no arm for). The reader cannot act on the difference, so all three get
  // one sentence naming the host - and an end.
  const chatLoad = useBoundedHostLoad({
    hostId: tabHostId,
    hostLabel: resolvedHostLabel(reachability),
    pending: handle === null,
  });
  // Feeds `TombstonedProfileProvider` below - "ran on <label> (removed)" for
  // a message anchored to a since-tombstoned profile. Shares the same
  // tab-scoped query the reauth gate/rate-limit prompt already read, so this
  // costs no extra host RPC. The provider is handed `tabHostId` alongside it
  // because this list is evidence about a profile only for anchors minted on
  // THIS host - an anchor a fork carried from another machine names a
  // profile id that is host-local there and can never match here.
  const providersList = useTabProvidersList({
    enabled: true,
    subscribed: false,
  });
  // The clone-offer hook runs `useEpicCreateChatForHostClient`, which
  // subscribes to
  // the host runtime. Mount it only when the banner is actually
  // shown so the live render path does not pay the subscription cost
  // (and tests that omit the host runtime provider stay green).
  const deadTileBanner = (() => {
    if (reachability.status === "unreachable") {
      return (
        <ChatDeadTileBannerContainer
          epicId={epicId}
          tabId={viewTabId}
          chatId={node.id}
          sourceHostId={tabHostId}
          hostLabel={reachability.hostLabel}
          // The hook's reason, not a constant. This used to hard-code
          // `host-offline` for every unreachable result, which is how a
          // `plan-restricted` host — running fine, just with no remote route on
          // this account's plan — was reported to its owner as being off.
          reason={
            reachability.unavailability === "plan-restricted"
              ? "host-plan-restricted"
              : "host-offline"
          }
          // This mount's body is a load state or a cached live session -
          // never a published copy the banner could truthfully point at.
          showsPublishedCopy={false}
          testId={`chat-dead-tile-${node.id}`}
        />
      );
    }
    if (reachability.status === "host-starting") {
      // The local host hasn't published yet (boot/ensure/wake). Never offer
      // Clone here - the bound host is most likely this machine, seconds
      // from converging; cloning would fork a healthy thread.
      return (
        <ChatHostStartingBanner
          className={undefined}
          testId={`chat-host-starting-${node.id}`}
        />
      );
    }
    return null;
  })();

  if (handle === null) {
    return (
      <div
        data-testid="chat-tile"
        data-node-id={node.id}
        className="flex h-full min-h-0 flex-col"
      >
        {deadTileBanner}
        {chatLoad.kind === "ready" ? (
          // Unreachable while `pending` is `handle === null` and we are inside
          // that branch, but written as a fallback rather than a cast: the
          // spinner is the strictly safer thing to render if that ever stops
          // being true.
          <ChatTileLoading />
        ) : (
          <TileHostLoadState
            load={chatLoad}
            subject="agent"
            onRetry={null}
            testId={`chat-tile-load-${node.id}`}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-node-id={node.id}>
      {deadTileBanner}
      <TombstonedProfileProvider
        providers={providersList.data?.providers ?? []}
        hostId={tabHostId}
      >
        <ChatTileSessionView
          handle={handle}
          node={node}
          viewTabId={viewTabId}
          tileId={props.tileId}
          isActive={isActive}
          currentEpicId={epicId}
          readOnlyNotice={null}
        />
      </TombstonedProfileProvider>
    </div>
  );
}

interface ChatDeadTileBannerContainerProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly chatId: string;
  readonly sourceHostId: string;
  readonly hostLabel: string;
  readonly reason: ChatDeadTileBannerReason;
  readonly testId: string;
  /**
   * Whether the mounting surface renders a readable copy under this banner.
   * The published tile and the canvas substitution do; this live tile does
   * not (the body below it is a load state or a cached live session). See
   * `ChatDeadTileBannerProps.showsPublishedCopy`.
   */
  readonly showsPublishedCopy: boolean;
  /**
   * The source chat's owner, when the mounting surface already carries it
   * (the published tile's ref does). Bypasses the cloud-list lookup below,
   * which a host with swept registry facts (post-restart) can fail to
   * answer. `""` is treated as absent, not forwarded: the wire field is
   * `z.string().min(1).nullable()`, so an empty owner would turn a clone
   * that should degrade to settings-only into an outright failure.
   */
  readonly sourceOwnerUserId?: string;
}

export function ChatDeadTileBannerContainer(
  props: ChatDeadTileBannerContainerProps,
): ReactNode {
  const chatRecord = useChatById(props.chatId);
  // The EPIC SESSION's client, by intent: the cloud lookup below SHARES the
  // list the sidebar tree already fetched for this epic, and that fetch rides
  // the session's client - so this must too, or it is a cache miss per host
  // for an answer that is the same everywhere. (It used to be the app-wide
  // client for the same sharing reason, back when the sidebar read app-wide;
  // the two moved together.) Not this tile's host either, for the same
  // cache reason.
  const bannerAppHostClient = useEpicSessionHostClient();
  const providedOwnerUserId =
    props.sourceOwnerUserId !== undefined && props.sourceOwnerUserId.length > 0
      ? props.sourceOwnerUserId
      : null;
  // Ticket 37: both banner render sites (this tile's unreachable-host arm and
  // the canvas substitution) resolve the source owner through the one hook, so
  // a chat with no local record still carries its history across the clone.
  // A surface that already knows the owner (the published tile's ref names
  // it) passes it instead, and a `null` chatId keeps the hook's cloud query
  // disabled - no lookup runs for an answer the caller already had.
  const lookedUpOwnerUserId = useCloneSourceOwnerUserId({
    client: bannerAppHostClient,
    epicId: props.epicId,
    chatId: providedOwnerUserId === null ? props.chatId : null,
    sourceOwnerHostId: props.sourceHostId,
  });
  const sourceOwnerUserId = providedOwnerUserId ?? lookedUpOwnerUserId;
  // The two facts the banner's copy and Clone offer vary on (shared-chat
  // support). Ownership: only a POSITIVE mismatch against the signed-in user
  // flips the foreign-owner copy - an unknown owner or identity stays on the
  // own-chat sentences, which were this banner's whole vocabulary before
  // collaborators existed. Role: `epic.createChat` is editor-gated host-side,
  // so a known viewer gets the reason in the banner instead of a Clone button
  // that dies on a bare "You don't have permission" toast; an unresolved role
  // (`null`) keeps the offer - the host gate is the backstop, and withholding
  // the way out of a dead tile needs evidence.
  const permissionRole = useEpicPermissionRole();
  const ownedByViewer = useOwnedByViewer(sourceOwnerUserId);
  const cloneAllowed =
    permissionRole === null || isEditableRole(permissionRole);
  const offer = useChatCloneOnHostSwitch({
    epicId: props.epicId,
    tabId: props.tabId,
    chatId: props.chatId,
    sourceHostId: props.sourceHostId,
    sourceSettings: chatRecord?.settings ?? null,
    // Raw stored title, `""` when this dead tile has no record left to read
    // one from - the host's fork-seed gap-fill names the clone in that case.
    sourceTitle: chatRecord?.title ?? "",
    sourceOwnerUserId,
  });
  return (
    <>
      <ChatDeadTileBanner
        hostLabel={props.hostLabel}
        reason={props.reason}
        ownedByViewer={ownedByViewer}
        cloneAllowed={cloneAllowed}
        showsPublishedCopy={props.showsPublishedCopy}
        onClone={offer.clone}
        cloning={offer.cloning}
        className={undefined}
        testId={props.testId}
      />
      {offer.profileRecovery !== null ? (
        <CloneProfileRecovery
          client={offer.profileRecovery.client}
          resolution={offer.profileRecovery.resolution}
          targetHostLabel={offer.profileRecovery.targetHostLabel}
          onChooseProfile={offer.profileRecovery.chooseProfile}
          onRetry={offer.profileRecovery.retry}
          onCancel={offer.profileRecovery.cancel}
          onOpenProviderSettings={offer.profileRecovery.openProviderSettings}
        />
      ) : null}
    </>
  );
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

/**
 * How long a parked cross-tile transcript jump waits for its target row to
 * stream in before it is dropped. Generous enough to cover a cold tile pulling
 * a large transcript, short enough that a stale request cannot fire minutes
 * later and yank the reader somewhere they no longer expect.
 */
const TRANSCRIPT_JUMP_TTL_MS = 30_000;

/**
 * Which open-store a cross-tile block jump should expand. A block that names a
 * live background item follows that item's card kind; anything else (a settled
 * tool card - the usual shape for a file-write anchor) opens as a tool card.
 */
function transcriptJumpCardKind(
  blockId: string,
  backgroundItems: ReadonlyArray<BackgroundItem>,
): ChatScrollCardKind {
  const item = backgroundItems.find((entry) => entry.blockId === blockId);
  if (item === undefined) return "tool";
  return backgroundItemCardKind(item.kind);
}

export function ChatTileSessionView(props: ChatTileSessionViewProps) {
  const view = useChatTileSessionViewModel(props);
  // Viewport → hydration bridge: `ChatMessages` computes which ordinals the
  // reader is looking at; the session store turns that into range requests.
  // Keyed on the handle so a reconnected store keeps receiving reports.
  const viewHandle = view.handle;
  const onVisibleOrdinalRangeChange = useCallback(
    (range: OrdinalRange | null): void => {
      viewHandle.store.getState().reportVisibleTranscriptRange(range);
    },
    [viewHandle],
  );
  const hostId = useTabHostId();
  // Chat image byte reads are scoped here, once per tile, rather than per
  // rendered image: resolving the routed client is a directory-query
  // subscription, and a transcript can hold a hundred thumbnails. Covers the
  // transcript AND the composer/lower surfaces below.
  const attachmentHostClient = useTabHostClient();
  // The BUILD, not just the id: a host can be upgraded in place under the same
  // `hostId`, and the attachment fetcher remembers its "predates
  // `epic.readChatAttachment`" verdict per build so the upgrade re-probes.
  const attachmentHostEntry = useHostDirectoryEntry(hostId);
  const attachmentHostVersion = attachmentHostEntry?.version ?? null;
  const attachmentScope = useMemo<ChatAttachmentScopeValue>(
    () => ({
      epicId: view.currentEpicId,
      chatId: view.node.id,
      hostId,
      hostVersion: attachmentHostVersion,
      client: attachmentHostClient,
    }),
    [
      attachmentHostClient,
      attachmentHostVersion,
      hostId,
      view.currentEpicId,
      view.node.id,
    ],
  );
  const systemOverlayActive = useAnySystemOverlayActive();
  const tileNavigation = useEpicTileNavigation();
  const [backgroundScrollRequest, setBackgroundScrollRequest] =
    useState<ChatMessageScrollRequest | null>(null);
  const backgroundScrollRequestIdRef = useRef(0);
  // The composer + queue/pinned/agents/background dock now overlays the
  // transcript (decision log #3, #13) instead of pushing it via flex height,
  // so its reply stream can flow visually behind it. Measuring the whole
  // overlay as one unit (rather than composer/queued-surface separately) is
  // a deliberate ticket-3 scope narrowing - see ticket-3 report for the
  // follow-up split. `useMeasuredElementHeight` (review finding: extracted so
  // this measurement -> prop contract is directly testable, ticket 18 rider)
  // owns the ResizeObserver plumbing.
  const {
    setElement: setLowerSurfacesElement,
    element: lowerSurfacesElement,
    height: lowerSurfacesHeight,
  } = useMeasuredElementHeight();
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
        kind: "message",
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
  // Anchor on a message rather than on a card. The transcript's scroll request
  // wants a message id either way; `blockId: null` says "there is no card to
  // expand here", which is the shape a delivered A2A message has.
  const scrollToMessage = useCallback((messageId: string): void => {
    backgroundScrollRequestIdRef.current += 1;
    setBackgroundScrollRequest({
      kind: "message",
      messageId,
      blockId: null,
      requestId: backgroundScrollRequestIdRef.current,
    });
  }, []);
  const scrollToTranscriptEnd = useCallback((): void => {
    backgroundScrollRequestIdRef.current += 1;
    setBackgroundScrollRequest({
      kind: "end",
      requestId: backgroundScrollRequestIdRef.current,
    });
  }, []);
  // Cross-tile transcript jumps (today: the communication-graph timeline).
  // Parked in a store rather than called directly because the jump is issued
  // from another tile, possibly before this one exists - `openTileInEpic`
  // mounts it and the request is waiting here when it renders.
  const transcriptJump = useChatTranscriptJumpStore(
    (s) => s.requestsByChatId[chatTranscriptJumpKey(hostId, props.node.id)],
  );
  const consumeTranscriptJump = useChatTranscriptJumpStore(
    (s) => s.consumeJump,
  );
  // Reached through the handle's store rather than the `view` projection: this
  // is an ACTION, stable for the store's life, so routing it through the
  // reactive selection would put a new identity in the effect's deps on every
  // frame.
  const requestTranscriptOrdinal = useStore(
    viewHandle.store,
    (s) => s.requestTranscriptOrdinal,
  );
  // A jump target this client cannot place on its own, once it is clear it
  // cannot. Failing to match here does not mean "not delivered yet" the way it
  // does elsewhere - it means "not hydrated, and hydration is exactly what the
  // jump is blocked on" - so the host is asked where the row is. The per-kind
  // rule is {@link hostLocatorForJumpTarget}'s.
  const hostLocatorTarget = useMemo<TranscriptRowLocator | null>(() => {
    if (transcriptJump === undefined) return null;
    if (!view.snapshotLoaded) return null;
    return hostLocatorForJumpTarget({
      target: transcriptJump.target,
      transcriptWindow: view.transcriptWindow,
      messages: view.messages,
    });
  }, [
    transcriptJump,
    view.messages,
    view.snapshotLoaded,
    view.transcriptWindow,
  ]);
  const hostLocatedOrdinal = useChatLocateRow({
    client: attachmentHostClient,
    epicId: view.currentEpicId,
    chatId: view.node.id,
    target: hostLocatorTarget,
    // The coordinate space this tile is in. An ordinal numbered in another one
    // is discarded rather than jumped to - see the hook's own doc. `null` is
    // the legacy line, which has no ordinal space at all - and no cold rows
    // either, so `hostLocatorTarget` is never non-null there and the query
    // never runs. The epoch is then only ever part of a disabled query's key.
    epoch: view.transcriptWindow?.epoch ?? 0,
  });
  // HOLD UNTIL THE TARGET RESOLVES, not merely until the snapshot loaded. The
  // chat transcript streams independently of the graph stream, so a warm tile
  // routinely learns about a message from the timeline BEFORE its own stream
  // delivers the row. Installing the scroll request then would burn it: the
  // transcript marks the request handled and only afterwards discovers it has
  // no index entry for that message, and the row arrives to find nothing
  // parked. So the request stays in the store until the row is actually
  // present; `view.messages` changing re-runs this, which is the retry.
  useEffect(() => {
    if (transcriptJump === undefined) return;
    if (!view.snapshotLoaded) return;
    const target = transcriptJump.target;
    if (target.kind === "end") {
      scrollToTranscriptEnd();
      consumeTranscriptJump(hostId, props.node.id, transcriptJump.requestId);
      // Same release as the resolved-target path below, and it returns before
      // reaching it. An `end` jump that REPLACED a parked request is the case:
      // changing `pendingTranscriptJumpId` clears the previous request's TTL
      // timer, and this pass consumes the new one, so the TTL effect returns
      // early and never runs its release either. The ordinal then stays in
      // `requiredHydrationOrdinalsOf` for the session - the planner re-fetches
      // a row nothing is waiting for, and the budget holds that span against
      // eviction.
      requestTranscriptOrdinal(null);
      return;
    }
    const resolveTargetMessageId = (): string | null => {
      if (target.kind === "message") {
        return messageIdForTranscriptTarget(view.messages, target.messageId);
      }
      if (target.kind === "event") {
        const eventRowId = chatTranscriptEventRowId(target.eventId);
        return (
          view.messages.find((message) => message.id === eventRowId)?.id ?? null
        );
      }
      if (target.kind === "sent-message") {
        return sentMessageAnchorId(view.messages, target);
      }
      if (target.kind === "first-message") {
        // Ordinal 0 of the WHOLE transcript, not the first row this client
        // happens to hold. On the windowed line `view.messages` is a bounded
        // slice, so `messages[0]` is the top of the hydrated tail - and "jump
        // to the first message" then navigated confidently to the middle of
        // the chat, which is worse than not moving at all.
        //
        // Resolved through the skeleton, which is whole-chat: its entry at
        // ordinal 0 names the real first row. If that row is not hydrated yet
        // this returns null and the effect re-runs when it is, which is the
        // same retry every other target kind relies on.
        const firstRowId =
          view.transcriptWindow === null
            ? (view.messages[0]?.id ?? null)
            : (view.transcriptWindow.skeleton[0]?.rowId ?? null);
        if (firstRowId === null) return null;
        return (
          view.messages.find((message) => message.id === firstRowId)?.id ?? null
        );
      }
      return messageIdForBlock(view.messages, target.blockId);
    };
    const messageId = resolveTargetMessageId();
    if (messageId === null) {
      // Unresolved, and on the windowed line that is routinely because the
      // target row is COLD rather than because it does not exist yet. Waiting
      // alone deadlocks: the scroll is what moves the viewport, the viewport is
      // what drives hydration, and the scroll is what we are holding back. So
      // name the ordinal and let the planner fetch it; this effect re-runs when
      // the row lands.
      //
      // Only for a target whose ROW ID is derivable client-side - a user
      // message and an event anchor, whose row ids are the message id and
      // `chatTranscriptEventRowId`. A block or a sent-message anchor is
      // identified by walking rendered models, which a cold row has none of,
      // and resolving those needs the host to locate the row.
      requestTranscriptOrdinal(
        coldJumpOrdinal(view.transcriptWindow, target, hostLocatedOrdinal),
      );
      return;
    }
    if (target.kind === "block") {
      scrollToBlock(
        target.blockId,
        transcriptJumpCardKind(
          target.blockId,
          view.lower.backgroundItems ?? [],
        ),
      );
    } else {
      // Both a delivered-message anchor and a resolved sent-message anchor
      // land the same way: scroll to the owning row, no card to expand.
      scrollToMessage(messageId);
    }
    consumeTranscriptJump(hostId, props.node.id, transcriptJump.requestId);
    // The jump is done, so the ordinal it was holding open is released. Doing
    // this AFTER the consume rather than beside the resolve keeps the request
    // alive across the beat between the two.
    requestTranscriptOrdinal(null);
  }, [
    consumeTranscriptJump,
    hostId,
    // The host's answer arrives asynchronously, so it is the retry signal for
    // the two target kinds that need it - exactly as `view.messages` is for
    // every other kind.
    hostLocatedOrdinal,
    props.node.id,
    requestTranscriptOrdinal,
    scrollToBlock,
    scrollToMessage,
    scrollToTranscriptEnd,
    transcriptJump,
    view.lower.backgroundItems,
    view.messages,
    view.snapshotLoaded,
    view.transcriptWindow,
  ]);
  // ...but a target that never arrives must not wait forever. One timer per
  // request id (transcript churn does not restart it): if the row has not shown
  // up by then the request is dropped QUIETLY. A jump that cannot land is not
  // an error worth interrupting the user over - the tile is open on the right
  // agent either way, which is the degrade this feature already accepts for
  // anchor-less rows.
  const pendingTranscriptJumpId = transcriptJump?.requestId ?? null;
  useEffect(() => {
    if (pendingTranscriptJumpId === null) return;
    const chatId = props.node.id;
    const timer = setTimeout(() => {
      consumeTranscriptJump(hostId, chatId, pendingTranscriptJumpId);
      // The ordinal goes with it, and this is the ONLY place that can release
      // it on this path. The effect above releases it after consuming - but it
      // opens with `if (transcriptJump === undefined) return`, and consuming is
      // exactly what makes that true, so the release there is unreachable once
      // the TTL has fired. Left set, the ordinal stays in
      // `requiredHydrationOrdinalsOf`: the planner re-requests a row nobody is
      // waiting for on every pass, and the budget protects its span from
      // eviction for the life of the session.
      //
      // Safe without an id check of its own. This timer is keyed on
      // `pendingTranscriptJumpId`, so a newer jump replaces the effect and
      // clears it before it can fire - the request-id guard is the dependency
      // array, and `consumeTranscriptJump` carries the same id anyway.
      requestTranscriptOrdinal(null);
    }, TRANSCRIPT_JUMP_TTL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [
    consumeTranscriptJump,
    hostId,
    pendingTranscriptJumpId,
    props.node.id,
    requestTranscriptOrdinal,
  ]);
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
          beforeHash: request.beforeHash,
          afterHash: request.afterHash,
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
    <ChatAttachmentScopeContext.Provider value={attachmentScope}>
      <ChatDiffTargetContext.Provider value={diffOpener}>
        <ChatScrollToBlockContext.Provider value={scrollToBlock}>
          <div
            data-testid="chat-tile"
            data-node-id={view.node.id}
            data-chat-keyboard-scroll-scope=""
            data-active={props.isActive ? "true" : "false"}
            className="flex h-full min-h-0 flex-col"
          >
            {/* A flex CONTAINER (not just an item): ChatSessionMessagesSurface's
             * transcript root relies on `flex-1` from ITS immediate parent to
             * get a definite height (h-full on LegendList needs a real
             * containing block all the way up). The overlay dock below is
             * absolutely positioned, so it does not participate in this flex
             * layout regardless. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
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
                activeTurnId={view.activeTurnId}
                transcriptWindow={view.transcriptWindow}
                onVisibleOrdinalRangeChange={onVisibleOrdinalRangeChange}
                baselineEpoch={view.transcriptBaselineEpoch}
                hydrationSequence={view.transcriptHydrationSequence}
                coldRewrittenMessageIds={view.coldRewrittenMessageIds}
                backgroundItems={view.lower.backgroundItems}
                scrollRequest={backgroundScrollRequest}
                surfaceVisible={view.surfaceVisible}
                systemOverlayActive={systemOverlayActive}
                getMessageActions={view.getMessageActions}
                nextStepActions={view.nextStepActions}
                planActions={view.planActions}
                composerOverlayHeight={
                  lowerSurfacesElement === null ? 0 : lowerSurfacesHeight
                }
              />
              {/*
               * SurfaceActivityProvider narrows catalog/provider query subscriptions
               * to the one focused pane+tab. A visible split partner keeps rendering
               * its transcript and scroll state, but releases catalog/provider query
               * observers and cannot own palette/composer-global work.
               *
               * Absolutely overlays the transcript (decision log #3) instead of
               * pushing its height via flex, so streamed replies flow visually
               * behind it; `lowerSurfacesHeight` (measured here) feeds the
               * transcript's bottom content inset. The full-width positioning
               * layer must remain both pointer- and paint-transparent so it
               * cannot cover the transcript scrollbar or its edge lanes.
               * Centered lower surfaces opt back into pointer handling and own
               * their opaque backplates (including the bottom seam seal), so
               * transcript content cannot show through the actual chrome.
               */}
              {view.snapshotLoaded ? (
                <div
                  ref={setLowerSurfacesElement}
                  className="pointer-events-none absolute inset-x-0 bottom-0 z-10"
                  data-chat-lower-surfaces-overlay=""
                >
                  <div className="pointer-events-none">
                    <SurfaceActivityProvider active={view.surfaceFocused}>
                      <ChatLowerInteractionSurfaces
                        epicId={view.currentEpicId}
                        viewTabId={view.viewTabId}
                        chatId={view.node.id}
                        hostId={hostId}
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
                        backgroundStopAllPending={
                          view.lower.backgroundStopAllPending
                        }
                        backgroundSessionStopPending={
                          view.lower.backgroundSessionStopPending
                        }
                        onBackgroundItemClick={scrollToBackgroundItem}
                      />
                    </SurfaceActivityProvider>
                  </div>
                </div>
              ) : null}
            </div>
            <ChatTileErrorNoticeToasts handle={view.handle} />
            <ChatTileRestoreResultToasts handle={view.handle} />
            <RevertOnEditDialog
              open={view.revertOnEdit.open}
              onOpenChange={view.revertOnEdit.onOpenChange}
              onRevert={view.revertOnEdit.onRevert}
              onDontRevert={view.revertOnEdit.onDontRevert}
              artifactCount={view.revertOnEdit.artifactCount}
              queuedCount={view.revertOnEdit.queuedCount}
            />
            <SteerSettingsConflictDialog
              open={view.steerRestart.open}
              onOpenChange={view.steerRestart.onOpenChange}
              onRestart={view.steerRestart.onRestart}
              changed={view.steerRestart.changed}
            />
            <TeardownCommitDialog
              open={view.teardownCommit.open}
              choice={view.teardownCommit.choice}
              holders={view.teardownCommit.holders}
              immediateDisabled={view.teardownCommit.immediateDisabled}
              refusalReason={view.teardownCommit.refusalReason}
              onImmediate={view.teardownCommit.onImmediate}
              onDefer={view.teardownCommit.onDismiss}
              onDismiss={view.teardownCommit.onDismiss}
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
    </ChatAttachmentScopeContext.Provider>
  );
}

// Aggregates the full chat-tile view model (session handle, ui reducer, derived
// run/permission/handoff state). The branch count reflects the number of
// independent UI concerns surfaced for one tile, not reducible nesting.
// eslint-disable-next-line complexity
function teardownSendRefusalReason(
  canAct: boolean,
  signedIn: boolean,
): string | undefined {
  if (!canAct) return "You don't have permission to send.";
  if (!signedIn) return "Sign in to send this message.";
  return undefined;
}

// eslint-disable-next-line complexity
function useChatTileSessionViewModel(props: ChatTileSessionViewProps) {
  const { handle, node, viewTabId, tileId, isActive, currentEpicId } = props;
  const viewModelHostId = useTabHostId();
  const projectedChatTitle = useEpicLiveArtifactTitle(node.id);
  // Surface visibility for the stream-flush coordinator's tiered flush rate:
  // on screen = the pane is shown AND this tab is the pane's front tab. Pane
  // focus (`isActive`'s `globallyActive` half) is deliberately excluded - an
  // unfocused split pane is still visible. The same chat rendered by several
  // surfaces rolls up to visible-if-any inside the handle.
  const paneVisible = usePaneVisible();
  const paneFocused = usePaneFocused();
  const tabSelected = useTabBodySelected();
  const surfaceVisible = paneVisible && tabSelected;
  const surfaceFocused = chatTileCatalogActivity(
    paneFocused,
    tabSelected,
    isActive,
  );
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
  const defaultRunSettings = useMemo(
    () =>
      buildChatRunSettings({
        selection: defaultSelection,
        permission: defaultPermission,
        reasoning: defaultReasoning,
        serviceTier: defaultServiceTier,
      }),
    [defaultPermission, defaultReasoning, defaultServiceTier, defaultSelection],
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
  // Label-only, cache-only projection: this tile's own composer (which fetches
  // the TAB host's catalog) owns the fetch; this reads that host-keyed cache
  // (never fetches) so ANY visible transcript — including a restored
  // terminal-focused split with an inactive chat and no live catalog publisher
  // — renders friendly model/reasoning labels immediately, and a host/user
  // switch re-keys the queries and swaps labels. Detaches when hidden.
  //
  // ONE slot, the tab host's - never layered over the default host's. This
  // transcript describes turns that ran on the TAB host, so a slug that host
  // does not advertise must degrade to the raw slug rather than borrow a label
  // (or a reasoning-effort label, which is version-specific) from a host that
  // never served the turn. On a default-host tab this is the slot the
  // app-load prefetcher already filled, so nothing changes there; on a
  // remote-host tab the labels appear as that host's per-harness slots warm —
  // this tile's own composer warms its selected harness on mount, and its
  // picker warms whatever the user browses (the catalog fan-out itself is
  // `"cached-only"` everywhere but the app-load fill).
  const tabHostCatalogClient = useTabHostClient();
  const tabModelCatalog = useGuiHarnessCatalogForClient(
    tabHostCatalogClient,
    null,
    { enabled: false, subscribed: surfaceVisible, modelsFetch: "cached-only" },
  );
  const displayCatalog = tabModelCatalog.harnesses;
  const modelLabels = useMemo<ReadonlyMap<string, string>>(
    () =>
      new Map(
        displayCatalog.flatMap((harness) =>
          harness.models.map((model) => [
            agentModelKey(harness.id, model.slug),
            model.label,
          ]),
        ),
      ),
    [displayCatalog],
  );
  const modelReasoningLabels = useMemo(
    () => buildModelReasoningLabels(displayCatalog),
    [displayCatalog],
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
      transcriptBaselineEpoch: s.transcriptBaselineEpoch,
      transcriptHydrationSequence: s.transcriptHydrationSequence,
      coldRewrittenMessageIds: s.coldRewrittenMessageIds,
      chat: s.chat,
      access: s.access,
      messages: s.messages,
      events: s.events,
      // Written in the same `set` as the two arrays above, so subscribing costs
      // no extra render and no frame can render rows against the previous
      // hydration's context.
      transcriptRowContext: s.transcriptRowContext,
      // Both already change identity on every windowed frame (they are rebuilt
      // from the window), so subscribing to the window itself costs no extra
      // render. The revert-scope resolution needs it to know whether the two
      // arrays are the whole transcript or a slice of one.
      transcriptWindow: s.transcriptWindow,
      transcriptDerived: s.transcriptDerived,
      queue: s.queue,
      runStatus: s.runStatus,
      activeTurn: s.activeTurn,
      steerProtocolSupported: s.steerProtocolSupported,
      interviewDeliveryRetryProtocolSupported:
        s.interviewDeliveryRetryProtocolSupported,
      turnInProgress: s.turnInProgress,
      pendingApprovals: s.pendingApprovals,
      pendingFileEditApprovals: s.pendingFileEditApprovals,
      pendingInterviews: s.pendingInterviews,
      accumulatedFileChanges: s.accumulatedFileChanges,
      accumulatedFileChangeSummaries: s.accumulatedFileChangeSummaries,
      accumulatedSummaryGenerationSeated: s.accumulatedSummaryGenerationSeated,
      accumulatedFileChangeCount: s.accumulatedFileChangeCount,
      backgroundItems: s.backgroundItems,
      pendingBackgroundStops: s.pendingBackgroundStops,
      pendingBackgroundStopAll: s.pendingBackgroundStopAll,
      pendingBackgroundSessionStop: s.pendingBackgroundSessionStop,
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
        hostId: viewModelHostId,
        epicId: currentEpicId,
        ownerKind: "chat",
        ownerId: node.id,
      }),
    [currentEpicId, node.id, viewModelHostId],
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
  // Composer-scoped roots: the staged worktree intent layers over the binding
  // (`stagedEntry ?? bindingEntry`), matching what the send path will
  // materialize. Next-message surfaces - the composer's mention search and
  // slash-command discovery, and the inline-edit composer whose resend also
  // carries the staged intent - read these, so a staged replacement stops
  // discovery from probing the superseded (possibly deleted) worktree path.
  // History-scoped link resolution below intentionally stays on the committed
  // binding: existing messages ran in the old workspace.
  const composerMentionRoots = useMemo(
    () =>
      mentionRootsFromWorktreeBindingAndIntent(
        state.worktreeBinding,
        stagedChatWorktreeIntent ?? null,
      ),
    [state.worktreeBinding, stagedChatWorktreeIntent],
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
    activeHostId,
  );
  // The exact roots the active composer resolves to for slash-command
  // discovery (`ChatComposerImpl` derives the same value internally from
  // `composerMentionRoots` + this same fallback flag). The context-usage
  // chip's own catalog lookup shares this rather than the raw
  // `composerMentionRoots`, so it lands on the SAME `agent.gui.listCommands`
  // cache entry the composer already warmed instead of opening a second one
  // with a different (and, on a folder-fallback chat, narrower) working
  // directory set.
  const resolvedComposerMentionRoots = useWorkspaceMentionRoots(
    composerMentionRoots,
    !isFolderlessWorkspace,
    activeHostId,
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
  const activationQueries = chatTileActivationQueryPolicy({
    readOnlyNotice: props.readOnlyNotice,
    surfaceVisible,
    surfaceFocused,
    tileActive: isActive,
    hasWorktreeBinding:
      state.worktreeBinding !== null &&
      state.worktreeBinding.entries.length > 0,
  });
  // Pair the missing-folder send-disable with an on-focus / pane-activation
  // re-check so restoring a deleted folder clears the disable without a send or
  // reload. A locked published copy has no send gate to recover, so its retained
  // surface never enables this activation query.
  useChatMissingWorktreeFocusRefresh({
    handle,
    epicId: currentEpicId,
    chatId: node.id,
    enabled: activationQueries.refreshMissingWorktreePaths,
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
      contentBlocksPreview,
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
      // Published in the same `set` as `messages`, so the rows and what they
      // render WITH can never be a frame apart - see `row-context.ts`.
      rowContext: state.transcriptRowContext,
      // Chat-level rather than per-row, and that is forced: a setup card's row
      // id contains the window index, so a client that renumbered cannot look
      // its own correction up by row id. See `adoptWholeLogIdentity`.
      setupCardWindows:
        state.transcriptDerived?.setupCardWindows ?? EMPTY_SETUP_CARD_WINDOWS,
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
  // Only a prompt item can be loaded into the composer for editing, so narrow
  // here rather than at each consumer: this feeds the composer's settings seed
  // and its remount key, neither of which a content-free managed-command item
  // could supply.
  const editingQueueItem =
    state.queue.items.find(
      (item): item is ChatQueuedPromptItem =>
        item.kind === "prompt" &&
        item.queueItemId === uiState.editingQueueItemId,
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
  const windowedTranscript = isWindowedTranscript(state);
  const accumulatedHostRows = useMemo(
    () =>
      hostAccumulatedChangeRows({
        windowed: windowedTranscript,
        changes: state.accumulatedFileChanges,
        summaries: state.accumulatedFileChangeSummaries,
      }),
    [
      state.accumulatedFileChangeSummaries,
      state.accumulatedFileChanges,
      windowedTranscript,
    ],
  );
  const accumulatedFileChanges = useMemo(
    () =>
      accumulatedChangeRows(
        renderedMessages,
        accumulatedHostRows,
        activeTurnId,
      ),
    [accumulatedHostRows, activeTurnId, renderedMessages],
  );
  const undeliveredChangeCount = undeliveredHostChangeCount({
    windowed: windowedTranscript,
    hostChangeCount: state.accumulatedFileChangeCount,
    deliveredSummaryCount: state.accumulatedFileChangeSummaries.length,
  });
  // Carried BESIDE the count rather than derived from it downstream, because
  // the two answer different questions and differ in exactly the case that
  // matters. `undeliveredChangeCount` clamps at zero, so an OVERSHOOT - a
  // revert lowering the host's count while the client still holds the previous
  // summary array - reports `0`, which every gate reads as "complete".
  const accumulatedSetComplete = accumulatedSummarySetComplete({
    windowed: windowedTranscript,
    hostChangeCount: state.accumulatedFileChangeCount,
    deliveredSummaryCount: state.accumulatedFileChangeSummaries.length,
    generationSeated: state.accumulatedSummaryGenerationSeated,
  });
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
      undeliveredChangeCount,
      accumulatedSetComplete,
      revertFileChanges: chatActions.revertFileChanges,
    }),
    [
      accumulatedFileChanges,
      undeliveredChangeCount,
      accumulatedSetComplete,
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
  // The tile's own send paths - next steps, compact, inline edit - never touch
  // the composer, so they cannot read the catalog off its picker store. Subscribe
  // to the same query under the SAME `surfaceFocused` predicate the composer uses
  // (`chatComposerFocused` → `chatTileCatalogActivity`). Locked published copies
  // cannot invoke those actions and stay detached. For live surfaces, identical
  // gating means an off-screen tile adds no `agent.gui.listCommands` subscription,
  // and when both are on, TanStack Query dedupes the subscribers into one fetch.
  const tabHostClient = useTabHostClient();
  const {
    data: slashCommands,
    isLoading: slashCommandsLoading,
    error: slashCommandsError,
  } = useSlashCommands("", {
    hostClient: tabHostClient,
    harnessId: currentComposerSettings.harnessId,
    // `resolvedComposerMentionRoots`, not the raw roots, for the same reason the
    // context-usage chip above uses it: on a folder-fallback chat the two differ,
    // and the raw set opens a SECOND, narrower cache entry - losing the dedupe
    // and resolving against a catalog the composer never saw.
    workingDirectories: resolvedComposerMentionRoots,
    enabled: activationQueries.discoverActionSlashCommands,
  });
  // Null until loaded, which makes a `$` prompt stay plain text rather than
  // chip against a catalog we have not seen yet.
  // `error` is part of the gate, not a detail. A failed `listCommands` leaves
  // TanStack at `isLoading === false` with `data === []`, which would otherwise
  // read as a legitimately EMPTY catalog - "loaded, this workspace has no
  // commands" - and chip nothing while looking resolved. An unanswered query is
  // unresolved, not empty. The `$` then stays prose, which the host still
  // resolves lexically; the cost is the pill, never the skill.
  const slashCatalog = useMemo<SlashCommandCatalog | null>(
    () =>
      activationQueries.discoverActionSlashCommands &&
      !slashCommandsLoading &&
      slashCommandsError === null
        ? new Map(
            slashCommands.map((command) => [
              command.name.toLowerCase(),
              command,
            ]),
          )
        : null,
    [
      activationQueries.discoverActionSlashCommands,
      slashCommands,
      slashCommandsLoading,
      slashCommandsError,
    ],
  );
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
  // On the legacy line the rendered rows are the full history, so the pinned
  // snapshot derives from the same walk that strips the inline segments. On
  // the windowed line the rows are the HYDRATED SUBSET and the fold's answer
  // comes from the host's whole-transcript copy instead - a todo created
  // outside the hydrated spans would otherwise vanish from the dock. The
  // discriminator is `transcriptDerived` itself (null exactly on the legacy
  // line), the same rule `isWindowedTranscript` names.
  const pinnedTodoRenderState = useMemo(
    () =>
      buildPinnedTodoRenderState(
        displayedMessages,
        state.transcriptDerived === null
          ? { kind: "derive" }
          : {
              kind: "host",
              todo: state.transcriptDerived.pinnedTodo,
              taskItems: state.transcriptDerived.pinnedTaskTodoItems,
              activeTurnId,
            },
      ),
    [displayedMessages, state.transcriptDerived, activeTurnId],
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
  // Block IDs whose answer/skip action is still in flight or accepted-but-
  // unresolved. Recomputes only when actions change (not per streaming token),
  // and yields a stable `false` whenever no interview is pending, so the
  // composer memo below never churns during normal streaming.
  const interviewActionBlockIds = useMemo(
    () =>
      new Set(
        [
          ...Object.values(state.pendingActions),
          ...Object.values(state.acceptedActions),
        ]
          .map((action) => action.interviewBlockId)
          .filter((blockId): blockId is string => blockId !== null),
      ),
    [state.pendingActions, state.acceptedActions],
  );
  const interviewBusy =
    pendingInterview !== null &&
    interviewActionBlockIds.has(pendingInterview.blockId);
  // Host-pending blocks this transcript renders no card for. Yields a stable
  // empty array whenever nothing is stuck, so the composer memo chain below
  // does not churn per streaming token.
  //
  // On the windowed line the rendered scan is a scan of a SUBSET, so the host's
  // judgement decides which of its misses are real - see the function's own
  // doc. `null` is the legacy line, where absence in the transcript is proof.
  const unanswerableInterviews = useMemo(
    () =>
      findUnanswerableInterviews(
        renderedMessages,
        state.pendingInterviews,
        state.transcriptDerived === null
          ? null
          : state.transcriptDerived.interviewAnswerability,
      ),
    [renderedMessages, state.pendingInterviews, state.transcriptDerived],
  );
  const unanswerableInterviewsBusy = unanswerableInterviews.some((interview) =>
    interviewActionBlockIds.has(interview.blockId),
  );
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
  const handleInterviewSkip = useCallback(
    (
      blockId: string,
      reason: string,
      draftAnswers: ReadonlyArray<InterviewAnswer> | undefined,
    ) => {
      return chatActions.interviewSkip(blockId, reason, draftAnswers);
    },
    [chatActions],
  );
  const { messageActionsFor, forkAtAssistantMessage, revertOnEdit } =
    useChatMessageActions({
      dispatchUi,
      activeInlineEdit,
      canModifyMessages,
      canAct,
      interviewDeliveryRetryProtocolSupported:
        state.interviewDeliveryRetryProtocolSupported,
      currentComposerSettings,
      editSettings,
      slashCatalog,
      mentionRoots: composerMentionRoots,
      fallbackToGlobalMentionRoots: !isFolderlessWorkspace,
      currentEpicId,
      node,
      chatTitle: projectedChatTitle ?? state.chat?.title ?? null,
      chatParentId: state.chat?.parentId ?? null,
      messages: state.messages,
      events: state.events,
      // `transcriptDerived !== null` is the line discriminator: on the legacy
      // line the window is an inert empty value and `messages`/`events` are
      // already whole, so handing it over would make the revert scan think it
      // was looking at an empty transcript and answer "unknown" forever.
      transcriptWindow: isWindowedTranscript(state)
        ? state.transcriptWindow
        : null,
      profile,
      chatActions,
      pendingActions: state.pendingActions,
      acceptedActions: state.acceptedActions,
      confirmingDeleteMessageId: uiState.confirmingDeleteMessageId,
      setForkTarget,
      worktreeBinding: state.worktreeBinding,
      revertOnEditOpen: uiState.revertOnEditOpen,
      queuedCount: state.queue.items.length,
    });

  // A primitive on purpose: `renderedMessages` takes a fresh identity every
  // stream flush, so a callback closing over it would churn the memoized
  // composer selector below once per flush. The latest completed boundary ID
  // is stable across flushes (a streaming row is never forkable), so the
  // gesture handler hanging off this stays quiet while a turn streams.
  //
  // On the windowed line the scan cannot run here - `renderedMessages` is the
  // hydrated subset, and the latest completed boundary is routinely outside
  // it (scrolled cold, or evicted). The host derives it from the whole
  // transcript and ships it on every snapshot; `null` from it is the real
  // "no boundary yet", never "not hydrated".
  //
  // But "on every snapshot" is the whole problem, because the GATE in front of
  // the gesture below is cleared by a live `turnStateChanged` frame. A turn
  // completes, the gate opens immediately, and the derived boundary still names
  // the previous turn until a snapshot lands - so the fork the user asks for
  // omits the turn they just watched finish, silently and plausibly. Two
  // clocks. `forkableAssistantMessageIdAfter` is the second hand: it looks only
  // PAST the host's answer, in the live tail where a just-completed turn always
  // is, so it can move the boundary forward and never backward.
  const latestForkBoundaryId = useMemo(() => {
    if (state.transcriptDerived === null) {
      return latestForkableAssistantMessageId(renderedMessages);
    }
    const derived = state.transcriptDerived.latestForkableAssistantMessageId;
    return (
      forkableAssistantMessageIdAfter(renderedMessages, derived) ?? derived
    );
  }, [state.transcriptDerived, renderedMessages]);
  // The composer host picker's "switch host" gesture. Chats are host-bound for
  // life (clone-not-migrate), so switching means FORKING onto the picked
  // machine — through the same dialog the per-message fork buttons open,
  // anchored at the chat's latest completed turn and preselected on the picked
  // host. A chat mid-turn has no boundary that includes the turn the user is
  // watching, and one that has never replied has no boundary at all; both say
  // so instead of opening a dialog pointed at something else.
  const forkChatOnHost = useCallback(
    (targetHostId: string): void => {
      if (composerActiveTurnStatus !== null) {
        toast(
          "This agent is still working — it can be forked to another host once the turn ends.",
        );
        return;
      }
      if (latestForkBoundaryId === null) {
        toast(
          "This agent hasn't replied yet — it can be forked to another host after its first reply.",
        );
        return;
      }
      forkAtAssistantMessage(latestForkBoundaryId, "plain", null, targetHostId);
    },
    [composerActiveTurnStatus, forkAtAssistantMessage, latestForkBoundaryId],
  );

  const snapshotTeardownHolders = useOwnerTeardownSnapshot({
    epicId: currentEpicId,
    hostId: activeHostId,
    ownerKind: "chat",
    ownerId: node.id,
    ownerLabel: node.name,
    hasActiveTurn: composerActiveTurnStatus !== null,
    ptyLive: false,
  });
  const [teardownDialog, setTeardownDialog] = useState<{
    readonly holders: readonly WorktreeBusyHolder[];
  } | null>(null);
  const pendingSubmitRef =
    useRef<ArmedTeardownSubmit<ChatComposerSubmitInput> | null>(null);
  const [teardownOwnerId, setTeardownOwnerId] = useState(node.id);
  if (node.id !== teardownOwnerId) {
    setTeardownOwnerId(node.id);
    setTeardownDialog(null);
  }
  useEffect(() => {
    pendingSubmitRef.current = null;
  }, [node.id]);

  const dispatchUserSend = useCallback(
    (input: ChatComposerSubmitInput): boolean => {
      if (!canAct) return false;
      if (profile === null) return false;
      const sender: UserMessageSender = {
        type: "user",
        userId: profile.userId,
      };
      const expectedTitle = state.chat?.title ?? node.name;
      // Read whole from the store rather than from the tile's `useShallow`
      // selection. The transcript window changes on every windowed frame, so
      // subscribing the tile to it would widen a hot render path for a value
      // only this handler reads - and reading it at SUBMIT time is what the
      // question is about anyway.
      const titleState = handle.store.getState();
      const shouldMarkTitlePending = shouldGenerateChatTitleForSubmittedMessage(
        {
          chat: titleState.chat,
          messages: titleState.messages,
          pendingUserMessages: titleState.pendingUserMessages,
          transcriptWindow: titleState.transcriptWindow,
          transcriptDerived: titleState.transcriptDerived,
          content: input.content,
        },
      );
      const sent = chatActions.sendMessage({
        content: input.content,
        sender,
        settings: input.settings,
        attachments: input.attachments,
        deliveryPolicy: input.deliveryPolicy,
        restore: input.restore,
      });
      if (sent === null) return false;
      if (shouldMarkTitlePending) {
        useEpicCanvasStore
          .getState()
          .markChatTitlePending(node.id, expectedTitle);
      }
      return true;
    },
    [
      canAct,
      chatActions,
      handle.store,
      node.id,
      node.name,
      profile,
      state.chat,
    ],
  );

  const submitMessage = useCallback(
    (input: ChatComposerSubmitInput): boolean => {
      if (!canAct) return false;
      if (profile === null) return false;
      if (activeEditingQueueItemId !== null) {
        const actionId = chatActions.queueEdit(
          activeEditingQueueItemId,
          input.content,
        );
        if (actionId === null) return false;
        // Cmd+Enter in edit mode = save-and-steer (decision 14): the steer
        // carries the settings and the host picks safe-point vs interrupt-restart
        // (any drift was already confirmed by the composer's steer dialog).
        // Plain Enter just saves the edit with its restamped settings.
        if (input.deliveryPolicy === "after_safe_point") {
          if (
            chatActions.queueSteerNow(
              activeEditingQueueItemId,
              input.settings,
            ) === null
          ) {
            return false;
          }
        } else if (
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
      const stagedKey: WorktreeStagingKey = {
        surface: "owner",
        hostId: activeHostId,
        epicId: currentEpicId,
        ownerKind: "chat",
        ownerId: node.id,
      };
      const snapshot = snapshotTeardownHolders(
        droppedRunDirectoriesFromDraft({
          binding: state.worktreeBinding,
          draft: readStagedWorktreeIntent(stagedKey),
          removedWorkspacePaths: [],
        }),
      );
      const capture: WorktreeCommitCapture = {
        draft: readStagedWorktreeIntent(stagedKey),
        revision: stagedWorktreeIntentRevision(stagedKey),
        binding: state.worktreeBinding,
        removedWorkspacePaths: [],
        stopTargets: snapshot.stopTargets,
      };
      if (snapshot.holders.length > 0) {
        pendingSubmitRef.current = {
          input,
          capture,
          ownerId: node.id,
        };
        setTeardownDialog({ holders: snapshot.holders });
        return false;
      }
      return dispatchUserSend(input);
    },
    [
      activeEditingQueueItemId,
      activeHostId,
      canAct,
      chatActions,
      currentEpicId,
      dispatchUi,
      dispatchUserSend,
      node.id,
      profile,
      snapshotTeardownHolders,
      state.worktreeBinding,
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
        slashCatalog,
      );
      return (
        chatActions.sendMessage({
          content,
          sender,
          settings: nextStepSettings,
          attachments: [],
          deliveryPolicy: "auto",
          restore: { content, browserAnnotations: [] },
        }) !== null
      );
    },
    [canSendNextStep, chatActions, nextStepSettings, profile, slashCatalog],
  );
  // Runs the harness's own compaction from the context-usage chip. Never
  // interrupts: with a turn running (or work already queued) the compact
  // command is queued and then promoted to the front so it runs next, and
  // only an otherwise-idle chat compacts outright - queueing there would just
  // park a one-item queue the user has to release by hand. `runNow` has no
  // effect on the host - `deliveryPolicy` only ever branches on
  // `after_safe_point` - it purely decides, client-side, whether the
  // promotion watcher below needs to be armed at all.
  //
  // `ChatTile` is rendered without a `key` on `node.id` (`tile-render.tsx`,
  // `tab-group-view.tsx`), so switching this slot to a different chat
  // repoints `handle` in place rather than remounting. State is keyed by
  // `handle.chatId` rather than held in one shared ref, so compacting chat B
  // can never clear chat A's click-lock early or cancel A's pending
  // promotion - each chat's send against `handle.store` (a durable,
  // registry-owned store that outlives this tile's display of it,
  // `useChatSessionHandle`) settles on its own regardless of what this slot
  // repoints to afterward.
  const compactStateByChatIdRef = useRef(new Map<string, CompactChatState>());
  useEffect(
    () => () => {
      for (const state of compactStateByChatIdRef.current.values()) {
        if (state.lockTimeoutId !== null) {
          window.clearTimeout(state.lockTimeoutId);
        }
        state.cancelPromotion?.();
      }
    },
    [],
  );
  const compactConversation = useCallback(
    (commandName: string): void => {
      if (!canSendNextStep) return;
      const states = compactStateByChatIdRef.current;
      const existing = states.get(handle.chatId);
      if (existing?.locked === true) return;
      const sender = userMessageSenderForProfile(profile);
      if (sender === null) return;
      const content = buildSubmittedChatJSONContent(
        plainTextPromptContent(`/${commandName}`),
        slashCatalog,
      );
      // A cheap re-entrancy guard against a double-click firing two real
      // compactions: the optimistic-queue dedupe only suppresses the second
      // row's on-screen echo, not the frame that already went to the host.
      const lockTimeoutId = window.setTimeout(() => {
        const current = states.get(handle.chatId);
        if (current !== undefined) current.locked = false;
      }, COMPACT_ACTION_LOCK_MS);
      const state: CompactChatState = {
        locked: true,
        lockTimeoutId,
        cancelPromotion: existing?.cancelPromotion ?? null,
      };
      states.set(handle.chatId, state);
      const { activeTurn, queue } = handle.store.getState();
      const runNow = activeTurn === null && queue.items.length === 0;
      const sent = chatActions.sendMessage({
        content,
        sender,
        settings: nextStepSettings,
        attachments: [],
        deliveryPolicy: runNow ? "auto" : "after_turn",
        restore: { content, browserAnnotations: [] },
      });
      if (sent === null || runNow) return;
      state.cancelPromotion?.();
      state.cancelPromotion = promoteQueuedMessageToFront({
        store: handle.store,
        messageId: sent.messageId,
        reorder: chatActions.queueReorder,
      });
    },
    [
      canSendNextStep,
      chatActions,
      handle.chatId,
      handle.store,
      nextStepSettings,
      profile,
      slashCatalog,
    ],
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
      slashCatalog,
    );
    return (
      chatActions.sendMessage({
        content,
        sender,
        settings: nextStepSettings,
        attachments: [],
        deliveryPolicy: "auto",
        restore: { content, browserAnnotations: [] },
      }) !== null
    );
  }, [canAct, chatActions, nextStepSettings, profile, slashCatalog]);
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
  const handleForkOpenChange = useCallback(
    (open: boolean): void => {
      if (!open) setForkTarget(null);
    },
    [setForkTarget],
  );
  // The chip renders as a sibling block below the composer (mirroring
  // the landing page) so the input box stays focused on prompt editing
  // and the binding affordances live alongside it. The selector reads
  // the chat session's `worktreeBinding` (populated from
  // `chat.subscribe`) and the cascading menu drives create / import /
  // re-bind through the existing modals.
  const hostWorkspaceSelector = useMemo(
    () => (
      <HostWorkspaceSelector
        disabled={false}
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
          ownerLabel: node.name,
          missingWorktreePaths: effectiveMissingPaths,
          bindingResolved: state.snapshotLoaded,
          onBindingCommitted: clearMissingPathsAfterBindingCommit,
          onForkOnHost: forkChatOnHost,
        }}
      />
    ),
    [
      activeHostId,
      currentEpicId,
      node.id,
      node.name,
      state.worktreeBinding,
      effectiveMissingPaths,
      state.snapshotLoaded,
      activeTurnStatus,
      composerActiveTurnStatus,
      clearMissingPathsAfterBindingCommit,
      forkChatOnHost,
      viewTabId,
    ],
  );
  const usageChip = useMemo(
    () => (
      <ContextUsageChipForChat
        handle={handle}
        harnessId={currentComposerSettings.harnessId}
        workingDirectories={resolvedComposerMentionRoots}
        commandsEnabled={activationQueries.discoverCompactSlashCommands}
        onCompact={canSendNextStep ? compactConversation : null}
      />
    ),
    [
      canSendNextStep,
      compactConversation,
      resolvedComposerMentionRoots,
      currentComposerSettings.harnessId,
      handle,
      activationQueries.discoverCompactSlashCommands,
    ],
  );
  // Composer v3 cluster: host select + Workspace rail picker on the left, with
  // the context-usage leaf owning its trailing chip and optional full-width
  // pinned strip. Per-folder Environment config lives inside the selected
  // Workspace panel.
  //
  // No Shells menu here any more (product decision, 2026-08-15): a shell's
  // own start card in the transcript carries its live status and the door to
  // its output, the Background strip lists what is running, and the output
  // window is where a shell is stopped, started or deleted. A second index
  // over the same shells crowded the composer without adding a capability.
  const workspaceControls = useMemo(
    () => (
      <>
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          {hostWorkspaceSelector}
        </div>
        {usageChip}
      </>
    ),
    [hostWorkspaceSelector, usageChip],
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
      readOnlyNotice: props.readOnlyNotice,
    }),
    [accessFlags.isViewer, canAct, props.readOnlyNotice],
  );

  // Steer capability is a stable boolean (flips only when the running turn's
  // harness changes), so it never churns the memoized composer per streamed
  // token. `getActiveTurnForSteer` reads the live turn at submit time for the
  // settings-drift comparison, avoiding a reactive activeTurn prop.
  const steerCapable = state.activeTurn?.sameTurnSteeringSupported ?? false;
  const steerProtocolSupported = state.steerProtocolSupported;
  const getActiveTurnForSteer = useCallback(
    () => handle.store.getState().activeTurn,
    [handle.store],
  );
  const lowerTurn = useMemo(
    () => ({
      activeTurnStatus: composerActiveTurnStatus,
      steerCapable,
      steerProtocolSupported,
      getActiveTurnForSteer,
      stopDisabled,
      onStopTurn: chatActions.stopTurn,
    }),
    [
      composerActiveTurnStatus,
      steerCapable,
      steerProtocolSupported,
      getActiveTurnForSteer,
      stopDisabled,
      chatActions.stopTurn,
    ],
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
              pendingInterview?.blockId ?? null,
              null,
            ),
    [
      forkPendingInterviewAssistantMessageId,
      forkAtAssistantMessage,
      pendingInterview?.blockId,
    ],
  );
  const lowerInterview = useMemo(
    () => ({
      pending: pendingInterview,
      isBusy: interviewBusy,
      unanswerable: unanswerableInterviews,
      unanswerableBusy: unanswerableInterviewsBusy,
      onAnswer: handleInterviewAnswer,
      onSkip: handleInterviewSkip,
      onFork: forkFromPendingInterview,
    }),
    [
      pendingInterview,
      interviewBusy,
      unanswerableInterviews,
      unanswerableInterviewsBusy,
      handleInterviewAnswer,
      handleInterviewSkip,
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

  // A worktree-creating send holds the host's per-chat serializer so the
  // final workspace binding is established before later queue actions run.
  // Keep both sides of a reversible resume visible while their action
  // acknowledgements wait behind serialized host work. A normal pause of a
  // running queue is not "Keep paused"; the authoritative paused rows make
  // this specifically the superseding action for a pending resume.
  const pendingQueueIntent = useMemo(() => {
    const pendingActions = Object.values(state.pendingActions);
    const resumeRequested = pendingActions.some(
      (action) => action.action === "resumeQueue",
    );
    const pauseRequested = pendingActions.some(
      (action) => action.action === "pauseQueue",
    );
    return {
      resumeRequested,
      keepPausedRequested:
        pauseRequested &&
        state.queue.items.some((item) => item.status === "paused"),
    };
  }, [state.pendingActions, state.queue.items]);

  const lowerQueue = useMemo(
    () => ({
      editingItem: editingQueueItem,
      editingItemId: activeEditingQueueItemId,
      value: state.queue,
      resumeRequested: pendingQueueIntent.resumeRequested,
      keepPausedRequested: pendingQueueIntent.keepPausedRequested,
      onPause: chatActions.pauseQueue,
      onResume: chatActions.resumeQueue,
      onEdit: editQueuedItem,
      onCancel: cancelQueuedItem,
      onAbortSteer: abortSteerQueuedItem,
      onCancelEdit: cancelQueueEditMode,
      onStopBackgroundItem: chatActions.stopBackgroundItem,
      onStopAllBackgroundItems: chatActions.stopAllBackgroundItems,
      onStopBackgroundSession: chatActions.stopBackgroundSession,
      onReorder: reorderQueuedItem,
      onSteerNow: steerQueuedItemNow,
    }),
    [
      editingQueueItem,
      activeEditingQueueItemId,
      state.queue,
      pendingQueueIntent,
      chatActions.pauseQueue,
      chatActions.resumeQueue,
      editQueuedItem,
      cancelQueuedItem,
      abortSteerQueuedItem,
      cancelQueueEditMode,
      chatActions.stopBackgroundItem,
      chatActions.stopAllBackgroundItems,
      chatActions.stopBackgroundSession,
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
      mentionRoots: composerMentionRoots,
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
      composerMentionRoots,
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
    tileId,
    tabHostId: activeHostId,
    linkResolutionRoots,
    currentEpicId,
    snapshotLoaded: state.snapshotLoaded,
    transcriptBaselineEpoch: state.transcriptBaselineEpoch,
    transcriptHydrationSequence: state.transcriptHydrationSequence,
    coldRewrittenMessageIds: state.coldRewrittenMessageIds,
    fatalClose: state.fatalClose,
    onChatRetry: () => handle.store.getState().retry(),
    restoreContext,
    messages: pinnedTodoRenderState.messages,
    activeTurnId,
    // Same line discriminator as the revert-scope resolution above: on the
    // legacy line the window is an inert empty value whose `rowCount` of 0
    // would make the merge treat every rendered row as an unplaced tail row.
    transcriptWindow: windowedTranscript ? state.transcriptWindow : null,
    surfaceVisible,
    surfaceFocused,
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
      backgroundSessionStopPending: state.pendingBackgroundSessionStop !== null,
    },
    todo: pinnedTodoRenderState.todo,
    revertOnEdit,
    steerRestart,
    teardownCommit: {
      open: teardownDialog !== null,
      choice: "submit" as const,
      holders: teardownDialog?.holders ?? [],
      immediateDisabled: !canAct || profile === null,
      refusalReason: teardownSendRefusalReason(canAct, profile !== null),
      onImmediate: () => {
        if (!canAct) {
          toast("You don't have permission to send.");
          return;
        }
        if (profile === null) {
          toast("Sign in to send this message.");
          return;
        }
        const armed = takeArmedTeardownSubmit(pendingSubmitRef);
        if (armed === null) return;
        if (armed.ownerId !== node.id) {
          setTeardownDialog(null);
          return;
        }
        const stagedKey: WorktreeStagingKey = {
          surface: "owner",
          hostId: activeHostId,
          epicId: currentEpicId,
          ownerKind: "chat",
          ownerId: node.id,
        };
        const liveSnapshot = snapshotTeardownHolders(
          droppedRunDirectoriesFromDraft({
            binding: state.worktreeBinding,
            draft: readStagedWorktreeIntent(stagedKey),
            removedWorkspacePaths: [],
          }),
        );
        const live: WorktreeCommitCapture = {
          draft: readStagedWorktreeIntent(stagedKey),
          revision: stagedWorktreeIntentRevision(stagedKey),
          binding: state.worktreeBinding,
          removedWorkspacePaths: [],
          stopTargets: liveSnapshot.stopTargets,
        };
        const disclosedHolders = teardownDialog?.holders ?? [];
        const drifted =
          worktreeCommitCaptureIsStale(armed.capture, live) ||
          teardownHolderSetDrifted(disclosedHolders, liveSnapshot.holders);
        if (drifted && liveSnapshot.holders.length > 0) {
          pendingSubmitRef.current = {
            input: armed.input,
            capture: live,
            ownerId: node.id,
          };
          setTeardownDialog({ holders: liveSnapshot.holders });
          return;
        }
        setTeardownDialog(null);
        dispatchUserSend(armed.input);
      },
      onDismiss: () => {
        pendingSubmitRef.current = null;
        setTeardownDialog(null);
      },
    },
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
  readonly node: ChatSurfaceNode;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly tabHostId: string | null;
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<ChatMessageModel>;
  /**
   * The running turn's id, or `null`. Seeds the "thinking" verb - see the pick
   * below for why it is the turn and not a count over `messages`.
   */
  readonly activeTurnId: string | null;
  /** The transcript index on the windowed line; `null` on the legacy line.
   *  See `ChatMessagesProps.transcriptWindow`. */
  readonly transcriptWindow: TranscriptWindow | null;
  /** Viewport-driven hydration report; see `ChatMessagesProps`. */
  readonly onVisibleOrdinalRangeChange: (range: OrdinalRange | null) => void;
  /** Which connection's snapshot established `messages`; see `ChatMessages`. */
  readonly baselineEpoch: number;
  /** Whether a range seated these rows; see `ChatMessages`. */
  readonly hydrationSequence: number;
  /** Rows rewritten while cold; see `ChatMessages`. */
  readonly coldRewrittenMessageIds: ReadonlySet<string>;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  readonly scrollRequest: ChatMessageScrollRequest | null;
  readonly surfaceVisible: boolean;
  readonly systemOverlayActive: boolean;
  readonly getMessageActions: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  readonly nextStepActions: NextStepActionHandler;
  readonly planActions: ChatPlanActionsContextValue;
  /** Measured height of the overlaid composer/queue/pinned/agents dock. */
  readonly composerOverlayHeight: number;
}

function ContextUsageChipForChat(props: {
  readonly handle: ChatSessionStoreHandle;
  readonly harnessId: GuiHarnessId;
  readonly workingDirectories: ReadonlyArray<string>;
  readonly commandsEnabled: boolean;
  readonly onCompact: ((commandName: string) => void) | null;
}): ReactNode {
  const usage = useStore(props.handle.store, selectContextUsage);
  const client = useTabHostClient();
  // `workingDirectories` is the composer's own resolved mention roots
  // (`resolvedComposerMentionRoots` in the parent), not the raw chat binding -
  // that's what makes this the SAME `agent.gui.listCommands` cache entry
  // `useKnownSlashCommandNames` already warms, not just a query sharing its
  // activation gate. An actionable tile therefore pays no extra RPC, and
  // an inactive one still fetches nothing and shows no compact affordance - it
  // also has no focusable composer to compact from.
  const { data: commands } = useSlashCommands("", {
    hostClient: client,
    harnessId: props.harnessId,
    workingDirectories: props.workingDirectories,
    enabled: props.commandsEnabled,
  });
  const compactCommand = findManualCompactCommand(commands);
  const requestCompact = props.onCompact;
  // The catalog is matched on `providerKind`, not on name (a differently
  // named compaction command is what this is for), so the literal text this
  // sends has to come from the matched command rather than a hardcoded guess.
  const onCompact =
    compactCommand === null || requestCompact === null
      ? null
      : () => requestCompact(compactCommand.name);
  return <ContextUsageChip usage={usage} onCompact={onCompact} />;
}

function ChatSessionMessagesSurface(
  props: ChatSessionMessagesSurfaceProps,
): ReactNode {
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
  // the RUNNING TURN's id - NOT the indicator row id, which flips from
  // `assistant:live` to `assistant:<turnId>` mid-turn and would otherwise
  // reshuffle the word.
  //
  // And not a completed-turn count over `messages` either, which is what this
  // was. On the windowed line `messages` is a bounded, evictable slice rather
  // than the transcript, so that count moved as the reader scrolled through
  // cold history and the verb changed underneath a running turn - against this
  // component's own stability guarantee, and visibly. The turn id is stable
  // for the turn by construction, needs no latch, and keeps the
  // "different verb per turn" property the count was there to provide.
  const workingVerb = pickWorkingVerb(
    `${props.node.id}:${props.activeTurnId ?? ""}`,
  );
  return (
    <ChatRestoreProvider value={props.restoreContext}>
      <ChatPlanActionsContext.Provider value={props.planActions}>
        <WorkingVerbContext.Provider value={workingVerb}>
          <ChatMarkdownLinkProvider
            tabId={props.viewTabId}
            workspaceRoots={props.workspaceRoots}
          >
            <ChatMessages
              taskTitle={props.node.name}
              taskId={props.node.id}
              epicId={props.epicId}
              hostId={props.tabHostId}
              messages={props.messages}
              transcriptWindow={props.transcriptWindow}
              onVisibleOrdinalRangeChange={props.onVisibleOrdinalRangeChange}
              baselineEpoch={props.baselineEpoch}
              hydrationSequence={props.hydrationSequence}
              coldRewrittenMessageIds={props.coldRewrittenMessageIds}
              backgroundItems={props.backgroundItems}
              scrollRequest={props.scrollRequest}
              getMessageActions={props.getMessageActions}
              nextStepActions={props.nextStepActions}
              instanceId={props.node.instanceId}
              visible={props.surfaceVisible}
              systemOverlayActive={props.systemOverlayActive}
              composerOverlayHeight={props.composerOverlayHeight}
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
  // This tile's composer is bound to the TAB host for life, so its last-run
  // fallback seeds read that host's buckets and the on-send write below lands
  // in them - another host's remembered settings never leak into this tab.
  const tabHostId = useTabHostId();
  const { globalLastRunSettings, epicRunSettingsEntry, setEpicRunSettings } =
    useComposerRunSettingsStore(
      useShallow((state) => ({
        globalLastRunSettings: selectGlobalLastRunSettings(state, tabHostId),
        epicRunSettingsEntry: selectEpicRunSettingsEntry(
          state,
          input.currentEpicId,
          tabHostId,
        ),
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
  // Consumers (the send/steer paths) keep the pre-host 3-param shape; the tab
  // host is bound here, the single site that knows it.
  const setEpicRunSettingsForTabHost = useCallback(
    (epicId: string, settings: ChatRunSettings, updatedAt: number) =>
      setEpicRunSettings(epicId, tabHostId, settings, updatedAt),
    [setEpicRunSettings, tabHostId],
  );

  return {
    composerFallbackSettingsSeed,
    epicRunSettings,
    globalLastRunSettings,
    initialComposerSettings,
    setEpicRunSettings: setEpicRunSettingsForTabHost,
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
 * which doubles as the surface-activation re-check. Explicit locked copies stay
 * disabled because they have no composer send gate to recover.
 */
function useChatMissingWorktreeFocusRefresh(args: {
  readonly handle: ChatSessionStoreHandle;
  readonly epicId: string;
  readonly chatId: string;
  readonly enabled: boolean;
}): void {
  const client = useTabHostClient();
  const bindingQuery = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "worktree.getBinding",
    params: { epicId: args.epicId, ownerId: args.chatId, ownerKind: "chat" },
    options: {
      enabled: args.enabled,
      poll: false,
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
  // Cache-only read (`enabled: false` below) must key where the cache is
  // WRITTEN, not where this tile happens to be bound: `epic.listCollaborators`
  // is only ever filled by the sidebar tree and the sharing panel, both keyed
  // on the Epic SESSION's host (`useEpicSessionHostClient`). The tab's host
  // owns the transcript, not the collaborator list - a tile bound to a
  // different host than the session (host B tile in an Epic served from A)
  // would key its read on B, which nobody ever populates, and collaborators
  // would stay permanently empty.
  const client = useEpicSessionHostClient();
  const { data } = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "epic.listCollaborators",
    params: { epicId },
    options: { enabled: false, poll: false },
  });
  return useMemo(() => flattenCollaborators(data?.collaborators ?? []), [data]);
}
