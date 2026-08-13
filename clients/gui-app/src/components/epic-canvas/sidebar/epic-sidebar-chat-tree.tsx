/**
 * Chat/terminal-agent tree body for the sidebar. Renders the tree of chat nodes
 * with expansion, rename, delete, and drag-drop behaviors.
 */
import { useDraggable } from "@dnd-kit/core";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { v4 as uuidv4 } from "uuid";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { makePublishedChatTileRef } from "@/stores/epics/canvas/tile-schema/published-chat-tile";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  useEpicArchiveChat,
  useEpicDeleteChat,
  useEpicRenameChat,
} from "@/hooks/epic/use-epic-chat-mutations";
import { useChatArchiveSupported } from "@/hooks/epic/use-chat-archive-support";
import {
  useEpicDeleteTuiAgent,
  useEpicRenameTuiAgent,
} from "@/hooks/epic/use-epic-tui-agent-mutations";
import {
  EPIC_NODE_ICONS,
  EPIC_NODE_SENTENCE_NOUNS,
  type EpicNodeKind,
} from "@/lib/artifacts/node-display";
import {
  computeDescendantCounts,
  formatCascadeSummary,
} from "@/lib/epic-tree-cascade";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { cn } from "@/lib/utils";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { OwnerResourceChip } from "@/components/resources/resource-usage-chip";
import type { ResourceOwnerKindWire } from "@traycer/protocol/host/resources/subscribe";
import { ChatProgressIcon } from "@/components/chat/chat-progress-icon";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import {
  NotificationIndicatorsContext,
  useSurfaceNotificationIndicatorState,
} from "@/components/notifications/notification-indicator-context";
import {
  APPROVAL_TONE,
  attentionTone,
  DONE_TONE,
  FAILURE_TONE,
  FORK_TONE,
  INTERVIEW_TONE,
  type IndicatorTone,
} from "@/components/notifications/notification-indicator-tones";
import { BackgroundActivityGlyph } from "@/components/notifications/background-activity-glyph";
import {
  selectNotificationIndicatorState,
  type NotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import type { TreeSlice } from "@/stores/epics/open-epic/types";
import type { ProviderId } from "@/components/home/data/landing-options";
import { ProfileBadgedHarnessIcon } from "@/components/providers/profile-badged-harness-icon";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ContextMenuContent } from "@/components/ui/context-menu";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { TreeChevron, TreeChevronSpacer } from "@/components/ui/tree-chevron";
import {
  CHAT_ARCHIVE_VISIBILITY,
  CHAT_ORIGIN,
  isChatFilterActive,
  useAcknowledgedRootCreatePending,
  useChatArchiveVisibility,
  useChatFilter,
  useChatSort,
  useLocalRootCreatePending,
  type ChatArchiveVisibility,
  type ChatFilter,
  type RootCreatePanelId,
} from "@/stores/epics/left-panel-store";
import {
  isDefaultSort,
  makeNodeComparator,
  type NodeComparator,
} from "@/lib/epic-sort";
import {
  findOpenArtifactInTab,
  useActiveEpicArtifactId,
  useEpicCanvasStore,
  useIsActiveEpicArtifact,
  useOpenTileContentIds,
} from "@/stores/epics/canvas/store";
import {
  isOpenableEpicNodeKind,
  type OpenableEpicNodeKind,
} from "@/stores/epics/canvas/types";
import {
  useEpicSidebarEffectiveExpanded,
  useEpicSidebarExpansionStore,
} from "@/stores/epics/epic-sidebar-expansion-store";
import {
  useAncestorIds,
  useEpicActiveAgentIds,
  useEpicAgentRoleClaims,
  useEpicAgentActivityTiers,
  type AgentActivityTier,
  useEpicArtifactRecords,
  useEpicChatIds,
  useEpicConnectionStatus,
  useEpicNodeArchived,
  useEpicNodeUpdatedAt,
  useEpicNodeHostId,
  useEpicNodeOwnerUserId,
  useEpicNodeOwnerKind,
  useEpicPermissionRole,
  useEpicTreeIndex,
  useEpicTreeNode,
  useMaybeEpicTuiAgentHarnessId,
} from "@/lib/epic-selectors";
import { EpicSidebarCloudChatRow } from "@/components/epic-canvas/sidebar/epic-sidebar-cloud-chat-row";
import {
  isCloudChatListSettled,
  useCloudChatList,
} from "@/hooks/chats/use-cloud-chat-queries";
import {
  publicationTargetMap,
  useChatPublicationTargets,
} from "@/hooks/chats/use-chat-publication-targets";
import {
  mergeChatListEntries,
  selectUnfoldedCloudChats,
} from "@/lib/chats/unified-chat-list";
import { AgentRoleBadges } from "./agent-role-badges";
import { AgentHoverTooltip } from "@/components/epic-canvas/sidebar/agent-hover-tooltip";
import { isEditableRole } from "@/lib/epic-permissions";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  Archive,
  ArchiveRestore,
  Check,
  MessagesSquare,
  MoreHorizontal,
  Lock,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  BASE_PAD_LEFT,
  EMPTY_PENDING_LIST,
  EMPTY_PRE_ACK_LIST,
  INDENT_PX,
  anyMutationPending,
  nodePadRightClass,
  useNodeIconDisplay,
} from "./epic-sidebar-tree-shared";
import { TreeGroupGuide } from "./epic-sidebar-tree-guide";
import {
  applyVisibleFilter,
  collectWithAncestors,
  isFilteredTreeEmpty,
  mergeForcedExpanded,
  SidebarFilterVisibilityContext,
  SidebarSortContext,
  useFilteredPanelChildIds,
  useSidebarVisibleIds,
} from "./epic-sidebar-filter";
import {
  CHATS_TREE_FILTER,
  collectVisibleSidebarTreeIds,
  combineSidebarVisibleIds,
  revealArchiveHiddenIds,
  sidebarTreeRootIds,
  useMaybeSidebarBulkSelection,
  useSidebarArchiveHiddenIds,
} from "./epic-sidebar-selection";
import {
  getSidebarNodeDragId,
  getPaneScopedDndId,
  SIDEBAR_NODE_DND_TYPE,
  type EpicCanvasSidebarNodeDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { SidebarReparentRowDropWrapper } from "@/components/epic-canvas/sidebar/sidebar-reparent-row-drop-wrapper";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { resolveProfileAccentDot } from "@/components/worktree/worktree-owner-settings-model";
import { harnessProfiles } from "@/components/worktree/worktree-owner-settings-profiles";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import {
  SidebarContextMenuItems,
  SidebarDropdownMenuItems,
  type SidebarRowMenuEntry,
} from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { chatActivityIndicator } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import {
  NotificationIndicatorIcon,
  type IndicatorRunningKind,
} from "@/components/notifications/notification-indicator-icon";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostClient } from "@/lib/host/runtime";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";

interface ChatTreePanelBodyProps {
  readonly epicId: string;
  readonly tabId: string;
}

type TreeFilterFn = (type: string | null | undefined) => boolean;

/**
 * Epic-level viewer (read-only) role for the chat panel. Resolved once in
 * `ChatTreePanelBody` and read directly by the leaf status chip, rather than
 * drilled through four row layers or re-subscribed per row via
 * `useEpicPermissionRole()`. A row's OWN chat session access overrides it when
 * that chat is open.
 *
 * This saves the per-row subscription for the TRAILING chip only. The leading
 * `ChatProgressIcon` is deliberately status-aware, and it re-subscribes per row
 * through its own `useEpicPermissionRole()` call - a known, accepted cost of
 * keeping that icon, not an oversight this context still eliminates.
 */
const SidebarViewerContext = createContext<boolean>(false);

/**
 * Whether the epic's host advertises `epic.setChatArchived`. Resolved ONCE in
 * `ChatTreePanelBody` and read by the rows, for the same reason
 * {@link SidebarViewerContext} exists: it is a per-host fact, identical for
 * every row, and re-subscribing each row to the manifest registry would buy
 * nothing. `false` is the fail-closed default - every archive affordance stays
 * hidden until a handshake proves the method present.
 */
const SidebarArchiveSupportedContext = createContext<boolean>(false);

/** Frozen so an absent cloud list does not re-run the fold every render. */
const EMPTY_CLOUD_CHATS: readonly CloudChatSummary[] = [];

const EMPTY_SELECTED_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_ALWAYS_VISIBLE_IDS: ReadonlyArray<string> = [];
const noopToggleSelection = (_id: string): void => undefined;
const noopRowAction = (): void => undefined;

function archiveEmptyStateCopy(
  visibility: ChatArchiveVisibility,
  canArchive: boolean,
): { readonly title: string; readonly description: string | null } {
  if (visibility === CHAT_ARCHIVE_VISIBILITY.Archived) {
    return {
      title: "No archived agents match this view.",
      description: canArchive
        ? 'Choose "Unarchived only" or "All chats" under Show.'
        : null,
    };
  }
  return {
    title: "Every agent here is archived.",
    description: canArchive
      ? 'Choose "Archived only" or "All chats" under Show.'
      : null,
  };
}

type ChatDescendantStatusKind =
  | "failure"
  | "fork"
  | "interview"
  | "approval"
  | "running"
  | "background"
  | "done";

/**
 * One shared urgency ladder for a collapsed parent's icon slot: the parent's
 * own status tier and the hidden descendants' highest tier are ranked on it,
 * and the higher one owns the slot (ties go to the parent, so solid always
 * beats muted). Mirrors the order `NotificationIndicatorIcon` resolves a
 * single chat's simultaneous states.
 *
 * `running` (an agent turn) outranks `background` (a `run_in_background` task
 * / subagent / Monitor / scheduled wakeup keeping a session non-idle while the
 * agent itself is idle), matching the turn-over-background precedence the
 * per-chat indicator already uses. Both still outrank `done`, so any live work
 * beats a finished-but-unread one.
 */
const CHAT_STATUS_RANKS: Record<ChatDescendantStatusKind, number> = {
  failure: 7,
  fork: 6,
  interview: 5,
  approval: 4,
  running: 3,
  background: 2,
  done: 1,
};

/** {@link CHAT_STATUS_RANKS} most-urgent first, for picking a rollup's kind. */
const CHAT_STATUS_ORDER: ReadonlyArray<ChatDescendantStatusKind> = [
  "failure",
  "fork",
  "interview",
  "approval",
  "running",
  "background",
  "done",
];

/** The ladder kind an activity tier occupies. */
function activityTierKind(tier: AgentActivityTier): ChatDescendantStatusKind {
  return tier === "turn" ? "running" : "background";
}

/**
 * The single tier a descendant chat is counted under - its own highest. The
 * attention precedence goes through the shared `attentionTone`, so
 * failure > interview > approval lives in exactly one place.
 */
function chatDescendantKind(
  indicatorState: NotificationIndicatorState,
  tier: AgentActivityTier | undefined,
): ChatDescendantStatusKind | null {
  const tone = attentionTone(indicatorState);
  if (tone === FAILURE_TONE) return "failure";
  if (tone === FORK_TONE) return "fork";
  if (tone === INTERVIEW_TONE) return "interview";
  if (tone === APPROVAL_TONE) return "approval";
  if (tier !== undefined) return activityTierKind(tier);
  if (indicatorState.unreadDone) return "done";
  return null;
}

/**
 * Rollup over a collapsed parent's hidden chat descendants: the
 * highest-priority kind plus per-tier counts (each descendant is counted once,
 * under its own highest tier) so the icon's tooltip can break the aggregate
 * down instead of hiding it behind one glyph.
 */
interface ChatDescendantStatusRollup {
  readonly kind: ChatDescendantStatusKind;
  readonly failureCount: number;
  readonly forkCount: number;
  readonly interviewCount: number;
  readonly approvalCount: number;
  readonly runningCount: number;
  readonly backgroundCount: number;
  readonly doneCount: number;
}

const EMPTY_CHAT_DESCENDANT_IDS: ReadonlyArray<string> = [];

/**
 * Collects the chat / terminal-agent descendants of `nodeId` so a collapsed
 * parent can roll their statuses up without mounting the child rows. Mirrors
 * the artifact tree's `collectDescendantArtifactEntries`: filter-hidden
 * subtrees are skipped along with their children (the rollup must never point
 * at a row the user cannot reach by expanding) and the walk is cycle-guarded
 * via `visited`. Chats and terminal-agents are collected alike - both are
 * chat-scoped notification entities carrying an activity tier.
 */
function collectDescendantChatIds(
  nodeId: string,
  tree: TreeSlice,
  visibleIds: ReadonlySet<string> | null,
): ReadonlyArray<string> {
  const rootChildren = Object.hasOwn(tree.childrenByParent, nodeId)
    ? tree.childrenByParent[nodeId]
    : null;
  if (rootChildren === null || rootChildren.length === 0) {
    return EMPTY_CHAT_DESCENDANT_IDS;
  }
  const descendantIds: string[] = [];
  const visited = new Set<string>([nodeId]);
  const stack = [...rootChildren];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    if (visibleIds !== null && !visibleIds.has(id)) continue;
    if (!Object.hasOwn(tree.nodeById, id)) continue;
    const node = tree.nodeById[id];
    if (CHATS_TREE_FILTER(node.type)) descendantIds.push(id);
    if (Object.hasOwn(tree.childrenByParent, id)) {
      for (const childId of tree.childrenByParent[id]) stack.push(childId);
    }
  }
  if (descendantIds.length === 0) {
    return EMPTY_CHAT_DESCENDANT_IDS;
  }
  return descendantIds;
}

/**
 * Rollup over a collapsed parent's hidden chat descendants, or `null` when
 * there are none or none has a notable status. Each descendant is classified
 * once, under its own highest tier - the per-chat attention precedence goes
 * through the shared `attentionTone`, so failure > interview > approval lives
 * in exactly one place. Terminal-agent descendants are classified the same
 * way: their `agent.stopped` notifications are chat-scoped to the agent id,
 * so they carry real indicator entries alongside their activity tier. Only
 * mounted inside `ChatRowLeadingIconWithNestedRollup` (rendered solely for
 * collapsed parents), so leaves and expanded rows carry none of these
 * subscriptions; the shallow-compared flat result lets Zustand bail re-renders
 * whose rollup did not change.
 */
function useChatDescendantStatus(args: {
  readonly epicId: string;
  readonly nodeId: string;
}): ChatDescendantStatusRollup | null {
  const { epicId, nodeId } = args;
  const tree = useEpicTreeIndex();
  const visibleIds = useSidebarVisibleIds();
  const descendants = useMemo(
    () => collectDescendantChatIds(nodeId, tree, visibleIds),
    [nodeId, tree, visibleIds],
  );
  const activityTiers = useEpicAgentActivityTiers();
  const indicators = useContext(NotificationIndicatorsContext);
  return useAppLocalNotificationsStore(
    useShallow((state): ChatDescendantStatusRollup | null => {
      if (descendants === EMPTY_CHAT_DESCENDANT_IDS) return null;
      const counts: Record<ChatDescendantStatusKind, number> = {
        failure: 0,
        fork: 0,
        interview: 0,
        approval: 0,
        running: 0,
        background: 0,
        done: 0,
      };
      for (const chatId of descendants) {
        const indicatorState = selectNotificationIndicatorState(
          state,
          { epicId, chatId },
          null,
          indicators,
        );
        const kind = chatDescendantKind(
          indicatorState,
          activityTiers.get(chatId),
        );
        if (kind !== null) counts[kind] += 1;
      }
      const kind =
        CHAT_STATUS_ORDER.find((candidate) => counts[candidate] > 0) ?? null;
      if (kind === null) return null;
      return {
        kind,
        failureCount: counts.failure,
        forkCount: counts.fork,
        interviewCount: counts.interview,
        approvalCount: counts.approval,
        runningCount: counts.running,
        backgroundCount: counts.background,
        doneCount: counts.done,
      };
    }),
  );
}

interface ExpansionController {
  expandedIds: ReadonlySet<string>;
  toggleExpanded: (id: string) => void;
  ensureExpanded: (id: string) => void;
}

function usePanelRootIds(
  panelId: RootCreatePanelId,
  comparator: NodeComparator | null,
): ReadonlyArray<string> {
  const tree = useEpicTreeIndex();
  return useMemo(() => {
    if (panelId === "artifacts") {
      return [];
    }
    // Roots = chats/terminal-agents that have no parent in the rendered tree,
    // read off the projector's `rootIds` so chats and terminal-agents
    // interleave by the chosen sort key instead of grouping by type -
    // consistent with how nested children render off `childrenByParent`.
    // Iterating the record list instead would surface the projector's slice
    // order (all chats, then all terminal-agents) and drop the sort. Child
    // agents (spawned via `agent.create`, which sets the new agent's
    // `parentId` to its sender) are nested through `useChildIds` off
    // `childrenByParent` and are absent from `rootIds`, so they correctly
    // never appear here.
    return sidebarTreeRootIds({
      tree,
      treeFilter: CHATS_TREE_FILTER,
      comparator,
    });
  }, [panelId, tree, comparator]);
}

/**
 * Visible-id set for an active chat origin filter (GUI chats vs TUI terminal
 * agents), expanded to include ancestors so filtered nodes stay reachable.
 * `null` when no filter is active.
 */
function useChatVisibleIds(epicId: string): ReadonlySet<string> | null {
  const filter = useChatFilter(epicId);
  const liveRecords = useEpicArtifactRecords();
  const tree = useEpicTreeIndex();
  return useMemo(() => {
    if (!isChatFilterActive(filter)) return null;
    const wantType = filter.origin === "gui" ? "chat" : "terminal-agent";
    const matches = liveRecords.flatMap((record): string[] =>
      record.type === wantType ? [record.id] : [],
    );
    return collectWithAncestors(matches, tree.nodeById);
  }, [filter, liveRecords, tree]);
}

/**
 * Whether a cloud row survives the archive filter.
 *
 * The row carries its own `isArchived`, so this is the same question the local
 * tree answers from `archiveHiddenIds` - just asked of a row that is not in the
 * tree to be hidden from.
 */
function cloudRowMatchesArchiveVisibility(
  chat: CloudChatSummary,
  visibility: ChatArchiveVisibility,
): boolean {
  if (visibility === CHAT_ARCHIVE_VISIBILITY.All) return true;
  return visibility === CHAT_ARCHIVE_VISIBILITY.Archived
    ? chat.isArchived
    : !chat.isArchived;
}

/**
 * Whether a cloud row survives the origin filter.
 *
 * Every cloud row is a GUI chat - the cloud list carries chats, and a terminal
 * agent is not one - so a TUI-origin filter excludes all of them and any other
 * state includes all of them. It takes no row argument for that reason; the
 * signature stays row-shaped at the call site so a future origin that IS
 * expressible per row has an obvious place to go.
 */
function cloudRowMatchesOriginFilter(filter: ChatFilter): boolean {
  if (!isChatFilterActive(filter)) return true;
  return filter.origin !== CHAT_ORIGIN.Tui;
}

// Panel body composes sort/filter/expansion/selection/pending-create hooks in
// a stable order; child row complexity is isolated below.
// eslint-disable-next-line complexity
export function ChatTreePanelBody(props: ChatTreePanelBodyProps) {
  const { epicId, tabId } = props;
  const shouldReduceMotion = useReducedMotion() === true;
  const panelId: RootCreatePanelId = "chats";
  const sort = useChatSort(epicId);
  const comparator = useMemo<NodeComparator | null>(
    () => (isDefaultSort(sort) ? null : makeNodeComparator(sort)),
    [sort],
  );
  const allRootIds = usePanelRootIds(panelId, comparator);
  const originVisibleIds = useChatVisibleIds(epicId);
  const tree = useEpicTreeIndex();
  const archiveVisibility = useChatArchiveVisibility(epicId);
  // The origin filter's own value, for the cloud rows. The local tree consumes
  // it as the id set `useChatVisibleIds` expands it into; a cloud row is not in
  // the tree, so it answers the filter directly.
  const chatFilter = useChatFilter(epicId);
  const baseArchiveHiddenIds = useSidebarArchiveHiddenIds(epicId);
  const canArchive = useChatArchiveSupported();
  const originRootIds = useMemo(
    () => applyVisibleFilter(allRootIds, originVisibleIds),
    [allRootIds, originVisibleIds],
  );

  // Indicators must be fetched BEFORE archive hiding is applied. Archived
  // rows carrying attention/unread state are an explicit visibility exception;
  // querying only the already-visible rows would make that exception circular
  // and the activity impossible to discover.
  const indicatorChatIds = useMemo(
    () =>
      Object.keys(tree.nodeById)
        .filter(
          (id) =>
            CHATS_TREE_FILTER(tree.nodeById[id].type) &&
            (originVisibleIds === null || originVisibleIds.has(id)),
        )
        .sort(),
    [tree, originVisibleIds],
  );
  const epicSessionHostId = useEpicSessionHostId();
  const notificationIndicators = useNotificationIndicators({
    // The chats in this tree are THIS Epic session's, and the session's host is
    // not necessarily the app-wide active one - a retained Epic tab keeps its
    // binding while another host is selected. `indicatorState` is computed over
    // one host's own rows, so the active host would answer about chats it does
    // not own (see `EpicBackupStatusIndicator`, which scopes the same way for
    // the same reason).
    hostId: epicSessionHostId,
    epicIds: [],
    chatIds: indicatorChatIds,
    enabled: indicatorChatIds.length > 0,
  });
  const openTileContentIds = useOpenTileContentIds(tabId);
  const activityTiers = useEpicAgentActivityTiers();
  const alwaysVisibleIds = useAppLocalNotificationsStore(
    useShallow((state): ReadonlyArray<string> => {
      if (archiveVisibility !== CHAT_ARCHIVE_VISIBILITY.Unarchived) {
        return EMPTY_ALWAYS_VISIBLE_IDS;
      }
      return indicatorChatIds.filter((chatId) => {
        if (openTileContentIds.has(chatId)) return true;
        const indicatorState = selectNotificationIndicatorState(
          state,
          { epicId, chatId },
          null,
          notificationIndicators,
        );
        return (
          chatDescendantKind(indicatorState, activityTiers.get(chatId)) !== null
        );
      });
    }),
  );
  const archiveHiddenIds = useMemo(
    () => revealArchiveHiddenIds(baseArchiveHiddenIds, alwaysVisibleIds, tree),
    [baseArchiveHiddenIds, alwaysVisibleIds, tree],
  );

  // Two independent narrowings, kept separate on purpose. `originRootIds` is
  // the origin filter's result and feeds the "no matches" empty state and
  // forced expansion; `rootIds` additionally drops archived roots and is what
  // actually renders. Collapsing them would make an all-archived tree show the
  // Interface-filter empty state instead of the archived one, blaming a filter
  // that is not hiding anything.
  const rootIds = useMemo(
    () =>
      archiveHiddenIds.size === 0
        ? originRootIds
        : originRootIds.filter((id) => !archiveHiddenIds.has(id)),
    [originRootIds, archiveHiddenIds],
  );
  const visibleIds = useMemo(
    () => combineSidebarVisibleIds(originVisibleIds, archiveHiddenIds, tree),
    [originVisibleIds, archiveHiddenIds, tree],
  );
  // Resolved once here and threaded down, matching how this body already
  // handles every other epic-level fact.
  const localChatIds = useEpicChatIds();
  // The task's chats on hosts this device cannot reach, folded against the
  // local tree by PUBLICATION identity and interleaved into one recency-sorted
  // list. There is no "other devices" section: a chat's host is a property of
  // the chat, and a lock on the row says what its state is. App-wide client,
  // not the tab's - the cloud read is served by whatever host this device runs.
  const appHostClient = useHostClient();
  const cloudChats = useCloudChatList({
    client: appHostClient,
    taskId: epicId,
    enabled: epicId.length > 0,
  });
  const publicationTargets = useChatPublicationTargets({
    client: appHostClient,
    epicId,
    chatIds: localChatIds,
    enabled: epicId.length > 0,
  });
  const unfoldedCloudChats = useMemo(
    () =>
      selectUnfoldedCloudChats({
        chats: cloudChats.data?.chats ?? EMPTY_CLOUD_CHATS,
        localChatIds,
        publicationChatIdByChatId: publicationTargetMap(
          publicationTargets.data,
        ),
      }),
    [cloudChats.data, localChatIds, publicationTargets.data],
  );
  // The sidebar's own filters apply to cloud rows too. They were reaching only
  // the local tree, so an "Unarchived only" list still drew archived remote
  // chats (and "Archived only" drew unarchived ones), and a TUI-origin filter
  // left every cloud row in place - each row carries the fact the filter asks
  // about, so showing it anyway is the list contradicting its own filter chips.
  //
  // No attention-reveal exception, unlike the local side's `alwaysVisibleIds`:
  // that exists so a row whose activity THIS device tracks cannot be archived
  // into invisibility, and a cloud row's indicators belong to its owner.
  const visibleCloudChats = useMemo(
    () =>
      unfoldedCloudChats.filter(
        (chat) =>
          cloudRowMatchesArchiveVisibility(chat, archiveVisibility) &&
          cloudRowMatchesOriginFilter(chatFilter),
      ),
    [unfoldedCloudChats, archiveVisibility, chatFilter],
  );
  const activeArtifactId = useActiveEpicArtifactId(tabId);
  const permissionRole = useEpicPermissionRole();
  const connectionStatus = useEpicConnectionStatus();
  const isDisconnected = connectionStatus === "closed";
  const canEdit = isEditableRole(permissionRole);
  const canMutate = canEdit && !isDisconnected;
  // Read-only (viewer) indication is epic-level, so it is resolved ONCE here
  // and threaded down as a boolean rather than re-subscribing every row to
  // `useEpicPermissionRole()`. `viewer` specifically - a null (not-yet-known)
  // role must not flash the lock. The status-aware leading `ChatProgressIcon`
  // still makes that per-row subscription itself; see `SidebarViewerContext`.
  const isViewer = permissionRole === "viewer";
  const localRootPending = useLocalRootCreatePending(epicId, panelId);
  const acknowledgedRootPending = useAcknowledgedRootCreatePending(
    epicId,
    panelId,
  );
  const pendingRootCreates = useEpicCanvasStore(
    (s) => s.pendingRootCreatesByEpic[epicId] ?? EMPTY_PENDING_LIST,
  );
  const preAckRootCreates = useEpicCanvasStore(
    (s) => s.preAckRootCreatesByEpic[epicId] ?? EMPTY_PRE_ACK_LIST,
  );
  const visiblePendingRootCreates = useMemo(
    () => pendingRootCreates.filter((entry) => !rootIds.includes(entry.id)),
    [pendingRootCreates, rootIds],
  );
  const showPendingRootRows =
    archiveVisibility !== CHAT_ARCHIVE_VISIBILITY.Archived;
  const renderedLocalRootPending = showPendingRootRows
    ? localRootPending
    : null;
  const renderedAcknowledgedRootPending = showPendingRootRows
    ? acknowledgedRootPending
    : null;
  const renderedPreAckRootCreates = showPendingRootRows
    ? preAckRootCreates
    : EMPTY_PRE_ACK_LIST;
  const renderedPendingRootCreates = showPendingRootRows
    ? visiblePendingRootCreates
    : EMPTY_PENDING_LIST;

  const ancestorIdsOfActive = useAncestorIds(activeArtifactId);
  // Origin-only: see `combineSidebarVisibleIds`. Archive hiding must never
  // reach here.
  const forcedExpandedIds = useMemo(
    () => mergeForcedExpanded(ancestorIdsOfActive, originVisibleIds),
    [ancestorIdsOfActive, originVisibleIds],
  );
  const expandedIds = useEpicSidebarEffectiveExpanded(
    tabId,
    panelId,
    rootIds,
    forcedExpandedIds,
  );
  const expandAction = useEpicSidebarExpansionStore((s) => s.expand);
  const collapseAction = useEpicSidebarExpansionStore((s) => s.collapse);
  const toggleExpanded = useCallback(
    (id: string) => {
      if (expandedIds.has(id)) collapseAction(tabId, panelId, id);
      else expandAction(tabId, panelId, id);
    },
    [tabId, panelId, expandedIds, expandAction, collapseAction],
  );
  const ensureExpanded = useCallback(
    (id: string) => {
      expandAction(tabId, panelId, id);
    },
    [tabId, panelId, expandAction],
  );

  const expansion = useMemo<ExpansionController>(
    () => ({ expandedIds, toggleExpanded, ensureExpanded }),
    [expandedIds, toggleExpanded, ensureExpanded],
  );
  const bulkSelection = useMaybeSidebarBulkSelection();
  const selectableIds = useMemo(
    () =>
      collectVisibleSidebarTreeIds({
        rootIds,
        expandedIds,
        tree,
        treeFilter: CHATS_TREE_FILTER,
        emitFilter: CHATS_TREE_FILTER,
        visibleIds,
        comparator,
      }),
    [rootIds, expandedIds, tree, visibleIds, comparator],
  );
  const setSelectableIds = bulkSelection?.setSelectableIds ?? null;
  useEffect(() => {
    setSelectableIds?.(selectableIds);
  }, [setSelectableIds, selectableIds]);
  const resetSelection = bulkSelection?.resetSelection ?? null;
  useEffect(
    () => () => {
      resetSelection?.();
    },
    [resetSelection],
  );
  const selectionMode = bulkSelection?.selectionMode ?? false;
  const selectedIds = bulkSelection?.selectedIds ?? EMPTY_SELECTED_IDS;
  const toggleSelection = bulkSelection?.toggleSelection ?? noopToggleSelection;
  const hasPendingRootRows =
    renderedLocalRootPending !== null ||
    renderedAcknowledgedRootPending !== null ||
    renderedPreAckRootCreates.length > 0 ||
    renderedPendingRootCreates.length > 0;
  // Local-tree emptiness AND no surviving cloud row: a GUI-origin filter over a
  // task whose only chats are remote leaves the tree empty and the list full, so
  // asking the tree alone would announce "no matches" over rows on screen.
  const filteredTreeEmpty =
    isFilteredTreeEmpty({
      visibleIds: originVisibleIds,
      rootIds: originRootIds,
      localRootPending: renderedLocalRootPending,
      acknowledgedRootPending: renderedAcknowledgedRootPending,
      preAckRootCreates: renderedPreAckRootCreates,
      visiblePendingRootCreates: renderedPendingRootCreates,
    }) && visibleCloudChats.length === 0;
  // One list: local roots and unreachable-host rows, interleaved. Nested local
  // children still render under their parents through `ChatNode`; only ROOTS
  // take part in the interleave, and a cloud row is always a leaf.
  const listEntries = useMemo(
    () =>
      mergeChatListEntries({
        localRootIds: rootIds,
        nodeById: tree.nodeById,
        cloudChats: visibleCloudChats,
        comparator,
      }),
    [rootIds, tree.nodeById, visibleCloudChats, comparator],
  );
  // "No agents yet" is now a statement about the TASK rather than this device,
  // so a task whose only agents live on an unreachable host is not empty - it
  // is a list of locked rows. That is the whole restoration.
  //
  // Gated on the list having ANSWERED as well: an in-flight list looks exactly
  // like a task with no remote agents, so without this the panel claims "No
  // agents yet." for a moment and then fills with rows - see
  // `isCloudChatListSettled` for why the query's own predicate is the one to
  // ask. Pre-filter on purpose: this arm means the task HAS nothing, so a row
  // the user's own filter is hiding still counts as something.
  const showEmptyState =
    originVisibleIds === null &&
    allRootIds.length === 0 &&
    unfoldedCloudChats.length === 0 &&
    isCloudChatListSettled(cloudChats) &&
    !hasPendingRootRows;
  // Rows exist and survive the origin filter, yet archiving hid every one of
  // them. Distinct from both other arms: the tree is neither empty nor filtered
  // down to nothing, and the user needs to be told where the rows went. Cloud
  // rows count on both sides of that sentence, or an all-archived remote list
  // would fall through to "No agents yet."
  const archiveHidEverything =
    !hasPendingRootRows &&
    rootIds.length === 0 &&
    visibleCloudChats.length === 0 &&
    (originRootIds.length > 0 || unfoldedCloudChats.length > 0);
  const archiveEmptyState = archiveEmptyStateCopy(
    archiveVisibility,
    canArchive,
  );

  let panelContent: ReactNode;
  if (showEmptyState) {
    panelContent = (
      <SidebarPanelEmptyState
        icon={MessagesSquare}
        title="No agents yet."
        description="Add an agent and choose a Chat or Terminal interface."
        testId="epic-chat-sidebar-empty"
      />
    );
  } else if (filteredTreeEmpty) {
    panelContent = (
      <SidebarPanelEmptyState
        icon={MessagesSquare}
        // Names the INTERFACE as the thing with no matches. "No agents match"
        // would imply the Task has none at all, when the filter is only hiding
        // the other interface.
        title="No matches for the current filters."
        description="The Interface filter is hiding the other agents."
        testId="epic-chat-sidebar-filter-empty"
      />
    );
  } else {
    panelContent = (
      <AnimatePresence initial={false} mode="wait">
        {archiveHidEverything ? (
          <m.div
            key="archived-empty"
            className="flex min-h-0 flex-1 flex-col"
            initial={shouldReduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.16 }}
          >
            <SidebarPanelEmptyState
              icon={Archive}
              title={archiveEmptyState.title}
              description={archiveEmptyState.description}
              testId="epic-chat-sidebar-archived-empty"
            />
          </m.div>
        ) : (
          <m.div
            key="tree"
            className="flex min-h-0 flex-1 flex-col"
            exit={shouldReduceMotion ? undefined : { opacity: 0, x: -8 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.16 }}
          >
            <ul
              role="tree"
              aria-label="Epic agents tree"
              className="space-y-0.5"
            >
              {/* Clearing an archived row's last notification indicator removes
              its visibility exception. Keep the tree branch mounted through
              that final-row exit before revealing the archived empty state.
              Rows come from the UNIFIED list (chat-sync-v2): local tree nodes
              and cloud-only rows interleave under one comparator. */}
              <AnimatePresence initial={false}>
                {listEntries.map((entry) =>
                  entry.kind === "local" ? (
                    <ChatNode
                      key={entry.key}
                      epicId={epicId}
                      tabId={tabId}
                      nodeId={entry.nodeId}
                      depth={0}
                      expansion={expansion}
                      canEdit={canEdit}
                      canMutate={canMutate}
                      isDisconnected={isDisconnected}
                      treeFilter={CHATS_TREE_FILTER}
                      selectionMode={selectionMode}
                      selectedIds={selectedIds}
                      onToggleSelection={toggleSelection}
                    />
                  ) : (
                    <EpicSidebarCloudChatRow
                      key={entry.key}
                      chat={entry.chat}
                      epicId={epicId}
                      tabId={tabId}
                      depth={0}
                      selectionMode={selectionMode}
                    />
                  ),
                )}
              </AnimatePresence>
              {renderedLocalRootPending !== null && (
                <PendingCreateRow
                  depth={0}
                  name={renderedLocalRootPending.name}
                />
              )}
              {renderedAcknowledgedRootPending !== null && (
                <PendingCreateRow
                  depth={0}
                  name={renderedAcknowledgedRootPending.name}
                />
              )}
              {renderedPreAckRootCreates.map(
                (entry: { tempId: string; name: string }) => (
                  <PendingCreateRow
                    key={entry.tempId}
                    depth={0}
                    name={entry.name}
                  />
                ),
              )}
              {renderedPendingRootCreates.map(
                (entry: { id: string; name: string }) => (
                  <PendingCreateRow
                    key={entry.id}
                    depth={0}
                    name={entry.name}
                  />
                ),
              )}
            </ul>
          </m.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <NotificationIndicatorsProvider indicators={notificationIndicators}>
      <SidebarArchiveSupportedContext.Provider value={canArchive}>
        <SidebarViewerContext.Provider value={isViewer}>
          <SidebarSortContext.Provider value={comparator}>
            <SidebarFilterVisibilityContext.Provider value={visibleIds}>
              <SidebarContent className="gap-0">
                <SidebarGroup className="min-h-0 flex-1 px-2 py-1">
                  <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
                    {panelContent}
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarContent>
            </SidebarFilterVisibilityContext.Provider>
          </SidebarSortContext.Provider>
        </SidebarViewerContext.Provider>
      </SidebarArchiveSupportedContext.Provider>
    </NotificationIndicatorsProvider>
  );
}

function PendingCreateRow({ depth, name }: { depth: number; name: string }) {
  return (
    <li
      role="treeitem"
      aria-selected={false}
      data-testid="epic-sidebar-pending-create"
    >
      <div
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-ui-sm text-muted-foreground"
        style={{ paddingLeft: `${depth * INDENT_PX + BASE_PAD_LEFT}px` }}
      >
        <TreeChevronSpacer />
        <AgentSpinningDots
          className="shrink-0 text-muted-foreground/70"
          testId={undefined}
          variant={undefined}
        />
        <span>{name}</span>
      </div>
    </li>
  );
}

interface ChatNodeProps {
  epicId: string;
  tabId: string;
  nodeId: string;
  depth: number;
  expansion: ExpansionController;
  canEdit: boolean;
  canMutate: boolean;
  isDisconnected: boolean;
  treeFilter: TreeFilterFn;
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  onToggleSelection: (id: string) => void;
}

const ChatNode = memo(function ChatNode(props: ChatNodeProps) {
  const {
    epicId,
    tabId,
    nodeId,
    depth,
    expansion,
    canEdit,
    canMutate,
    isDisconnected,
    treeFilter,
    selectionMode,
    selectedIds,
    onToggleSelection,
  } = props;
  const { expandedIds, toggleExpanded } = expansion;
  const node = useEpicTreeNode(nodeId);
  const childIds = useFilteredPanelChildIds(nodeId, treeFilter);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const prepareOpenTilePreviewInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTilePreviewInTabFocusTarget,
  );
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );
  const promotePreviewInTab = useEpicCanvasStore((s) => s.promotePreviewInTab);
  const markArtifactSelfDeleted = useEpicCanvasStore(
    (s) => s.markArtifactSelfDeleted,
  );
  const unmarkArtifactSelfDeleted = useEpicCanvasStore(
    (s) => s.unmarkArtifactSelfDeleted,
  );
  const epicHandle = useOpenEpicHandle();

  const deleteChat = useEpicDeleteChat();
  const deleteTerminalAgent = useEpicDeleteTuiAgent();
  const renameChat = useEpicRenameChat();
  const renameTerminalAgent = useEpicRenameTuiAgent();
  const renameArtifactInTab = useEpicCanvasStore((s) => s.renameArtifactInTab);

  const liveRecords = useEpicArtifactRecords();

  const expanded = expandedIds.has(nodeId);
  const hasChildren = childIds.length > 0;
  const showChildren = hasChildren && expanded;
  const artifactType = node?.type ?? "chat";
  const nodeName = node?.title ?? "";
  // Trailing slot content at rest: a muted relative last-activity time, which
  // the archive/menu controls replace on hover. Read from the PROJECTION, not
  // `node.updatedAt` - the tree node is a lagging copy (see the selector's
  // doc), and using it made this row disagree with the hover card.
  const updatedAt = useEpicNodeUpdatedAt(nodeId);
  const openableType: OpenableEpicNodeKind | null = isOpenableEpicNodeKind(
    artifactType,
  )
    ? artifactType
    : null;
  // Per-node boolean subscription: re-renders this node only when ITS active
  // state flips, not on every selection.
  const isActive = useIsActiveEpicArtifact(tabId, nodeId);

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renamePending = anyMutationPending([
    renameChat.isPending,
    renameTerminalAgent.isPending,
  ]);

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const deletePending = anyMutationPending([
    deleteChat.isPending,
    deleteTerminalAgent.isPending,
  ]);

  const archiveSupported = useContext(SidebarArchiveSupportedContext);
  const isArchived = useEpicNodeArchived(nodeId);
  const archiveChat = useEpicArchiveChat();
  const toggleArchive = useCallback(() => {
    if (!canMutate || !archiveSupported) return;
    archiveChat.mutate({ epicId, chatId: nodeId, archived: !isArchived });
  }, [archiveChat, archiveSupported, canMutate, epicId, isArchived, nodeId]);
  const archivePending = archiveChat.isPending;
  const archiveRow = useMemo<ChatRowArchiveInputs>(
    () => ({
      supported: archiveSupported,
      isArchived,
      pending: archivePending,
      onToggle: toggleArchive,
    }),
    [archiveSupported, isArchived, archivePending, toggleArchive],
  );

  const activeHostId = useReactiveActiveHostId() ?? "unknown-host";
  // The tab must bind to the chat's OWNER host, not whichever host happens to
  // be active: a connected peer host's chat reaches this tree through the
  // shared projection, and binding it to the active host would open a tab
  // that asks the wrong machine for the transcript. Downstream already
  // honors the ref's hostId (`renderTile` wraps each ref in its own
  // `TabHostProvider`), so the owner id is all that was missing.
  const ownerHostId = useEpicNodeHostId(nodeId);
  const openHostId = ownerHostId ?? activeHostId;
  // Same rule the cloud rows follow (user ruling: offline hosts show as
  // readonly with a locked composer): a CHAT row whose owner host is
  // unreachable opens the published copy, not a live tab that dials a dead
  // host into a banner. Falls back to the live ref when the identity triple
  // cannot be built (no owner user on the record) - a click always opens
  // something.
  const ownerReachability = useHostReachability(
    ownerHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  );
  const ownerUserId = useEpicNodeOwnerUserId(nodeId);
  const opensPublishedCopy = chatRowOpensPublishedCopy({
    isChat: openableType === "chat",
    ownerHostId,
    ownerUserId,
    ownerIsUnreachable: ownerReachability.status === "unreachable",
  });
  const openRef = useCallback(
    () =>
      // The null re-checks below are for the COMPILER, not for the logic:
      // `chatRowOpensPublishedCopy` guarantees both are non-null whenever it
      // returns true, but that fact lives behind the function call where
      // TypeScript's narrowing cannot follow it.
      opensPublishedCopy && ownerHostId !== null && ownerUserId !== null
        ? makePublishedChatTileRef({
            taskId: epicId,
            chatId: nodeId,
            ownerUserId,
            ownerHostId,
            name: nodeName,
            hostId: activeHostId,
          })
        : {
            id: nodeId,
            type: openableType ?? "chat",
            name: nodeName,
            hostId: openHostId,
          },
    [
      opensPublishedCopy,
      ownerHostId,
      ownerUserId,
      epicId,
      nodeId,
      nodeName,
      activeHostId,
      openableType,
      openHostId,
    ],
  );

  const selectChatNode = useCallback(() => {
    if (isRenaming) return;
    if (openableType === null) return;
    navigateNested(epicId, tabId, () =>
      prepareOpenTilePreviewInTabFocusTarget(tabId, {
        ...openRef(),
        instanceId: uuidv4(),
      }),
    );
  }, [
    // No `nodeId` / `nodeName`: the tile ref is built inside `openRef`, which
    // closes over both and is itself a dependency.
    openRef,
    epicId,
    isRenaming,
    navigateNested,
    openableType,
    prepareOpenTilePreviewInTabFocusTarget,
    tabId,
  ]);

  const handleDoubleClick = useCallback(() => {
    if (isRenaming) return;
    if (openableType === null) return;
    const found = findOpenArtifactInTab(tabId, nodeId);
    if (found !== null) {
      navigateNested(epicId, tabId, () => {
        promotePreviewInTab(tabId, found.paneId);
        return {
          paneId: found.paneId,
          tileInstanceId: found.instanceId,
        };
      });
    } else {
      navigateNested(epicId, tabId, () =>
        prepareOpenTileInTabFocusTarget(tabId, {
          ...openRef(),
          instanceId: uuidv4(),
        }),
      );
    }
  }, [
    // `nodeId` stays - `findOpenArtifactInTab` reads it directly. `nodeName`
    // does not: it reaches the tile ref only through `openRef`.
    openRef,
    epicId,
    isRenaming,
    navigateNested,
    nodeId,
    openableType,
    prepareOpenTileInTabFocusTarget,
    promotePreviewInTab,
    tabId,
  ]);

  const handleToggle = useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      event.stopPropagation();
      toggleExpanded(nodeId);
    },
    [nodeId, toggleExpanded],
  );

  const startRename = useCallback(() => {
    if (!canMutate) return;
    setRenameValue(nodeName);
    setIsRenaming(true);
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  }, [canMutate, nodeName]);

  const commitRename = useCallback(() => {
    if (renamePending) return;
    const trimmed = renameValue.trim();
    if (trimmed.length === 0) {
      setIsRenaming(false);
      return;
    }
    if (trimmed === nodeName) {
      setIsRenaming(false);
      return;
    }
    epicHandle.store.getState().renameArtifact(nodeId, trimmed);
    renameArtifactInTab(tabId, nodeId, trimmed);
    if (artifactType === "chat") {
      renameChat.mutate(
        { epicId, chatId: nodeId, title: trimmed },
        {
          onSuccess: () => {
            setIsRenaming(false);
          },
        },
      );
    } else if (artifactType === "terminal-agent") {
      renameTerminalAgent.mutate(
        { epicId, tuiAgentId: nodeId, title: trimmed },
        {
          onSuccess: () => {
            setIsRenaming(false);
          },
        },
      );
    }
  }, [
    artifactType,
    epicHandle,
    epicId,
    nodeName,
    nodeId,
    renameArtifactInTab,
    renameChat,
    renameTerminalAgent,
    renamePending,
    renameValue,
    tabId,
  ]);

  const handleRenameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (renamePending) return;
      if (event.key === "Enter") {
        event.preventDefault();
        commitRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        setIsRenaming(false);
      }
    },
    [commitRename, renamePending],
  );

  const performDelete = () => {
    if (!canMutate) return;
    setConfirmDeleteOpen(true);
  };

  const confirmDelete = () => {
    epicHandle.store.getState().deleteArtifact(nodeId);
    markArtifactSelfDeleted(nodeId);
    const handleDeleteSuccess = () => {
      setConfirmDeleteOpen(false);
      const found = findOpenArtifactInTab(tabId, nodeId);
      if (found !== null) {
        navigateNested(epicId, tabId, () =>
          prepareCloseCanvasTabFocusTarget(
            tabId,
            found.paneId,
            found.instanceId,
          ),
        );
      }
    };
    const handleDeleteError = () => {
      unmarkArtifactSelfDeleted(nodeId);
    };
    if (artifactType === "chat") {
      deleteChat.mutate(
        { epicId, chatId: nodeId },
        { onSuccess: handleDeleteSuccess, onError: handleDeleteError },
      );
    } else if (artifactType === "terminal-agent") {
      deleteTerminalAgent.mutate(
        { epicId, tuiAgentId: nodeId },
        { onSuccess: handleDeleteSuccess, onError: handleDeleteError },
      );
    }
  };

  if (node === null) return null;
  if (!treeFilter(node.type)) return null;

  const cascadeCounts = computeDescendantCounts(liveRecords, nodeId);
  const cascadeSummary = formatCascadeSummary(cascadeCounts);
  const rowClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (selectionMode || event.ctrlKey || event.metaKey) {
      event.preventDefault();
      onToggleSelection(nodeId);
      return;
    }
    selectChatNode();
  };
  const rowDoubleClick = selectionMode ? noopRowAction : handleDoubleClick;

  return (
    <ChatNodeShell
      epicId={epicId}
      tabId={tabId}
      nodeId={nodeId}
      ownerHostId={ownerHostId}
      nodeName={nodeName}
      artifactType={artifactType}
      depth={depth}
      expansion={expansion}
      childIds={childIds}
      hasChildren={hasChildren}
      expanded={expanded}
      showChildren={showChildren}
      isActive={isActive}
      canEdit={canEdit}
      canMutate={canMutate}
      isDisconnected={isDisconnected}
      updatedAt={updatedAt}
      openableType={openableType}
      isRenaming={isRenaming}
      renameInputRef={renameInputRef}
      renameValue={renameValue}
      onRenameValueChange={setRenameValue}
      onCommitRename={commitRename}
      onRenameKeyDown={handleRenameKeyDown}
      renamePending={renamePending}
      onToggle={handleToggle}
      onClick={rowClick}
      onDoubleClick={rowDoubleClick}
      treeFilter={treeFilter}
      onStartRename={startRename}
      onPerformDelete={performDelete}
      confirmDeleteOpen={confirmDeleteOpen}
      onConfirmDeleteOpenChange={setConfirmDeleteOpen}
      cascadeSummary={cascadeSummary}
      deletePending={deletePending}
      onConfirmDelete={confirmDelete}
      archive={archiveRow}
      selectionMode={selectionMode}
      isSelected={selectedIds.has(nodeId)}
      selectedIds={selectedIds}
      onToggleSelection={onToggleSelection}
    />
  );
});

interface ChatNodeShellProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly nodeId: string;
  /** The row's OWN owner host, resolved once in `ChatNode` and threaded down
   *  so the leading icon and the archive affordances read the same session. */
  readonly ownerHostId: string | null;
  readonly nodeName: string;
  readonly artifactType: EpicNodeKind;
  readonly depth: number;
  readonly expansion: ExpansionController;
  readonly childIds: readonly string[];
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly showChildren: boolean;
  readonly isActive: boolean;
  readonly canEdit: boolean;
  readonly canMutate: boolean;
  readonly isDisconnected: boolean;
  readonly updatedAt: number;
  readonly openableType: OpenableEpicNodeKind | null;
  readonly isRenaming: boolean;
  readonly renameInputRef: React.RefObject<HTMLInputElement | null>;
  readonly renameValue: string;
  readonly onRenameValueChange: (value: string) => void;
  readonly onCommitRename: () => void;
  readonly onRenameKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly renamePending: boolean;
  readonly onToggle: (event: React.MouseEvent<HTMLSpanElement>) => void;
  readonly onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  readonly onDoubleClick: () => void;
  readonly onStartRename: () => void;
  readonly onPerformDelete: () => void;
  readonly confirmDeleteOpen: boolean;
  readonly onConfirmDeleteOpenChange: (open: boolean) => void;
  readonly cascadeSummary: string | null;
  readonly deletePending: boolean;
  readonly onConfirmDelete: () => void;
  readonly archive: ChatRowArchiveInputs;
  readonly treeFilter: TreeFilterFn;
  readonly selectionMode: boolean;
  readonly isSelected: boolean;
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggleSelection: (id: string) => void;
}

/**
 * Archive state for a row whose host does not support the method. A frozen
 * module constant so the non-archivable branch allocates nothing per row.
 */
const CHAT_ROW_ARCHIVE_ABSENT: ChatRowArchiveDecision = Object.freeze({
  entry: null,
  showButton: false,
});

/**
 * Hookless dispatcher. Its only job is to keep `useChatRowOwnStatusKind` -
 * which costs an indicator read, an awareness read, a session-handle lookup and
 * two store subscriptions PER ROW - off every row whose host cannot archive
 * anyway. Hooks cannot be called conditionally, so the condition has to be a
 * component boundary.
 *
 * This matters most exactly when the feature is newest: until the host RPC
 * ships, NO host advertises the method, so without this split every row in
 * every sidebar would pay for a status resolution that is then discarded. It
 * also preserves T1's constraint that the open-chat session read is "paid by
 * those few rows rather than by every row".
 */
function ChatNodeShell(props: ChatNodeShellProps) {
  if (props.archive.supported) return <ChatNodeShellArchivable {...props} />;
  return <ChatNodeShellBody {...props} decision={CHAT_ROW_ARCHIVE_ABSENT} />;
}

/** The archive-capable arm: resolves the row's status kind, then renders. */
function ChatNodeShellArchivable(props: ChatNodeShellProps) {
  // Resolved once per row and used by both archive affordances, so the hover
  // button and the menu entry can never disagree about whether this row is
  // busy. Same lattice the leading status icon renders from.
  const status = useChatRowOwnStatusKind({
    epicId: props.epicId,
    nodeId: props.nodeId,
    ownerHostId: props.ownerHostId,
    artifactType: props.artifactType,
  });
  return (
    <ChatNodeShellBody
      {...props}
      decision={chatRowArchiveState({
        canMutate: props.canMutate,
        isArchived: props.archive.isArchived,
        archivePending: props.archive.pending,
        status,
        selectionMode: props.selectionMode,
        isRenaming: props.isRenaming,
        hasChildren: props.hasChildren,
        expanded: props.expanded,
      })}
    />
  );
}

function ChatNodeShellBody(
  props: ChatNodeShellProps & { readonly decision: ChatRowArchiveDecision },
) {
  const shouldReduceMotion = useReducedMotion() === true;
  const {
    epicId,
    tabId,
    nodeId,
    ownerHostId,
    nodeName,
    artifactType,
    depth,
    expansion,
    childIds,
    hasChildren,
    expanded,
    showChildren,
    isActive,
    canEdit,
    canMutate,
    isDisconnected,
    updatedAt,
    isRenaming,
    renameInputRef,
    renameValue,
    onRenameValueChange,
    onCommitRename,
    onRenameKeyDown,
    renamePending,
    onToggle,
    onClick,
    onDoubleClick,
    onStartRename,
    onPerformDelete,
    confirmDeleteOpen,
    onConfirmDeleteOpenChange,
    cascadeSummary,
    deletePending,
    onConfirmDelete,
    archive: archiveRow,
    treeFilter,
    selectionMode,
    isSelected,
    selectedIds,
    onToggleSelection,
  } = props;

  // "New child agent" opens the shared New Conversation modal seeded with this
  // row as the parent - the same action the standalone hover "+" used to
  // trigger, now consolidated into the row menu (right-click + ⋯) so there is a
  // single hover affordance. It preserves the modal's remembered interface,
  // matching the top-level new-agent trigger.
  const openNewConversationModal = useNewConversationModalOpenStore(
    (state) => state.open,
  );
  const handleNewChildAgent = useCallback(() => {
    if (!canMutate) return;
    openNewConversationModal({
      epicId,
      tabId,
      placement: ACTIVE_TILE_PLACEMENT,
      parentId: nodeId,
      // Sidebar row: app-wide surface, so the child lands on the active host
      // exactly like the panel's own `+`.
      hostId: null,
    });
  }, [canMutate, epicId, nodeId, openNewConversationModal, tabId]);
  const { decision } = props;
  const rowMenuEntries = chatRowMenuEntries({
    nodeId,
    canMutate,
    archiveEntry: decision.entry,
    onNewChildAgent: handleNewChildAgent,
    onStartRename,
    onToggleArchive: archiveRow.onToggle,
    onPerformDelete,
  });

  return (
    <m.li
      layout={shouldReduceMotion ? false : "position"}
      exit={shouldReduceMotion ? undefined : { opacity: 0, x: -8 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      role="treeitem"
      aria-selected={isActive}
      aria-expanded={hasChildren ? expanded : undefined}
    >
      <SidebarReparentRowDropWrapper
        epicId={epicId}
        viewTabId={tabId}
        nodeId={nodeId}
        panelId="chats"
        contextMenu={
          canEdit && !isRenaming && !selectionMode ? (
            <ContextMenuContent>
              <SidebarContextMenuItems entries={rowMenuEntries} />
            </ContextMenuContent>
          ) : null
        }
      >
        {isRenaming ? (
          <ChatRenameRow
            epicId={epicId}
            depth={depth}
            ownerHostId={ownerHostId}
            artifactType={artifactType}
            renameInputRef={renameInputRef}
            renameValue={renameValue}
            onRenameValueChange={onRenameValueChange}
            onBlur={onCommitRename}
            onKeyDown={onRenameKeyDown}
            renamePending={renamePending}
            nodeName={nodeName}
            nodeId={nodeId}
            isArchived={archiveRow.isArchived}
          />
        ) : (
          <ChatRowButton
            epicId={epicId}
            viewTabId={tabId}
            nodeId={nodeId}
            nodeName={nodeName}
            artifactType={artifactType}
            depth={depth}
            isActive={isActive}
            canEdit={canEdit}
            updatedAt={updatedAt}
            hasChildren={hasChildren}
            expanded={expanded}
            onToggle={onToggle}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            selectionMode={selectionMode}
            isSelected={isSelected}
            onToggleSelection={onToggleSelection}
            isArchived={archiveRow.isArchived}
            reserveArchiveSlot={decision.showButton}
          />
        )}

        {decision.showButton ? (
          <ChatRowArchiveButton
            nodeId={nodeId}
            nodeName={nodeName}
            isArchived={archiveRow.isArchived}
            pending={archiveRow.pending}
            onToggle={archiveRow.onToggle}
          />
        ) : null}

        {canEdit && !isRenaming && !selectionMode ? (
          <ChatMoreMenu
            nodeId={nodeId}
            nodeName={nodeName}
            entries={rowMenuEntries}
          />
        ) : null}
      </SidebarReparentRowDropWrapper>
      <ChatNodeChildren
        visible={showChildren}
        childIds={childIds}
        epicId={epicId}
        tabId={tabId}
        depth={depth}
        expansion={expansion}
        canEdit={canEdit}
        canMutate={canMutate}
        isDisconnected={isDisconnected}
        treeFilter={treeFilter}
        selectionMode={selectionMode}
        selectedIds={selectedIds}
        onToggleSelection={onToggleSelection}
      />
      <ConfirmDestructiveDialog
        open={confirmDeleteOpen}
        onOpenChange={onConfirmDeleteOpenChange}
        title={`Delete ${EPIC_NODE_SENTENCE_NOUNS[artifactType]} "${nodeName}"?`}
        description="This action cannot be undone."
        cascadeSummary={cascadeSummary}
        actionLabel="Delete"
        isPending={deletePending}
        onConfirm={onConfirmDelete}
      />
    </m.li>
  );
}

interface NodeChevronProps {
  hasChildren: boolean;
  expanded: boolean;
  onToggle: (event: React.MouseEvent<HTMLSpanElement>) => void;
}

function NodeChevron(props: NodeChevronProps) {
  const { hasChildren, expanded, onToggle } = props;
  if (!hasChildren) return <TreeChevronSpacer />;
  return <TreeChevron expanded={expanded} onToggle={onToggle} />;
}

interface ChatNodeChildrenProps {
  visible: boolean;
  childIds: readonly string[];
  epicId: string;
  tabId: string;
  depth: number;
  expansion: ExpansionController;
  canEdit: boolean;
  canMutate: boolean;
  isDisconnected: boolean;
  treeFilter: TreeFilterFn;
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  onToggleSelection: (id: string) => void;
}

function ChatNodeChildren(props: ChatNodeChildrenProps) {
  if (!props.visible) return null;
  return (
    <ul role="group" className="relative space-y-0.5">
      <TreeGroupGuide parentDepth={props.depth} />
      <AnimatePresence initial={false}>
        {props.childIds.map((childId) => (
          <ChatNode
            key={childId}
            epicId={props.epicId}
            tabId={props.tabId}
            nodeId={childId}
            depth={props.depth + 1}
            expansion={props.expansion}
            canEdit={props.canEdit}
            canMutate={props.canMutate}
            isDisconnected={props.isDisconnected}
            treeFilter={props.treeFilter}
            selectionMode={props.selectionMode}
            selectedIds={props.selectedIds}
            onToggleSelection={props.onToggleSelection}
          />
        ))}
      </AnimatePresence>
    </ul>
  );
}

function SidebarRowCheckbox(props: {
  readonly inputId: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly isSelected: boolean;
  readonly onToggleSelection: (id: string) => void;
}) {
  const { inputId, nodeId, nodeName, isSelected, onToggleSelection } = props;
  return (
    <span className="relative flex size-4 shrink-0">
      <input
        id={inputId}
        type="checkbox"
        checked={isSelected}
        aria-label={`Select ${nodeName}`}
        data-testid={`epic-sidebar-select-${nodeId}`}
        className="peer absolute inset-0 m-0 size-4 cursor-pointer opacity-0"
        onChange={() => {
          onToggleSelection(nodeId);
        }}
      />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none flex size-4 items-center justify-center rounded-sm border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50",
          isSelected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background text-transparent peer-hover:border-foreground",
        )}
      >
        <Check className="size-3" />
      </span>
    </span>
  );
}

/**
 * Fixed-size slot the leading icon renders into, so every row's text column
 * starts at the same x regardless of which variant (chat glyph, harness brand
 * + terminal subscript, spinner, bot) fills it. Sized to the widest variant -
 * `SidebarAgentHarnessIcon`, whose subscript overhangs the 14px brand mark.
 *
 * The slot is only a WIDTH reservation: it carries no vertical alignment of
 * its own. Centering across the two-line card is the outer row's job
 * (`items-center`), which is why the slot must not grow to the card's height.
 */
function ChatRowLeadingIconSlot(props: { readonly children: ReactNode }) {
  return (
    // NOT `aria-hidden`. This slot was hidden while a trailing status chip
    // existed, because the two announced the same state and a read-only row
    // said "Read-only agent" twice. The row now carries no trailing chip, so
    // this icon is the row's ONLY status surface (`ChatProgressIcon` for chats,
    // the spinner / rollup for agents) - hiding it would drop running,
    // approval, failure, and read-only from the a11y tree entirely rather than
    // de-duplicating them. The status elements inside own their own
    // `role="status"` and accessible names; nothing here is focusable.
    <span className="inline-flex h-3.5 w-[1.125rem] shrink-0 items-center">
      {props.children}
    </span>
  );
}

/**
 * Leading icon for a sidebar row - the row's single status surface now that no
 * trailing chip exists. A COLLAPSED PARENT resolves its hidden descendants'
 * rollup here too: that rollup used to live in the trailing slot, and dropping
 * the slot without rehoming it would leave a failure inside a collapsed subtree
 * with nowhere to surface.
 */
function ChatRowLeadingIcon(props: {
  readonly epicId: string;
  readonly nodeId: string;
  /** The row's OWN owner host, off its projection row - see
   *  {@link ChatRowOwnLeadingIcon}. */
  readonly ownerHostId: string | null;
  readonly artifactType: EpicNodeKind;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}) {
  if (props.hasChildren && !props.expanded) {
    return (
      <ChatRowLeadingIconWithNestedRollup
        epicId={props.epicId}
        nodeId={props.nodeId}
        ownerHostId={props.ownerHostId}
        artifactType={props.artifactType}
      />
    );
  }
  return (
    <ChatRowOwnLeadingIcon
      epicId={props.epicId}
      nodeId={props.nodeId}
      ownerHostId={props.ownerHostId}
      artifactType={props.artifactType}
    />
  );
}

/**
 * Leading slot for a collapsed parent. Merges the parent's own status with the
 * hidden descendants' rollup on the shared ladder: the more urgent one owns the
 * slot, ties go to the parent - so a hidden failure can never sit invisible
 * behind a parent that is merely running. When the parent's own status wins it
 * renders the same icon a leaf row shows. Mounted only for collapsed parents,
 * so rows without a rollup carry none of these subscriptions.
 */
const ChatRowLeadingIconWithNestedRollup = memo(
  function ChatRowLeadingIconWithNestedRollup(props: {
    readonly epicId: string;
    readonly nodeId: string;
    readonly ownerHostId: string | null;
    readonly artifactType: EpicNodeKind;
  }) {
    const rollup = useChatDescendantStatus({
      epicId: props.epicId,
      nodeId: props.nodeId,
    });
    const activityTiers = useEpicAgentActivityTiers();
    const selfIndicator = useSurfaceNotificationIndicatorState(
      { epicId: props.epicId, chatId: props.nodeId },
      null,
    );
    if (rollup !== null) {
      const selfTier = activityTiers.get(props.nodeId);
      // Chat and terminal-agent parents rank alike: a TUI agent's
      // `agent.stopped` notifications are chat-scoped to its id, so its
      // indicator entry is as real as a chat's.
      const selfRank = chatSelfStatusRank(selfIndicator, selfTier);
      if (CHAT_STATUS_RANKS[rollup.kind] > selfRank) {
        return <NestedChatStatusIcon nodeId={props.nodeId} rollup={rollup} />;
      }
    }
    return (
      <ChatRowOwnLeadingIcon
        epicId={props.epicId}
        nodeId={props.nodeId}
        ownerHostId={props.ownerHostId}
        artifactType={props.artifactType}
      />
    );
  },
);

/**
 * A row's OWN identity/status glyph, ignoring any descendants. Chat rows get
 * the status-aware chat glyph, TUI rows the harness brand, and any other node
 * kind its static registry glyph.
 */
function ChatRowOwnLeadingIcon(props: {
  readonly epicId: string;
  readonly nodeId: string;
  /**
   * The row's OWN owner host, read off its projection row rather than from a
   * tab binding: a sidebar row is not inside any `TabHostProvider`, and the
   * tree deliberately lists chats owned by connected PEER hosts alongside
   * this machine's. `chatId` is host-minted, so without the row's own host the
   * status read could land on a same-id chat living on a different machine.
   */
  readonly ownerHostId: string | null;
  readonly artifactType: EpicNodeKind;
}) {
  if (props.artifactType === "chat") {
    // No idle-slot override: `ChatProgressIcon` falls back to the plain chat
    // glyph (per-type icon color included) and stays authoritative for
    // read-only, activity, approval, failure, and completion states. Chat rows
    // deliberately do NOT wear the harness brand - a column of multi-colored
    // provider marks reads as noise; the harness is surfaced in the row's
    // tooltip, header, and composer instead.
    return (
      <ChatProgressIcon
        epicId={props.epicId}
        chatId={props.nodeId}
        hostId={props.ownerHostId}
        className={undefined}
        mutedClassName="text-muted-foreground/70"
        testId="chat-sidebar-spinner"
        defaultIcon={undefined}
      />
    );
  }
  if (props.artifactType === "terminal-agent") {
    return (
      <TerminalAgentProgressIcon epicId={props.epicId} nodeId={props.nodeId} />
    );
  }
  return <StaticSidebarNodeIcon artifactType={props.artifactType} />;
}

/**
 * Terminal-agent (TUI) sidebar icon. Routed through the shared
 * `NotificationIndicatorIcon` exactly like the chat row and the canvas TUI tab,
 * so notification status (failure / unread-done) outranks live activity and the
 * harness brand mark holds the idle slot. A TUI agent's `agent.stopped` rows are
 * chat-scoped to its agent id, so it carries indicator state of its own; there
 * is still no renderer run-status to smooth against and no waiting-for-approval
 * state to style, so epic-wide awareness remains the sole RUN authority.
 *
 * The awareness TIER splits that running arm in two, exactly as the chat icon
 * and the descendant rollup already do. Without it a TUI agent kept non-idle by
 * a scheduled wakeup wore the busy spinner, and - worse - disagreed with its own
 * parent, whose collapsed rollup rendered the calm background glyph for the same
 * agent. The trailing status chip used to carry this split; it went away with
 * the row redesign, and the split has to land somewhere.
 */
function TerminalAgentProgressIcon(props: {
  readonly epicId: string;
  readonly nodeId: string;
}) {
  const isActive = useEpicActiveAgentIds().has(props.nodeId);
  const tier = useEpicAgentActivityTiers().get(props.nodeId);
  const harnessId = useMaybeEpicTuiAgentHarnessId(props.nodeId);
  const icon = useNodeIconDisplay("terminal-agent");
  const indicatorState = useSurfaceNotificationIndicatorState(
    { epicId: props.epicId, chatId: props.nodeId },
    null,
  );
  // The underlying harness's brand mark (Claude, Codex, …) so the row reads
  // as the tool driving the agent. Brand marks keep their own colors and
  // intentionally don't follow the per-type icon-color customization; the
  // generic bot glyph is the fallback for unresolved/legacy records.
  const idleIcon =
    harnessId !== null ? (
      <SidebarAgentHarnessIcon nodeId={props.nodeId} harnessId={harnessId} />
    ) : (
      <StaticSidebarNodeIcon artifactType="terminal-agent" />
    );
  return (
    <NotificationIndicatorIcon
      state={indicatorState}
      running={isActive ? (tier ?? "turn") : false}
      subjectId={props.nodeId}
      testIdPrefix="terminal-agent-sidebar"
      className={icon.className}
      style={icon.style}
      runningTitle="Agent in progress"
      defaultIcon={idleIcon}
      statusPresentation="message"
    />
  );
}

/**
 * TUI-agent harness identity with a terminal surface mark. The brand mark is a
 * TUI-only affordance - GUI chat rows keep the plain chat glyph - so the bare
 * terminal glyph rides along without a background, keeping the harness mark
 * visible beneath it.
 */
function SidebarAgentHarnessIcon(props: {
  readonly nodeId: string;
  readonly harnessId: ProviderId;
}) {
  const TerminalIcon = EPIC_NODE_ICONS.terminal;
  const tuiAgent = useEpicStore((state) =>
    Object.hasOwn(state.tuiAgents.byId, props.nodeId)
      ? state.tuiAgents.byId[props.nodeId]
      : null,
  );
  const managedProfileId = tuiAgent?.profileId ?? null;
  return (
    <TooltipWrapper
      label="TUI terminal agent"
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        data-testid={`sidebar-agent-harness-${props.nodeId}`}
        data-agent-surface="tui"
        className="relative inline-flex h-3.5 w-[1.125rem] shrink-0 items-center"
      >
        {managedProfileId === null ? (
          <ProfileBadgedHarnessIcon
            harnessId={props.harnessId}
            harnessName={props.harnessId}
            profileAccentDot={null}
            iconClassName="size-3.5"
            className={undefined}
            testId={`sidebar-agent-profile-mark-${props.nodeId}`}
          />
        ) : (
          <ManagedProfileSidebarHarnessIcon
            nodeId={props.nodeId}
            harnessId={props.harnessId}
            hostId={tuiAgent?.hostId ?? null}
            profileId={managedProfileId}
          />
        )}
        <TerminalIcon
          aria-hidden="true"
          data-testid={`sidebar-agent-surface-${props.nodeId}`}
          data-agent-surface="tui"
          className="pointer-events-none absolute -top-1.5 -right-1 size-2 text-muted-foreground"
          strokeWidth={3}
        />
      </span>
    </TooltipWrapper>
  );
}

function ManagedProfileSidebarHarnessIcon(props: {
  readonly nodeId: string;
  readonly harnessId: ProviderId;
  readonly hostId: string | null;
  readonly profileId: string;
}) {
  const hostClient = useHostClientForHostId(props.hostId);
  const providersList = useProvidersListForClient(hostClient, {
    enabled: true,
    subscribed: true,
  });
  const profiles = harnessProfiles(
    providersList.data?.providers ?? null,
    props.harnessId,
  );
  return (
    <ProfileBadgedHarnessIcon
      harnessId={props.harnessId}
      harnessName={props.harnessId}
      profileAccentDot={resolveProfileAccentDot(props.profileId, profiles)}
      iconClassName="size-3.5"
      className={undefined}
      testId={`sidebar-agent-profile-mark-${props.nodeId}`}
    />
  );
}

function StaticSidebarNodeIcon(props: { readonly artifactType: EpicNodeKind }) {
  const icon = useNodeIconDisplay(props.artifactType);
  const Icon = EPIC_NODE_ICONS[props.artifactType];
  return <Icon aria-hidden className={icon.className} style={icon.style} />;
}

interface ChatRenameRowProps {
  readonly epicId: string;
  readonly depth: number;
  readonly ownerHostId: string | null;
  readonly artifactType: EpicNodeKind;
  readonly renameInputRef: React.RefObject<HTMLInputElement | null>;
  readonly renameValue: string;
  readonly onRenameValueChange: (value: string) => void;
  readonly onBlur: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly renamePending: boolean;
  readonly nodeName: string;
  readonly nodeId: string;
  readonly isArchived: boolean;
}

function ChatRenameRow(props: ChatRenameRowProps) {
  const {
    epicId,
    depth,
    ownerHostId,
    artifactType,
    renameInputRef,
    renameValue,
    onRenameValueChange,
    onBlur,
    onKeyDown,
    renamePending,
    nodeName,
    nodeId,
  } = props;
  // Scaffold parity with the display row: the same chevron spacer and leading
  // icon sit centered beside a column whose single line is the rename input, so
  // nothing shifts horizontally or vertically between viewing and renaming.
  return (
    <div
      className={cn(
        "flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1",
        props.isArchived && ARCHIVED_ROW_CLASS,
      )}
      style={{
        paddingLeft: `${depth * INDENT_PX + BASE_PAD_LEFT}px`,
      }}
    >
      <TreeChevronSpacer />
      <ChatRowLeadingIconSlot>
        {/* Deliberately the OWN-status variant, not the rollup-aware one: the
            pre-refactor rename row rendered a non-rollup icon slot, so renaming
            keeps showing this row's own status rather than a descendant's. */}
        <ChatRowOwnLeadingIcon
          epicId={epicId}
          nodeId={nodeId}
          ownerHostId={ownerHostId}
          artifactType={artifactType}
        />
      </ChatRowLeadingIconSlot>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => {
              onRenameValueChange(e.target.value);
            }}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            disabled={renamePending}
            className="min-w-0 flex-1 border-0 bg-transparent text-ui-sm text-foreground outline-none focus:ring-1 focus:ring-ring rounded px-1"
            aria-label={`Rename ${nodeName}`}
            data-testid={`epic-sidebar-rename-input-${nodeId}`}
          />
          {renamePending ? (
            <AgentSpinningDots
              className="shrink-0 text-muted-foreground"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface ChatRowButtonProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly artifactType: EpicNodeKind;
  readonly depth: number;
  readonly isActive: boolean;
  readonly canEdit: boolean;
  readonly updatedAt: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly onToggle: (event: React.MouseEvent<HTMLSpanElement>) => void;
  readonly onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  readonly onDoubleClick: () => void;
  readonly selectionMode: boolean;
  readonly isSelected: boolean;
  readonly onToggleSelection: (id: string) => void;
  readonly isArchived: boolean;
  /**
   * Whether the row must reserve hover pad-right for a SECOND trailing control
   * (the archive button) beside the "..." trigger, so the title truncates
   * clear of both instead of running underneath.
   */
  readonly reserveArchiveSlot: boolean;
}

/**
 * Dimming for an archived row included by the selected visibility mode or by
 * the narrow open/activity/unread exception in the default view.
 */
const ARCHIVED_ROW_CLASS = "opacity-55";

/**
 * Whether a chat row's click opens the published copy instead of a live tab.
 *
 * ONE predicate for the two components that must agree on the answer:
 * `ChatNode` builds the tile ref from it and `ChatRowButton` renders the lock
 * (and its "opens read-only" tooltip) from it. They started as two inlined
 * copies and drifted - the button showed the lock for a record with no owner
 * user while the click fell back to a live ref, promising a read-only copy and
 * then dialing the dead host - so the decision lives here and both read it.
 */
function chatRowOpensPublishedCopy(input: {
  readonly isChat: boolean;
  readonly ownerHostId: string | null;
  readonly ownerUserId: string | null;
  readonly ownerIsUnreachable: boolean;
}): boolean {
  return (
    input.isChat &&
    input.ownerHostId !== null &&
    input.ownerUserId !== null &&
    input.ownerIsUnreachable
  );
}

/**
 * The row button's accessible name. Its explicit `aria-label` replaces the
 * subtree as the name, so every state a glyph inside the row shows visually
 * (archived prefix, offline lock) has to be restated here or a keyboard /
 * screen-reader user never receives it - the lock's tooltip is hover-or-focus
 * on a trigger that is not focusable.
 */
function chatRowAriaLabel(input: {
  readonly nodeName: string;
  readonly isArchived: boolean;
  readonly offlineHostLabel: string | null;
}): string {
  const stateSuffix = [
    input.isArchived ? "archived" : null,
    input.offlineHostLabel !== null
      ? `on ${input.offlineHostLabel}, offline, opens read-only`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  return stateSuffix.length > 0
    ? `${input.nodeName}, ${stateSuffix}`
    : input.nodeName;
}

// Only chats and terminal-agents own a resource-tracked process tree; other
// node kinds (specs, tickets, …) never carry a resource snapshot.
function resourceOwnerKindForNode(
  artifactType: EpicNodeKind,
): ResourceOwnerKindWire | null {
  if (artifactType === "chat") return "chat";
  if (artifactType === "terminal-agent") return "terminal-agent";
  return null;
}

function AgentRoleBadgesForOwner(props: {
  readonly ownerKind: ResourceOwnerKindWire | null;
  readonly claims: readonly RoleClaim[];
}) {
  if (props.ownerKind === null) return null;
  return <AgentRoleBadges claims={props.claims} />;
}

/**
 * The row's own class list, lifted out of {@link ChatRowButton} so its five
 * state modifiers stop counting against that component's complexity ceiling.
 * Pure and unchanged - same operands, same order.
 *
 * `min-h-7` is a FLOOR, not a height: the row is a horizontal flex - chevron,
 * leading icon, then the text column - and `items-center` centers the short
 * children against whatever height the column takes. Kept as a floor rather
 * than a fixed height so a row whose title wraps, or which regains a second
 * line, grows instead of clipping.
 */
function chatRowClassName(state: {
  readonly isDragging: boolean;
  readonly showRowControls: boolean;
  readonly reserveArchiveSlot: boolean;
  readonly selectionMode: boolean;
  readonly isArchived: boolean;
  readonly isActive: boolean;
}): string {
  return cn(
    "flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left text-ui-sm font-normal transition-colors",
    "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
    state.isDragging && "cursor-grabbing opacity-60",
    nodePadRightClass(state.showRowControls, state.reserveArchiveSlot),
    state.selectionMode && "cursor-pointer",
    state.isArchived && ARCHIVED_ROW_CLASS,
    state.isActive
      ? "bg-accent text-accent-foreground"
      : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
  );
}

function ChatRowButton(props: ChatRowButtonProps) {
  const {
    epicId,
    viewTabId,
    nodeId,
    nodeName,
    artifactType,
    depth,
    isActive,
    canEdit,
    updatedAt,
    hasChildren,
    expanded,
    onToggle,
    onClick,
    onDoubleClick,
    selectionMode,
    isSelected,
    onToggleSelection,
    isArchived,
    reserveArchiveSlot,
  } = props;
  const resourceOwnerKind = resourceOwnerKindForNode(artifactType);
  const roleClaims = useEpicAgentRoleClaims(nodeId);
  const ownerHostId = useEpicNodeHostId(nodeId);
  const activeHostId = useReactiveActiveHostId();
  const sourceHostId = ownerHostId ?? activeHostId;
  // Same lock the cloud rows carry, driven by the same signal: a CHAT row
  // whose owner host is unreachable is readonly here (its click opens the
  // published copy), and the row must say so before the click. State, not
  // provenance - reachable-owner rows stay lock-free whatever host they
  // live on. The SAME predicate `ChatNode` builds the click's ref from, so
  // the lock can never promise a published copy the click will not open.
  const ownerReachability = useHostReachability(
    ownerHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  );
  const rowOwnerUserId = useEpicNodeOwnerUserId(nodeId);
  const showUnreachableLock = chatRowOpensPublishedCopy({
    isChat: artifactType === "chat",
    ownerHostId,
    ownerUserId: rowOwnerUserId,
    ownerIsUnreachable: ownerReachability.status === "unreachable",
  });
  const dragData = useMemo<EpicCanvasSidebarNodeDragData | null>(
    () =>
      sourceHostId === null
        ? null
        : {
            kind: SIDEBAR_NODE_DND_TYPE,
            epicId,
            viewTabId,
            hostId: sourceHostId,
            nodeId,
          },
    [epicId, nodeId, sourceHostId, viewTabId],
  );
  const {
    attributes,
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getPaneScopedDndId(viewTabId, getSidebarNodeDragId(nodeId)),
    disabled: selectionMode || dragData === null,
    data: dragData ?? undefined,
  });
  const selectionChevronToggle = useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      event.preventDefault();
      onToggle(event);
    },
    [onToggle],
  );
  const showNavigatorResourceStats = useSettingsStore(
    (state) => state.showNavigatorResourceStats,
  );
  const ownerKind = useEpicNodeOwnerKind(nodeId);

  // Only the "⋯" more menu now reveals on hover (the standalone "+" moved into
  // that menu as "New child agent"), so the single-control pad-right reserve is
  // claimed whenever the row is editable and not bulk-selecting.
  const showRowControls = selectionMode ? false : canEdit;
  const rowClassName = chatRowClassName({
    isDragging,
    showRowControls,
    reserveArchiveSlot,
    selectionMode,
    isArchived,
    isActive,
  });
  const selectionInputId = `epic-sidebar-select-input-${nodeId}`;
  if (selectionMode) {
    const selectionRow = (
      <label
        htmlFor={selectionInputId}
        ref={dragRef}
        data-testid={`epic-sidebar-item-${nodeId}`}
        data-artifact-type={artifactType}
        className={rowClassName}
        style={{
          paddingLeft: `${depth * INDENT_PX + BASE_PAD_LEFT}px`,
        }}
      >
        <NodeChevron
          hasChildren={hasChildren}
          expanded={expanded}
          onToggle={selectionChevronToggle}
        />
        <SidebarRowCheckbox
          inputId={selectionInputId}
          nodeId={nodeId}
          nodeName={nodeName}
          isSelected={isSelected}
          onToggleSelection={onToggleSelection}
        />
        <ChatRowLeadingIconSlot>
          <ChatRowLeadingIcon
            epicId={epicId}
            nodeId={nodeId}
            ownerHostId={ownerHostId}
            artifactType={artifactType}
            hasChildren={hasChildren}
            expanded={expanded}
          />
        </ChatRowLeadingIconSlot>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {isArchived ? <ArchivedTitlePrefix /> : null}
            <span className="min-w-0 flex-1 truncate">{nodeName}</span>
            <AgentRoleBadgesForOwner
              ownerKind={resourceOwnerKind}
              claims={roleClaims}
            />
          </span>
        </span>
      </label>
    );
    // No owner metadata while bulk-selecting, so this reduces to the role
    // tooltip - the same one this branch rendered inline before.
    return (
      <AgentHoverTooltip
        trigger={selectionRow}
        epicId={epicId}
        nodeId={nodeId}
        nodeName={nodeName}
        hostId={null}
        ownerKind={null}
        roleClaims={roleClaims}
        side="right"
      />
    );
  }

  const button = (
    <button
      ref={dragRef}
      {...attributes}
      {...listeners}
      type="button"
      // Explicit, so the row's accessible name is its title plus archive state
      // rather than a concatenation of every resource chip and timestamp.
      aria-label={chatRowAriaLabel({
        nodeName,
        isArchived,
        offlineHostLabel: showUnreachableLock
          ? ownerReachability.hostLabel
          : null,
      })}
      data-testid={`epic-sidebar-item-${nodeId}`}
      data-artifact-type={artifactType}
      className={rowClassName}
      style={{
        paddingLeft: `${depth * INDENT_PX + BASE_PAD_LEFT}px`,
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <NodeChevron
        hasChildren={hasChildren}
        expanded={expanded}
        onToggle={onToggle}
      />
      <ChatRowLeadingIconSlot>
        <ChatRowLeadingIcon
          epicId={epicId}
          nodeId={nodeId}
          ownerHostId={ownerHostId}
          artifactType={artifactType}
          hasChildren={hasChildren}
          expanded={expanded}
        />
      </ChatRowLeadingIconSlot>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          {isArchived ? <ArchivedTitlePrefix /> : null}
          <span className="min-w-0 flex-1 truncate">{nodeName}</span>
          {showUnreachableLock ? (
            <TooltipWrapper
              label={`Lives on ${ownerReachability.hostLabel}, which is offline. Opens read-only from the last published copy.`}
              side="right"
              sideOffset={undefined}
              align={undefined}
            >
              <Lock
                className="size-3 shrink-0 text-muted-foreground"
                data-testid={`epic-sidebar-tree-lock-${nodeId}`}
                // Decoration: the row button's explicit `aria-label` REPLACES
                // its subtree as the accessible name, so a label here could
                // never reach assistive technology - the offline state rides
                // the row's own name instead (see `chatRowAriaLabel`).
                aria-hidden
              />
            </TooltipWrapper>
          ) : null}
          <AgentRoleBadgesForOwner
            ownerKind={resourceOwnerKind}
            claims={roleClaims}
          />
          {resourceOwnerKind === null || !showNavigatorResourceStats ? null : (
            <OwnerResourceChip
              epicId={epicId}
              kind={resourceOwnerKind}
              ownerId={nodeId}
              className={undefined}
            />
          )}
          {/* Completes the control SWAP: while the archive button is mounted,
              revealing the controls removes the idle-time slot from layout so
              the title can use every pixel before the reserved action strip.
              Scoped to this trailing span only - the leading icon sits outside
              it, so the swap never blanks the row's status glyph. */}
          <span
            className={cn(
              "flex-none",
              reserveArchiveSlot &&
                "group-hover/tree-item:hidden group-focus-within/tree-item:hidden group-has-[[data-state=open]]/tree-item:hidden",
            )}
          >
            <ChatRowIdleTime updatedAt={updatedAt} />
          </span>
        </span>
      </span>
    </button>
  );
  // Same composition the graph nodes use - extracted so the navigator and the
  // canvas cannot describe one agent two ways.
  return (
    <AgentHoverTooltip
      trigger={button}
      epicId={epicId}
      nodeId={nodeId}
      nodeName={nodeName}
      hostId={ownerHostId}
      ownerKind={ownerKind}
      roleClaims={roleClaims}
      side="right"
    />
  );
}

/**
 * Keeps the archival state attached to the title rather than competing with
 * timestamps and controls in the trailing metadata cluster.
 */
function ArchivedTitlePrefix(): ReactNode {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-muted-foreground"
      data-testid="chat-row-archived-label"
    >
      <span className="font-semibold">Archived</span>
      <span aria-hidden="true">·</span>
    </span>
  );
}

/**
 * The row's trailing last-activity time, on the shared compact ladder
 * (`now` / `10m` / `4h` / `1d` / `1w` / short date). Isolated in its own leaf
 * so the shared 60s clock tick repaints this span rather than the whole row.
 */
function ChatRowIdleTime(props: { readonly updatedAt: number }): ReactNode {
  const relative = useCompactRelativeTime(props.updatedAt);
  return (
    <span
      className="flex-none tabular-nums text-ui-xs text-muted-foreground"
      data-testid="chat-row-idle-time"
    >
      {relative}
    </span>
  );
}

// Glyph and color come from the shared notification tones so the nested
// variant cannot drift from the per-row icon; "running" stays local because
// it is an activity tier, not a notification state.
const CHAT_DESCENDANT_STATUS_TONES: Record<
  Exclude<ChatDescendantStatusKind, "running" | "background">,
  IndicatorTone
> = {
  failure: FAILURE_TONE,
  fork: FORK_TONE,
  interview: INTERVIEW_TONE,
  approval: APPROVAL_TONE,
  done: DONE_TONE,
};

/**
 * The parent's own tier on the shared ladder. `selfTier` is the host-published
 * activity tier from epic awareness - the same authority the per-row icon
 * falls back to for an unopened chat, now carrying the turn/background split
 * so a parent doing only background work cannot outrank a descendant that is
 * genuinely mid-turn.
 */
function chatSelfStatusRank(
  state: NotificationIndicatorState,
  selfTier: AgentActivityTier | undefined,
): number {
  const tone = attentionTone(state);
  if (tone === FAILURE_TONE) return CHAT_STATUS_RANKS.failure;
  if (tone === FORK_TONE) return CHAT_STATUS_RANKS.fork;
  if (tone === INTERVIEW_TONE) return CHAT_STATUS_RANKS.interview;
  if (tone === APPROVAL_TONE) return CHAT_STATUS_RANKS.approval;
  if (selfTier === "turn") return CHAT_STATUS_RANKS.running;
  if (selfTier === "background") return CHAT_STATUS_RANKS.background;
  if (state.unreadDone) return CHAT_STATUS_RANKS.done;
  return 0;
}

/** "Nested: 1 needs attention · 2 running" - non-zero tiers, priority order. */
function nestedChatStatusSummary(rollup: ChatDescendantStatusRollup): string {
  const parts: string[] = [];
  if (rollup.failureCount > 0) {
    parts.push(
      `${rollup.failureCount} ${rollup.failureCount === 1 ? "needs" : "need"} attention`,
    );
  }
  if (rollup.forkCount > 0) {
    parts.push(`${rollup.forkCount} waiting for fork resolution`);
  }
  if (rollup.interviewCount > 0) {
    parts.push(`${rollup.interviewCount} waiting for interview`);
  }
  if (rollup.approvalCount > 0) {
    parts.push(`${rollup.approvalCount} waiting for approval`);
  }
  if (rollup.runningCount > 0) parts.push(`${rollup.runningCount} running`);
  if (rollup.backgroundCount > 0) {
    parts.push(`${rollup.backgroundCount} in background`);
  }
  if (rollup.doneCount > 0) parts.push(`${rollup.doneCount} completed`);
  return `Nested: ${parts.join(" · ")}`;
}

/**
 * The muted variant of the status icon: same glyph, same slot, reduced
 * opacity - the artifact tree's solid-vs-translucent "self vs descendant"
 * convention applied to chat status. The tooltip carries the full nested
 * breakdown, since one glyph can stand for several children.
 */
function NestedChatStatusIcon(props: {
  readonly nodeId: string;
  readonly rollup: ChatDescendantStatusRollup;
}): ReactNode {
  const title = nestedChatStatusSummary(props.rollup);
  return (
    <TooltipWrapper
      label={title}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        role="status"
        aria-label={title}
        data-testid={`chat-descendant-status-${props.rollup.kind}-${props.nodeId}`}
        className="inline-flex size-3.5 shrink-0 items-center justify-center opacity-60"
      >
        <NestedChatStatusGlyph kind={props.rollup.kind} />
      </span>
    </TooltipWrapper>
  );
}

function NestedChatStatusGlyph(props: {
  readonly kind: ChatDescendantStatusKind;
}): ReactNode {
  if (props.kind === "background") {
    return <BackgroundActivityGlyph testId={undefined} />;
  }
  if (props.kind === "running") {
    return (
      <AgentSpinningDots
        className="text-current"
        testId={undefined}
        variant={undefined}
      />
    );
  }
  const tone = CHAT_DESCENDANT_STATUS_TONES[props.kind];
  const Icon = tone.Icon;
  return <Icon aria-hidden className={cn("size-3.5", tone.className)} />;
}

/**
 * The row's own status kind. `idle` means nothing notable - the leading icon
 * falls back to the plain glyph and the trailing slot to a relative time.
 */
type ChatOwnStatusKind =
  | "failure"
  | "fork"
  | "interview"
  | "approval"
  | "working"
  | "background"
  | "done"
  | "read-only"
  | "idle";

/**
 * The precedence lattice, reused unchanged from the per-row notification icon
 * (`NotificationIndicatorIcon`): attention tone (failure > interview >
 * approval) > running turn > background > unread-done > default. Terminal-agent
 * rows resolve through the same lattice - their `agent.stopped` notifications
 * are chat-scoped to the agent id, so `state` is populated for them too; only
 * the read-only arm stays chat-only.
 *
 * `read-only` sits in the DEFAULT slot, not above it - the pre-refactor icon
 * rendered the lock as `NotificationIndicatorIcon`'s `defaultIcon`, i.e. only
 * once no tone, no running state and no unread completion claimed the slot. So
 * a viewer still sees "Needs attention" / "Working" on a row that has them, and
 * the lock only replaces the idle relative time.
 */
function chatOwnStatusKind(
  state: NotificationIndicatorState,
  running: IndicatorRunningKind,
  isReadOnly: boolean,
): ChatOwnStatusKind {
  const tone = attentionTone(state);
  if (tone === FAILURE_TONE) return "failure";
  if (tone === FORK_TONE) return "fork";
  if (tone === INTERVIEW_TONE) return "interview";
  if (tone === APPROVAL_TONE) return "approval";
  if (running === "turn") return "working";
  if (running === "background") return "background";
  if (state.unreadDone) return "done";
  if (isReadOnly) return "read-only";
  return "idle";
}

/**
 * A row's resolved status: the folded lattice kind the icon renders from, PLUS
 * the raw running tier it was folded out of.
 *
 * Both are carried because `chatOwnStatusKind` is lossy in a way that matters
 * here. Its attention arms (`failure` / `interview` / `approval`) return BEFORE
 * it ever tests `running`, so a chat that is genuinely mid-turn while blocked on
 * a tool approval folds to `"approval"` and its turn becomes invisible to any
 * consumer reading `kind` alone. That is correct for the ICON - one glyph, and
 * "needs you" outranks "working" - but it is wrong for an availability gate:
 * a pending approval is raised from INSIDE a running turn, so it is the single
 * most likely moment for a human to be looking at the row and reaching for
 * Archive.
 */
interface ChatRowStatus {
  readonly kind: ChatOwnStatusKind;
  readonly running: IndicatorRunningKind;
}

/**
 * The row's archive menu state, or `null` on a host that lacks
 * `epic.setChatArchived` - in which case the entry is absent from both menus
 * rather than present-but-disabled.
 */
interface ChatRowArchiveEntry {
  readonly isArchived: boolean;
  readonly disabled: boolean;
  /** Populated only for the busy arm; `null` whenever `disabled` is false. */
  readonly disabledTooltip: string | null;
}

/**
 * A row's archive INPUTS, grouped because they are one concept and always
 * travel together: whether the host can archive at all, whether this row
 * already is, whether a toggle is in flight, and how to toggle it. Passing
 * them as four loose props made the row's prop list four booleans wider for
 * one feature.
 *
 * Distinct from {@link ChatRowArchiveDecision}, which is what the row renders
 * from once those inputs plus the resolved status kind have been folded.
 */
interface ChatRowArchiveInputs {
  readonly supported: boolean;
  readonly isArchived: boolean;
  readonly pending: boolean;
  readonly onToggle: () => void;
}

interface ChatRowArchiveDecision {
  readonly entry: ChatRowArchiveEntry | null;
  readonly showButton: boolean;
}

/**
 * Copy for a refused archive, matched to the tier so the row explains the
 * ACTUAL reason - "working" and "has background items running" are different
 * things to wait on, and a single generic string would misdescribe one of them.
 *
 * This tooltip is the ONLY message these rows get. The entry is soft-disabled,
 * which prevents `onSelect`, so the host's own refusal - and the toast that
 * rewrites it into user-facing copy - never fire from here. Advice that is
 * wrong in this string is wrong with nothing behind it to correct it.
 *
 * So the background arm must not say "stop it". Every stop affordance routes
 * into `ChatSession.stopActiveTurn()`, which early-returns when no turn is
 * running, so an agent held only by a detached subagent, a workflow or a
 * scheduled wake cannot be stopped into an archivable state - the user would
 * press Stop, see nothing change, and be told the same thing again. It names
 * the per-item controls in the chat instead, which is the affordance that
 * actually clears them.
 *
 * The host's `archiveBlockedMessage` splits on exactly this distinction and
 * keeps its two arms disjoint under test; this is the same split one surface
 * earlier, where the user actually is.
 */
function archiveBlockedReason(
  // Excludes the idle tier rather than trusting the caller's `running !== false`
  // guard. Without it a future caller could pass an idle row and silently get
  // the background-items copy, which describes a state that is not blocked at
  // all - a wrong explanation, not a missing one.
  running: Exclude<IndicatorRunningKind, false>,
): string {
  if (running === "turn") {
    // Hedged, because this tier is NOT "a turn is running". `chatActivityIndicator`
    // deliberately maps a detached subagent or workflow fleet outliving its turn
    // into `"turn"` - it is the agent working, so it earns the busy spinner
    // rather than the muted background glyph - while `resolvedTurnStatus`
    // reports no active turn for that same state, precisely so a Stop-turn
    // affordance does not surface. Promising a stop here would contradict that
    // and send the user after an action the host early-returns from.
    return "Can't archive while this agent is working. Stopping it ends a turn, but not a detached subagent or workflow. Wait for it to go idle, or stop it, then archive.";
  }
  return "Can't archive while this agent has background items running. Stopping the agent won't clear them — wait for them to finish, or stop them from its chat.";
}

/**
 * Both archive affordances for a row, decided together. Only called for rows
 * whose host supports the method.
 *
 * They are deliberately gated differently, and the MENU entry is the surface
 * that must always work: present on every row, and merely SOFT-disabled while
 * the row is busy (`aria-disabled`, not Radix's `disabled`) so it stays in the
 * arrow-key order and can still announce its reason - see `softDisabledProps`
 * in `sidebar-row-menu-items`. The hover BUTTON is a pointer shortcut that
 * TAKES OVER the trailing status slot, so it may only appear when that slot is
 * showing the idle time and nothing else.
 *
 * The two therefore DO diverge, by design rather than by accident: on a busy
 * row - archived or not - the button is hidden while the entry remains. That
 * is why the entry, not the button, carries the explanation.
 *
 * That last condition is stricter than "my own status is idle", which is why
 * `hasChildren`/`expanded` are inputs. A COLLAPSED PARENT's leading slot renders
 * `ChatRowLeadingIconWithNestedRollup`, which may show a muted rollup glyph
 * standing in for a hidden descendant that needs attention - the only signal
 * those descendants have. Showing the button there would blank the trailing
 * time on hover while that glyph stands for a failure, and offer to archive the
 * whole subtree, failure included. The shell cannot
 * tell which way the rollup resolved without duplicating its subscription, so
 * every collapsed parent is excluded; the menu entry stays the archive path for
 * those rows.
 *
 * Busy is read off `status.running`, NOT off the folded `status.kind`. Folding
 * loses exactly the case this gate exists for - see {@link ChatRowStatus} - so
 * gating on `kind === "working" | "background"` left Archive ENABLED on any
 * running chat that also had a pending approval or interview, which is most of
 * them at the moment a human is looking. The host refuses such an archive
 * anyway; matching it here is what keeps the affordance honest instead of
 * offering an action that will only come back as a toast.
 *
 * "Busy" here means everything the host counts, which includes a chat owning a
 * running shell - not just an in-flight turn. Narrowing this read to exclude
 * shells is what once left Archive offered on a chat the host would bounce, so
 * it must stay whatever {@link chatActivityIndicator} reports.
 *
 * That "the host refuses it anyway" backstop holds only for an agent on the
 * host this RPC goes to. `AgentActivityTracker` is host-LOCAL, while this
 * predicate unions every host's awareness entry, so for a row running on
 * another host the UI gate is the only one that fires on busy-ness. The host
 * refuses those outright (`TARGET_NOT_LOCAL`) rather than guessing, so the
 * failure mode is an explanatory toast, not a bad archive - but the row is
 * still offered, which is a known gap.
 *
 * UNARCHIVING is never gated on busy - the host allows it, and an archived row
 * can be working (an inbound message auto-unarchives and wakes it, so the flag
 * and the run legitimately overlap). Only `archivePending` disables that
 * direction, to stop a double-submit.
 */
function chatRowArchiveState(args: {
  readonly canMutate: boolean;
  readonly isArchived: boolean;
  readonly archivePending: boolean;
  readonly status: ChatRowStatus;
  readonly selectionMode: boolean;
  readonly isRenaming: boolean;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}): ChatRowArchiveDecision {
  // The tier that BLOCKS, or `false` for none. Carrying the narrowed value
  // rather than a separate boolean is what lets `archiveBlockedReason` refuse
  // the idle tier by type: a bare `blocksArchive` flag proves nothing to the
  // compiler about `status.running` at the call below.
  const blockingRun: IndicatorRunningKind = args.isArchived
    ? false
    : args.status.running;
  const slotMayShowRollup = args.hasChildren && !args.expanded;
  return {
    entry: {
      isArchived: args.isArchived,
      disabled: blockingRun !== false || args.archivePending,
      disabledTooltip:
        blockingRun === false ? null : archiveBlockedReason(blockingRun),
    },
    showButton:
      args.canMutate &&
      args.status.kind === "idle" &&
      !slotMayShowRollup &&
      !args.selectionMode &&
      !args.isRenaming,
  };
}

interface ChatRowMenuEntriesProps {
  readonly nodeId: string;
  readonly canMutate: boolean;
  readonly archiveEntry: ChatRowArchiveEntry | null;
  readonly onNewChildAgent: () => void;
  readonly onStartRename: () => void;
  readonly onToggleArchive: () => void;
  readonly onPerformDelete: () => void;
}

/**
 * The Archive / Unarchive entry, or nothing at all. Kept as a spreadable list
 * so `chatRowMenuEntries` stays one flat literal - the ⋯ and right-click menus
 * both render from it, so a single definition covers both surfaces.
 *
 * The label is the ACTION, not the state: an archived row offers "Unarchive".
 */
function archiveMenuEntries(
  props: ChatRowMenuEntriesProps,
): ReadonlyArray<SidebarRowMenuEntry> {
  const { archiveEntry } = props;
  if (archiveEntry === null) return [];
  return [
    {
      kind: "item",
      id: "archive",
      label: archiveEntry.isArchived ? "Unarchive" : "Archive",
      icon: archiveEntry.isArchived ? (
        <ArchiveRestore className="size-3.5" />
      ) : (
        <Archive className="size-3.5" />
      ),
      disabled: !props.canMutate || archiveEntry.disabled,
      // Only the busy arm explains itself. `!canMutate` greys out every entry
      // in the menu at once, so a per-entry tooltip there would be noise.
      disabledTooltip: props.canMutate ? archiveEntry.disabledTooltip : null,
      variant: "default",
      testIds: {
        dropdown: `epic-sidebar-archive-item-${props.nodeId}`,
        context: `epic-sidebar-context-archive-${props.nodeId}`,
      },
      onSelect: props.onToggleArchive,
    },
  ];
}

function chatRowMenuEntries(
  props: ChatRowMenuEntriesProps,
): ReadonlyArray<SidebarRowMenuEntry> {
  return [
    {
      kind: "item",
      id: "new-child-agent",
      label: "New child agent",
      icon: <Plus className="size-3.5" />,
      disabled: !props.canMutate,
      disabledTooltip: null,
      variant: "default",
      testIds: {
        dropdown: `epic-sidebar-new-child-${props.nodeId}`,
        context: `epic-sidebar-context-new-child-${props.nodeId}`,
      },
      onSelect: props.onNewChildAgent,
    },
    {
      kind: "item",
      id: "rename",
      label: "Rename",
      icon: <Pencil className="size-3.5" />,
      disabled: !props.canMutate,
      disabledTooltip: null,
      variant: "default",
      testIds: {
        dropdown: `epic-sidebar-rename-${props.nodeId}`,
        context: `epic-sidebar-context-rename-${props.nodeId}`,
      },
      onSelect: props.onStartRename,
    },
    ...archiveMenuEntries(props),
    { kind: "separator", id: "before-delete" },
    {
      kind: "item",
      id: "delete",
      label: "Delete",
      icon: <Trash2 className="size-3.5" />,
      disabled: !props.canMutate,
      disabledTooltip: null,
      variant: "destructive",
      testIds: {
        dropdown: `epic-sidebar-delete-${props.nodeId}`,
        context: `epic-sidebar-context-delete-${props.nodeId}`,
      },
      onSelect: props.onPerformDelete,
    },
  ];
}

/**
 * The row's resolved own status kind for the archive affordances, which must
 * appear only on an idle row and stay disabled while one is working.
 *
 * Resolves through the same `chatOwnStatusKind` lattice the leading status icon
 * renders from, so the two can never disagree, but reads an open chat's session
 * through `useSyncExternalStore` rather than the icon's parent/child split.
 * A hook cannot use that split - `useStore` can't be called conditionally on a
 * nullable handle - and the snapshots here are deliberately PRIMITIVES, so this
 * re-renders its caller only when the kind actually flips rather than on every
 * queue or background-item tick of an open chat.
 *
 * Same authority order as the icon: an open chat's session tri-state wins,
 * epic awareness backfills the subscription-gap window and covers unopened
 * rows, and a session's own access snapshot overrides the epic-level viewer
 * role.
 */
function useChatRowOwnStatusKind(args: {
  readonly epicId: string;
  readonly nodeId: string;
  /** The row's OWN owner host - same rule and same reason as
   *  {@link ChatRowOwnLeadingIcon}'s, so the archive affordances and the
   *  leading icon resolve the SAME session and cannot disagree. */
  readonly ownerHostId: string | null;
  readonly artifactType: EpicNodeKind;
}): ChatRowStatus {
  const { epicId, nodeId, ownerHostId, artifactType } = args;
  const indicatorState = useSurfaceNotificationIndicatorState(
    { epicId, chatId: nodeId },
    ownerHostId,
  );
  const awarenessTier = useEpicAgentActivityTiers().get(nodeId);
  const isViewer = useContext(SidebarViewerContext);
  // Terminal-agent rows have no chat session and never carried a read-only
  // lock (their PTY runs host-side), so the viewer arm is chat-only.
  const isChat = artifactType === "chat";
  const sessionHandle = useExistingChatSessionHandle(
    epicId,
    nodeId,
    ownerHostId,
  );
  const subscribeSession = useMemo(
    () => (onChange: () => void) => {
      if (sessionHandle === null) return () => undefined;
      return sessionHandle.store.subscribe(onChange);
    },
    [sessionHandle],
  );
  const sessionActivity = useSyncExternalStore(subscribeSession, () =>
    sessionHandle === null
      ? null
      : chatActivityIndicator(sessionHandle.store.getState()),
  );
  const sessionRole = useSyncExternalStore(subscribeSession, () =>
    sessionHandle === null
      ? null
      : (sessionHandle.store.getState().access?.role ?? null),
  );
  if (sessionHandle === null || !isChat) {
    const running = awarenessTier ?? false;
    return {
      kind: chatOwnStatusKind(indicatorState, running, isChat && isViewer),
      running,
    };
  }
  const running = sessionActivity ?? awarenessTier ?? false;
  return {
    kind: chatOwnStatusKind(
      indicatorState,
      running,
      // Stay neutral while the access snapshot is unknown so an owner never
      // sees a read-only row flash before it arrives.
      sessionRole !== null && sessionRole !== "owner",
    ),
    running,
  };
}

/**
 * Hover-revealed Archive / Unarchive control, a SIBLING of the row rather than
 * a child of it: the row is itself a `<button>`, so a nested `<button>` would
 * be invalid HTML and unreachable by keyboard. It sits beside the "..." trigger
 * in the same absolutely-positioned control strip, which is why the row
 * reserves pad-right for two controls while this is mounted.
 *
 * Rendered only for idle rows, so it never covers a status the user needs. No
 * confirm dialog, unlike delete - archiving is reversible.
 */
function ChatRowArchiveButton(props: {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly isArchived: boolean;
  readonly pending: boolean;
  readonly onToggle: () => void;
}) {
  const label = props.isArchived
    ? `Unarchive ${props.nodeName}`
    : `Archive ${props.nodeName}`;
  return (
    <TooltipWrapper
      label={label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        disabled={props.pending}
        data-testid={`epic-sidebar-archive-${props.nodeId}`}
        className="absolute right-7 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/tree-item:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          props.onToggle();
        }}
      >
        {props.isArchived ? (
          <ArchiveRestore className="size-3" />
        ) : (
          <Archive className="size-3" />
        )}
      </Button>
    </TooltipWrapper>
  );
}

function ChatMoreMenu(props: {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly entries: ReadonlyArray<SidebarRowMenuEntry>;
}) {
  const { nodeId, nodeName, entries } = props;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Agent actions for ${nodeName}`}
          data-testid={`epic-sidebar-more-${nodeId}`}
          className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/tree-item:opacity-100 aria-expanded:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <MoreHorizontal className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <SidebarDropdownMenuItems entries={entries} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
