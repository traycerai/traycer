/**
 * Chat/terminal-agent tree body for the sidebar. Renders the tree of chat nodes
 * with expansion, rename, delete, and drag-drop behaviors.
 */
import { useDraggable } from "@dnd-kit/core";
import { v4 as uuidv4 } from "uuid";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  useEpicArchiveChat,
  useEpicDeleteChat,
  useEpicRenameChat,
} from "@/hooks/epic/use-epic-chat-mutations";
import {
  useChatArchiveSupported,
  useChatArchiveSupportState,
} from "@/hooks/epic/use-chat-archive-support";
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
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import type { ProviderId } from "@/components/home/data/landing-options";
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
import { TreeChevron, TreeChevronSpacer } from "@/components/ui/tree-chevron";
import {
  isChatFilterActive,
  useAcknowledgedRootCreatePending,
  useChatFilter,
  useChatShowArchived,
  useChatSort,
  useLocalRootCreatePending,
  type RootCreatePanelId,
} from "@/stores/epics/left-panel-store";
import {
  isDefaultSort,
  makeNodeComparator,
  sortNodeIds,
  type NodeComparator,
} from "@/lib/epic-sort";
import {
  findOpenArtifactInTab,
  useActiveEpicArtifactId,
  useEpicCanvasStore,
  useIsActiveEpicArtifact,
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
  useEpicAgentActivityTiers,
  type AgentActivityTier,
  useEpicArchivedNodeIds,
  useEpicArtifactRecords,
  useEpicConnectionStatus,
  useEpicNodeArchived,
  useEpicNodeHostId,
  useEpicNodeOwnerKind,
  useEpicPermissionRole,
  useEpicTreeIndex,
  useEpicTreeNode,
  useMaybeEpicTuiAgentHarnessId,
} from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  Archive,
  ArchiveRestore,
  Check,
  MessageSquareLock,
  MessagesSquare,
  MoreHorizontal,
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
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  BASE_PAD_LEFT,
  EMPTY_PENDING_LIST,
  EMPTY_PRE_ACK_LIST,
  INDENT_PX,
  anyMutationPending,
  nodePadRightClass,
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
  collectVisibleSidebarTreeIds,
  useMaybeSidebarBulkSelection,
} from "./epic-sidebar-selection";
import {
  getSidebarNodeDragId,
  SIDEBAR_NODE_DND_TYPE,
  type EpicCanvasSidebarNodeDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { SidebarReparentRowDropWrapper } from "@/components/epic-canvas/sidebar/sidebar-reparent-row-drop-wrapper";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { useHostNotificationIndicators } from "@/hooks/notifications/use-host-notification-indicators-query";
import { WorktreeOwnerMetadataTooltip } from "@/components/worktree/worktree-owner-metadata";
import {
  SidebarContextMenuItems,
  SidebarDropdownMenuItems,
  type SidebarRowMenuEntry,
} from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";
import { ChatRowSecondLine } from "@/components/epic-canvas/sidebar/chat-row-second-line";
import { EpicChatWorktreeMetadataProvider } from "@/components/epic-canvas/sidebar/epic-chat-worktree-metadata-provider";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
import { useSampledNow } from "@/lib/relative-time";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { chatActivityIndicator } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { IndicatorRunningKind } from "@/components/notifications/notification-indicator-icon";

interface ChatTreePanelBodyProps {
  readonly epicId: string;
  readonly tabId: string;
}

type TreeFilterFn = (type: string | null | undefined) => boolean;

const CHATS_TREE_FILTER: TreeFilterFn = (type) =>
  type === "chat" || type === "terminal-agent";

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

const EMPTY_SELECTED_IDS: ReadonlySet<string> = new Set<string>();
const noopToggleSelection = (_id: string): void => undefined;
const noopRowAction = (): void => undefined;

type ChatDescendantStatusKind =
  "failure" | "interview" | "approval" | "running" | "background" | "done";

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
  failure: 6,
  interview: 5,
  approval: 4,
  running: 3,
  background: 2,
  done: 1,
};

/** {@link CHAT_STATUS_RANKS} most-urgent first, for picking a rollup's kind. */
const CHAT_STATUS_ORDER: ReadonlyArray<ChatDescendantStatusKind> = [
  "failure",
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
  readonly interviewCount: number;
  readonly approvalCount: number;
  readonly runningCount: number;
  readonly backgroundCount: number;
  readonly doneCount: number;
}

interface ChatDescendantIds {
  readonly chatIds: ReadonlyArray<string>;
  readonly agentIds: ReadonlyArray<string>;
}

const EMPTY_CHAT_DESCENDANT_IDS: ChatDescendantIds = {
  chatIds: [],
  agentIds: [],
};

/**
 * Collects the chat / terminal-agent descendants of `nodeId` so a collapsed
 * parent can roll their statuses up without mounting the child rows. Mirrors
 * the artifact tree's `collectDescendantArtifactEntries`: filter-hidden
 * subtrees are skipped along with their children (the rollup must never point
 * at a row the user cannot reach by expanding) and the walk is cycle-guarded
 * via `visited`.
 */
function collectDescendantChatIds(
  nodeId: string,
  tree: TreeSlice,
  visibleIds: ReadonlySet<string> | null,
): ChatDescendantIds {
  const rootChildren = Object.hasOwn(tree.childrenByParent, nodeId)
    ? tree.childrenByParent[nodeId]
    : null;
  if (rootChildren === null || rootChildren.length === 0) {
    return EMPTY_CHAT_DESCENDANT_IDS;
  }
  const chatIds: string[] = [];
  const agentIds: string[] = [];
  const visited = new Set<string>([nodeId]);
  const stack = [...rootChildren];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    if (visibleIds !== null && !visibleIds.has(id)) continue;
    if (!Object.hasOwn(tree.nodeById, id)) continue;
    const node = tree.nodeById[id];
    if (node.type === "chat") chatIds.push(id);
    if (node.type === "terminal-agent") agentIds.push(id);
    if (Object.hasOwn(tree.childrenByParent, id)) {
      for (const childId of tree.childrenByParent[id]) stack.push(childId);
    }
  }
  if (chatIds.length === 0 && agentIds.length === 0) {
    return EMPTY_CHAT_DESCENDANT_IDS;
  }
  return { chatIds, agentIds };
}

/**
 * Rollup over a collapsed parent's hidden chat descendants, or `null` when
 * there are none or none has a notable status. Each descendant chat is
 * classified once, under its own highest tier - the per-chat attention
 * precedence goes through the shared `attentionTone`, so failure > interview >
 * approval lives in exactly one place. Terminal-agent descendants contribute
 * only running-ness - epic-wide activity is their sole status authority. Only
 * mounted inside `ChatRowStatusWithNestedRollup` (rendered solely for
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
        interview: 0,
        approval: 0,
        running: 0,
        background: 0,
        done: 0,
      };
      for (const chatId of descendants.chatIds) {
        const indicatorState = selectNotificationIndicatorState(
          state,
          { epicId, chatId },
          indicators,
        );
        const kind = chatDescendantKind(
          indicatorState,
          activityTiers.get(chatId),
        );
        if (kind !== null) counts[kind] += 1;
      }
      for (const agentId of descendants.agentIds) {
        // Terminal-agent descendants contribute only activity - epic-wide
        // awareness is their sole status authority.
        const tier = activityTiers.get(agentId);
        if (tier !== undefined) counts[activityTierKind(tier)] += 1;
      }
      const kind =
        CHAT_STATUS_ORDER.find((candidate) => counts[candidate] > 0) ?? null;
      if (kind === null) return null;
      return {
        kind,
        failureCount: counts.failure,
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
    // Roots = chats/terminal-agents that have no parent in the rendered
    // tree. We read the projector's `rootIds`, already in the default
    // (most-recent-activity) order from `compareNodes`, then re-sort below
    // for a non-default mode. Either way chats and terminal-agents
    // interleave by the chosen key instead of grouping by type - consistent
    // with how nested children render off `childrenByParent`. Iterating the
    // record list instead would surface the projector's slice order (all
    // chats, then all terminal-agents) and drop the sort. Child agents
    // (spawned via `agent.create`, which sets the new agent's `parentId` to
    // its sender) are nested through `useChildIds` off `childrenByParent`
    // and are absent from `rootIds`, so they correctly never appear here.
    const roots = tree.rootIds.filter((id) => {
      const node = tree.nodeById[id];
      return node.type === "chat" || node.type === "terminal-agent";
    });
    // `tree.rootIds` is in projector (default) order; re-sort only for a
    // non-default mode (`comparator !== null`).
    return sortNodeIds(roots, tree.nodeById, comparator);
  }, [panelId, tree, comparator]);
}

const EMPTY_ARCHIVE_HIDDEN_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Every node hidden by archiving: the archived nodes themselves plus their
 * whole subtrees, i.e. exactly "some ancestor-or-self carries `archivedAt`".
 *
 * Descends from the archive roots through `childrenByParent` rather than
 * walking each node's parent chain upward - the archived set is normally tiny
 * and the walk then costs O(hidden subtree) instead of O(nodes x depth).
 *
 * This is what makes the SINGLE-FLAG model work without cascade writes:
 * archiving stamps only the target, and unarchiving clears only the target, so
 * the subtree reappears in one step - except for descendants that were archived
 * in their own right, which stay in `archivedIds` and keep hiding their own
 * subtrees. `hidden` doubles as the cycle guard.
 */
function collectArchiveHiddenIds(
  archivedIds: ReadonlyArray<string>,
  tree: TreeSlice,
): ReadonlySet<string> {
  if (archivedIds.length === 0) return EMPTY_ARCHIVE_HIDDEN_IDS;
  const hidden = new Set<string>();
  const stack = [...archivedIds];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || hidden.has(id)) continue;
    hidden.add(id);
    if (Object.hasOwn(tree.childrenByParent, id)) {
      for (const childId of tree.childrenByParent[id]) stack.push(childId);
    }
  }
  return hidden;
}

/**
 * The archive-hidden set for this epic, or empty when nothing should be hidden.
 *
 * Nothing is hidden in two cases, and the second is load-bearing:
 *
 * 1. "Show archived" is on - archived rows render dimmed instead.
 * 2. The host is KNOWN to lack `epic.setChatArchived`. Every way back to an
 *    archived row is capability-gated (the "Show archived" toggle, the
 *    Unarchive entry, the empty-state hint), so continuing to hide on such a
 *    host would leave rows invisible with nothing left to recover them - a real
 *    path, since a host can be rolled back under a live session or the default
 *    host can simply be an older machine. Archived records must never become
 *    unreachable, so a known-absent host stops hiding entirely.
 *
 * The support state is deliberately the TRI-STATE, not the fail-closed boolean:
 * `null` (no handshake yet) keeps hiding, because revealing on unknown would
 * flash archived rows on every cold start and hide them again a moment later.
 * Only a positive `false` reveals.
 */
function useArchiveHiddenIds(epicId: string): ReadonlySet<string> {
  const showArchived = useChatShowArchived(epicId);
  const archiveSupport = useChatArchiveSupportState();
  const archivedIds = useEpicArchivedNodeIds();
  const tree = useEpicTreeIndex();
  return useMemo(() => {
    if (showArchived || archiveSupport === false) {
      return EMPTY_ARCHIVE_HIDDEN_IDS;
    }
    return collectArchiveHiddenIds(archivedIds, tree);
  }, [showArchived, archiveSupport, archivedIds, tree]);
}

/**
 * Intersects the origin filter's visible-id set with archive hiding, for the
 * consumers that walk tree DATA rather than the rendered tree (the collapsed
 * parent's status rollup, the bulk-selection id sweep). Those must not surface
 * a row the user cannot reach by expanding.
 *
 * Deliberately NOT fed to `mergeForcedExpanded`: that force-expands every id in
 * a non-null set, so publishing an archive-derived set there would expand the
 * entire tree the moment anything was archived. Forced expansion stays keyed
 * off the origin filter alone.
 */
function combineVisibleIds(
  originVisibleIds: ReadonlySet<string> | null,
  archiveHiddenIds: ReadonlySet<string>,
  tree: TreeSlice,
): ReadonlySet<string> | null {
  if (archiveHiddenIds.size === 0) return originVisibleIds;
  const source =
    originVisibleIds === null ? Object.keys(tree.nodeById) : originVisibleIds;
  const combined = new Set<string>();
  for (const id of source) {
    if (!archiveHiddenIds.has(id)) combined.add(id);
  }
  return combined;
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

// Panel body composes sort/filter/expansion/selection/pending-create hooks in
// a stable order; child row complexity is isolated below.
// eslint-disable-next-line complexity
export function ChatTreePanelBody(props: ChatTreePanelBodyProps) {
  const { epicId, tabId } = props;
  const panelId: RootCreatePanelId = "chats";
  const sort = useChatSort(epicId);
  const comparator = useMemo<NodeComparator | null>(
    () => (isDefaultSort(sort) ? null : makeNodeComparator(sort)),
    [sort],
  );
  const allRootIds = usePanelRootIds(panelId, comparator);
  const originVisibleIds = useChatVisibleIds(epicId);
  const tree = useEpicTreeIndex();
  const archiveHiddenIds = useArchiveHiddenIds(epicId);
  const canArchive = useChatArchiveSupported();
  // Two independent narrowings, kept separate on purpose. `originRootIds` is
  // the origin filter's result and feeds the "no matches" empty state and
  // forced expansion; `rootIds` additionally drops archived roots and is what
  // actually renders. Collapsing them would make an all-archived tree claim
  // "No agents use this interface", which is false.
  const originRootIds = useMemo(
    () => applyVisibleFilter(allRootIds, originVisibleIds),
    [allRootIds, originVisibleIds],
  );
  const rootIds = useMemo(
    () =>
      archiveHiddenIds.size === 0
        ? originRootIds
        : originRootIds.filter((id) => !archiveHiddenIds.has(id)),
    [originRootIds, archiveHiddenIds],
  );
  const visibleIds = useMemo(
    () => combineVisibleIds(originVisibleIds, archiveHiddenIds, tree),
    [originVisibleIds, archiveHiddenIds, tree],
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

  const ancestorIdsOfActive = useAncestorIds(activeArtifactId);
  // Origin-only: see `combineVisibleIds`. Archive hiding must never reach here.
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
        visibleIds,
        comparator,
      }),
    [rootIds, expandedIds, tree, visibleIds, comparator],
  );
  // Indicator state must cover every chat in the (filter-visible) tree, not
  // just rows currently revealed by expansion: a collapsed parent rolls its
  // hidden descendants' statuses up into a badge, so their indicators have to
  // be observed even while their rows are unmounted. Sorted for a stable
  // query identity across expand/collapse churn.
  const indicatorChatIds = useMemo(
    () =>
      Object.keys(tree.nodeById)
        .filter(
          (id) =>
            tree.nodeById[id].type === "chat" &&
            (visibleIds === null || visibleIds.has(id)),
        )
        .sort(),
    [tree, visibleIds],
  );
  const notificationIndicators = useHostNotificationIndicators({
    epicIds: [],
    chatIds: indicatorChatIds,
    enabled: indicatorChatIds.length > 0,
  });
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
    localRootPending !== null ||
    acknowledgedRootPending !== null ||
    preAckRootCreates.length > 0 ||
    visiblePendingRootCreates.length > 0;
  const filteredTreeEmpty = isFilteredTreeEmpty({
    visibleIds: originVisibleIds,
    rootIds: originRootIds,
    localRootPending,
    acknowledgedRootPending,
    preAckRootCreates,
    visiblePendingRootCreates,
  });
  const showEmptyState =
    originVisibleIds === null && allRootIds.length === 0 && !hasPendingRootRows;
  // Rows exist and survive the origin filter, yet archiving hid every one of
  // them. Distinct from both other arms: the tree is neither empty nor filtered
  // down to nothing, and the user needs to be told where the rows went.
  const archiveHidEverything =
    !hasPendingRootRows && rootIds.length === 0 && originRootIds.length > 0;

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
        title="No agents use this interface."
        description={null}
        testId="epic-chat-sidebar-filter-empty"
      />
    );
  } else if (archiveHidEverything) {
    panelContent = (
      <SidebarPanelEmptyState
        icon={Archive}
        title="Every agent here is archived."
        description={
          canArchive
            ? 'Turn on "Show archived" in the filter menu to see them.'
            : null
        }
        testId="epic-chat-sidebar-archived-empty"
      />
    );
  } else {
    panelContent = (
      <ul role="tree" aria-label="Epic agents tree" className="space-y-0.5">
        {rootIds.map((nodeId) => (
          <ChatNode
            key={nodeId}
            epicId={epicId}
            tabId={tabId}
            nodeId={nodeId}
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
        ))}
        {localRootPending !== null && (
          <PendingCreateRow depth={0} name={localRootPending.name} />
        )}
        {acknowledgedRootPending !== null && (
          <PendingCreateRow depth={0} name={acknowledgedRootPending.name} />
        )}
        {preAckRootCreates.map((entry: { tempId: string; name: string }) => (
          <PendingCreateRow key={entry.tempId} depth={0} name={entry.name} />
        ))}
        {visiblePendingRootCreates.map(
          (entry: { id: string; name: string }) => (
            <PendingCreateRow key={entry.id} depth={0} name={entry.name} />
          ),
        )}
      </ul>
    );
  }

  return (
    <NotificationIndicatorsProvider indicators={notificationIndicators.data}>
      {/* One batch for the whole tree, per distinct host among its rows - row 2
          reads it from context and never queries per row. */}
      <EpicChatWorktreeMetadataProvider epicId={epicId}>
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
      </EpicChatWorktreeMetadataProvider>
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
  // Row 1's trailing status chip falls back to a muted relative last-activity
  // time when the row is idle (no attention / running / done state).
  const updatedAt = node?.updatedAt ?? 0;
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

  const selectChatNode = useCallback(() => {
    if (isRenaming) return;
    if (openableType === null) return;
    navigateNested(epicId, tabId, () =>
      prepareOpenTilePreviewInTabFocusTarget(tabId, {
        id: nodeId,
        instanceId: uuidv4(),
        type: openableType,
        name: nodeName,
        hostId: activeHostId,
      }),
    );
  }, [
    activeHostId,
    epicId,
    isRenaming,
    navigateNested,
    nodeName,
    nodeId,
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
          id: nodeId,
          instanceId: uuidv4(),
          type: openableType,
          name: nodeName,
          hostId: activeHostId,
        }),
      );
    }
  }, [
    activeHostId,
    epicId,
    isRenaming,
    navigateNested,
    nodeId,
    nodeName,
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
      openableType={openableType}
      updatedAt={updatedAt}
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
  readonly openableType: OpenableEpicNodeKind | null;
  readonly updatedAt: number;
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
  // busy. Same lattice the trailing chip renders from.
  const statusKind = useChatRowOwnStatusKind({
    epicId: props.epicId,
    nodeId: props.nodeId,
    artifactType: props.artifactType,
  });
  return (
    <ChatNodeShellBody
      {...props}
      decision={chatRowArchiveState({
        canMutate: props.canMutate,
        isArchived: props.archive.isArchived,
        archivePending: props.archive.pending,
        statusKind,
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
  const {
    epicId,
    tabId,
    nodeId,
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
  // single hover affordance. Forcing chat mode mirrors `NewConversationModalAction`.
  const openNewConversationModal = useNewConversationModalOpenStore(
    (state) => state.open,
  );
  const handleNewChildAgent = useCallback(() => {
    if (!canMutate) return;
    useNewConversationModalStore.getState().setComposerMode(epicId, "chat");
    openNewConversationModal({
      epicId,
      tabId,
      placement: ACTIVE_TILE_PLACEMENT,
      parentId: nodeId,
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
    <li
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
            artifactType={artifactType}
            updatedAt={updatedAt}
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
            hasChildren={hasChildren}
            expanded={expanded}
            updatedAt={updatedAt}
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
    </li>
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
    // Decorative for assistive tech. The leading icon is status-aware by
    // design (`ChatProgressIcon` carries the spinner / read-only lock), so
    // without this a read-only row announced "Read-only agent" TWICE - once
    // here and once from the trailing `ChatOwnStatusChip` - and likewise for
    // running and approval states. Hiding the slot leaves the TRAILING chip as
    // the single announced status while the icon stays visually identical.
    // Nothing is lost: the row's identity is already carried by its explicit
    // `aria-label` (the title). Scoped to this slot only - the trailing chip
    // and the whole text column stay in the a11y tree. Safe to hide because
    // nothing inside is focusable or interactive.
    <span
      aria-hidden
      className="inline-flex h-3.5 w-[1.125rem] shrink-0 items-center"
    >
      {props.children}
    </span>
  );
}

/**
 * Per-type icon color customization, read here rather than threaded from the
 * tree root so the leading icon stays a leaf concern. `ChatProgressIcon`
 * already subscribes to exactly these two settings internally for chat rows;
 * mirroring it here keeps a terminal-agent's bot glyph from staying muted
 * while chat glyphs pick up "color by type" in the same column.
 */
function useNodeIconDisplay(artifactType: EpicNodeKind): {
  readonly className: string;
  readonly style: { color: string | undefined } | undefined;
} {
  const colorMode = useSettingsStore((s) => s.artifactIconColorMode);
  const color = useSettingsStore((s) => s.artifactIconColors[artifactType]);
  return {
    className: cn(
      "size-3.5 shrink-0",
      colorMode === "none" && "text-muted-foreground/70",
    ),
    style: colorMode === "byType" ? { color } : undefined,
  };
}

/**
 * Leading identity icon for a sidebar row, vertically centered on the two-line
 * card by the row scaffold. Chat rows get the status-aware chat glyph, TUI
 * rows the harness brand, and any other node kind its static registry glyph.
 */
function ChatRowLeadingIcon(props: {
  readonly epicId: string;
  readonly nodeId: string;
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
        className={undefined}
        mutedClassName="text-muted-foreground/70"
        testId="chat-sidebar-spinner"
        defaultIcon={undefined}
      />
    );
  }
  if (props.artifactType === "terminal-agent") {
    return <TerminalAgentProgressIcon nodeId={props.nodeId} />;
  }
  return <StaticSidebarNodeIcon artifactType={props.artifactType} />;
}

/**
 * Terminal-agent (TUI) sidebar icon. Swaps the static icon for the running
 * spinner while the agent is working, mirroring `ChatProgressIcon` for GUI
 * chats. Epic-wide active-agent awareness is the sole authority here - a TUI
 * agent's PTY runs host-side, so there is no renderer run-status to smooth
 * against and no waiting-for-approval state to style.
 */
function TerminalAgentProgressIcon(props: { readonly nodeId: string }) {
  const isActive = useEpicActiveAgentIds().has(props.nodeId);
  const harnessId = useMaybeEpicTuiAgentHarnessId(props.nodeId);
  const icon = useNodeIconDisplay("terminal-agent");
  if (!isActive) {
    // The underlying harness's brand mark (Claude, Codex, …) so the row reads
    // as the tool driving the agent. Brand marks keep their own colors and
    // intentionally don't follow the per-type icon-color customization; the
    // generic bot glyph is the fallback for unresolved/legacy records.
    if (harnessId !== null) {
      return (
        <SidebarAgentHarnessIcon nodeId={props.nodeId} harnessId={harnessId} />
      );
    }
    return <StaticSidebarNodeIcon artifactType="terminal-agent" />;
  }
  return (
    <span
      className={cn("inline-flex items-center justify-center", icon.className)}
      style={icon.style}
      title="Agent in progress"
    >
      <AgentSpinningDots
        className="text-current"
        testId="terminal-agent-sidebar-spinner"
        variant={undefined}
      />
    </span>
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
  return (
    <span
      data-testid={`sidebar-agent-harness-${props.nodeId}`}
      data-agent-surface="tui"
      className="relative inline-flex h-3.5 w-[1.125rem] shrink-0 items-center"
      title="TUI terminal agent"
    >
      <HarnessIcon harnessId={props.harnessId} className="size-3.5" />
      <TerminalIcon
        aria-hidden="true"
        data-testid={`sidebar-agent-surface-${props.nodeId}`}
        data-agent-surface="tui"
        className="pointer-events-none absolute -right-1 -bottom-1.5 size-2 text-muted-foreground"
        strokeWidth={3}
      />
    </span>
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
  readonly artifactType: EpicNodeKind;
  readonly updatedAt: number;
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
    artifactType,
    updatedAt,
    renameInputRef,
    renameValue,
    onRenameValueChange,
    onBlur,
    onKeyDown,
    renamePending,
    nodeName,
    nodeId,
  } = props;
  // Two-line scaffold parity with the display row: the same chevron spacer and
  // leading icon sit centered beside a column whose row 1 is the rename input,
  // and the same self-collapsing row-2 slot follows, so nothing shifts
  // horizontally or vertically between viewing and renaming a two-line row.
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
        <ChatRowLeadingIcon
          epicId={epicId}
          nodeId={nodeId}
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
          {/* The pre-refactor rename row rendered the (status-bearing) icon
              slot via `ChatSidebarNodeIcon`, which was NOT the rollup-aware
              variant - so renaming keeps showing this row's OWN status, not a
              nested one. */}
          <ChatOwnStatusChip
            epicId={epicId}
            nodeId={nodeId}
            artifactType={artifactType}
            updatedAt={updatedAt}
          />
        </div>
        <ChatRowSecondLine
          epicId={epicId}
          nodeId={nodeId}
          artifactType={artifactType}
        />
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
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly updatedAt: number;
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
 * Dimming for a revealed archived row. Only reachable with "Show archived" on -
 * otherwise the row is not rendered at all.
 */
const ARCHIVED_ROW_CLASS = "opacity-55";

// Only chats and terminal-agents own a resource-tracked process tree; other
// node kinds (specs, tickets, …) never carry a resource snapshot.
function resourceOwnerKindForNode(
  artifactType: EpicNodeKind,
): ResourceOwnerKindWire | null {
  if (artifactType === "chat") return "chat";
  if (artifactType === "terminal-agent") return "terminal-agent";
  return null;
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
    hasChildren,
    expanded,
    updatedAt,
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
  const dragData = useMemo<EpicCanvasSidebarNodeDragData>(
    () => ({
      kind: SIDEBAR_NODE_DND_TYPE,
      epicId,
      viewTabId,
      nodeId,
    }),
    [epicId, nodeId, viewTabId],
  );
  const {
    attributes,
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getSidebarNodeDragId(nodeId),
    disabled: selectionMode,
    data: dragData,
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
  const ownerHostId = useEpicNodeHostId(nodeId);
  const ownerKind = useEpicNodeOwnerKind(nodeId);

  // Only the "⋯" more menu now reveals on hover (the standalone "+" moved into
  // that menu as "New child agent"), so the single-control pad-right reserve is
  // claimed whenever the row is editable and not bulk-selecting.
  const showRowControls = selectionMode ? false : canEdit;
  // Two-line rows: `min-h-7` keeps a single-line row at the old height while a
  // fed row-2 slot grows the row. The row itself is a horizontal flex -
  // chevron, leading icon, then the two-line text column - and `items-center`
  // is what centers the chevron and the leading icon across BOTH lines. No
  // fixed height is involved: the column is the tallest child, so the short
  // ones center against whatever height it happens to take.
  const rowClassName = cn(
    "flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left text-ui-sm font-normal transition-colors",
    "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
    isDragging && "cursor-grabbing opacity-60",
    nodePadRightClass(showRowControls, reserveArchiveSlot),
    selectionMode && "cursor-pointer",
    isArchived && ARCHIVED_ROW_CLASS,
    isActive
      ? "bg-accent text-accent-foreground"
      : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
  );
  const selectionInputId = `epic-sidebar-select-input-${nodeId}`;

  if (selectionMode) {
    return (
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
            artifactType={artifactType}
          />
        </ChatRowLeadingIconSlot>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate">{nodeName}</span>
            {/* Selection mode is exactly when users act on rows in bulk, so the
                status signal (and a collapsed parent's rollup) has to survive
                here - the pre-refactor icon slot rendered in this variant too.
                The archive hover button is a sibling of the row and is simply
                not rendered in this variant. */}
            <ChatRowStatusSlot
              epicId={epicId}
              nodeId={nodeId}
              artifactType={artifactType}
              hasChildren={hasChildren}
              expanded={expanded}
              updatedAt={updatedAt}
            />
          </span>
          <ChatRowSecondLine
            epicId={epicId}
            nodeId={nodeId}
            artifactType={artifactType}
          />
        </span>
      </label>
    );
  }

  const button = (
    <button
      ref={dragRef}
      {...attributes}
      {...listeners}
      type="button"
      // Explicit, so the row's accessible name is its TITLE rather than a
      // concatenation of everything inside it. Row 2 now carries branch text,
      // a "+N" badge and one PR icon per detected pull request, each with its
      // own accessible name - without this the row announced as
      // "T04 shell… traycer/notif-shell +2 Open PR #512 Open #512, …".
      aria-label={nodeName}
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
          artifactType={artifactType}
        />
      </ChatRowLeadingIconSlot>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">{nodeName}</span>
          {resourceOwnerKind === null || !showNavigatorResourceStats ? null : (
            <OwnerResourceChip
              epicId={epicId}
              kind={resourceOwnerKind}
              ownerId={nodeId}
              className={undefined}
            />
          )}
          {/* Completes the hover SWAP the design calls for: while the archive
              button is mounted, hovering the row hides the idle time so the
              button takes its place rather than sitting alongside it.
              `invisible` (not `hidden`) so the slot keeps its width and row 1
              does not reflow under the pointer.

              This blanks the WHOLE slot, so it is safe only while the slot is
              showing the idle time. `chatRowArchiveState` guarantees that: it
              withholds the button (and therefore this class) whenever the slot
              could instead be rendering a collapsed parent's descendant
              rollup, which must stay readable on hover.

              Scoped to the TRAILING slot only - the leading icon is outside
              this span, so the swap never blanks a row's identity glyph. */}
          <span
            className={cn(
              "flex-none",
              reserveArchiveSlot && "group-hover/tree-item:invisible",
            )}
          >
            <ChatRowStatusSlot
              epicId={epicId}
              nodeId={nodeId}
              artifactType={artifactType}
              hasChildren={hasChildren}
              expanded={expanded}
              updatedAt={updatedAt}
            />
          </span>
        </span>
        <ChatRowSecondLine
          epicId={epicId}
          nodeId={nodeId}
          artifactType={artifactType}
        />
      </span>
    </button>
  );
  if (ownerHostId === null || ownerKind === null) return button;
  return (
    <WorktreeOwnerMetadataTooltip
      trigger={button}
      hostId={ownerHostId}
      epicId={epicId}
      ownerId={nodeId}
      ownerKind={ownerKind}
    />
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

interface ChatRowStatusProps {
  readonly epicId: string;
  readonly nodeId: string;
  readonly artifactType: EpicNodeKind;
  readonly updatedAt: number;
}

/**
 * Trailing status slot for row 1 - the redesign moves status off the removed
 * leading icon and onto the right of the title as a text + glyph chip (or a
 * muted relative last-activity time when idle). Every row shows its own status;
 * a collapsed parent additionally merges its hidden descendants' rollup, so the
 * chip and the rollup can't both claim the slot.
 */
function ChatRowStatusSlot(
  props: ChatRowStatusProps & {
    readonly hasChildren: boolean;
    readonly expanded: boolean;
  },
): ReactNode {
  if (props.hasChildren && !props.expanded) {
    return (
      <ChatRowStatusWithNestedRollup
        epicId={props.epicId}
        nodeId={props.nodeId}
        artifactType={props.artifactType}
        updatedAt={props.updatedAt}
      />
    );
  }
  return (
    <ChatOwnStatusChip
      epicId={props.epicId}
      nodeId={props.nodeId}
      artifactType={props.artifactType}
      updatedAt={props.updatedAt}
    />
  );
}

/**
 * Trailing slot for a collapsed parent. Merges the parent's own status with the
 * hidden descendants' rollup on the shared ladder: the more urgent one owns the
 * slot, ties go to the parent - so a hidden failure can never sit invisible
 * behind a parent that is merely running, and the rollup renders exactly where
 * users read a row's own status. When the parent's own status wins it renders
 * the same chip a leaf row shows. Mounted only for collapsed parents, so rows
 * without a rollup carry none of these subscriptions.
 */
const ChatRowStatusWithNestedRollup = memo(
  function ChatRowStatusWithNestedRollup(props: ChatRowStatusProps) {
    const rollup = useChatDescendantStatus({
      epicId: props.epicId,
      nodeId: props.nodeId,
    });
    const activityTiers = useEpicAgentActivityTiers();
    const selfIndicator = useSurfaceNotificationIndicatorState({
      epicId: props.epicId,
      chatId: props.nodeId,
    });
    if (rollup !== null) {
      const selfTier = activityTiers.get(props.nodeId);
      // Terminal-agent parents have no notification states of their own -
      // activity is their only tier (their indicator entry is always empty).
      const agentSelfRank =
        selfTier === undefined
          ? 0
          : CHAT_STATUS_RANKS[activityTierKind(selfTier)];
      const selfRank =
        props.artifactType === "chat"
          ? chatSelfStatusRank(selfIndicator, selfTier)
          : agentSelfRank;
      if (CHAT_STATUS_RANKS[rollup.kind] > selfRank) {
        return <NestedChatStatusIcon nodeId={props.nodeId} rollup={rollup} />;
      }
    }
    return (
      <ChatOwnStatusChip
        epicId={props.epicId}
        nodeId={props.nodeId}
        artifactType={props.artifactType}
        updatedAt={props.updatedAt}
      />
    );
  },
);

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
    <span
      role="status"
      aria-label={title}
      title={title}
      data-testid={`chat-descendant-status-${props.rollup.kind}-${props.nodeId}`}
      className="inline-flex size-3.5 shrink-0 items-center justify-center opacity-60"
    >
      <NestedChatStatusGlyph kind={props.rollup.kind} />
    </span>
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
 * The row's own trailing status kind. `idle` means nothing notable - the slot
 * falls back to a muted relative last-activity time.
 */
type ChatOwnStatusKind =
  | "failure"
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
 * approval) > running turn > background > unread-done > default. `state` is
 * empty for terminal-agent rows (they carry no host notification state), so
 * those rows only ever reach the running / default arms.
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
  if (tone === INTERVIEW_TONE) return "interview";
  if (tone === APPROVAL_TONE) return "approval";
  if (running === "turn") return "working";
  if (running === "background") return "background";
  if (state.unreadDone) return "done";
  if (isReadOnly) return "read-only";
  return "idle";
}

interface ChatOwnStatusPresentation {
  readonly text: string;
  readonly label: string;
  readonly className: string;
}

// Chip text + accessible label + tone class per status. The glyph and its color
// come through so the chip cannot drift from the notification tones; `working`
// and `background` are activity tiers (not notification states) so they carry
// local presentation.
const CHAT_OWN_STATUS_PRESENTATION: Record<
  Exclude<ChatOwnStatusKind, "idle">,
  ChatOwnStatusPresentation
> = {
  failure: {
    text: "Needs attention",
    label: FAILURE_TONE.title,
    className: FAILURE_TONE.className,
  },
  interview: {
    text: "Interview",
    label: INTERVIEW_TONE.title,
    className: INTERVIEW_TONE.className,
  },
  approval: {
    text: "Approval",
    label: APPROVAL_TONE.title,
    className: APPROVAL_TONE.className,
  },
  working: {
    text: "Working",
    label: "Agent in progress",
    className: "text-primary",
  },
  background: {
    text: "Background",
    label: "Background activity — agent idle",
    className: "text-muted-foreground",
  },
  // Accessible name kept identical to the pre-refactor lock icon so the
  // read-only signal reads the same to assistive tech as it did before.
  "read-only": {
    text: "Read-only",
    label: "Read-only agent",
    className: "text-muted-foreground",
  },
  done: {
    text: "Done",
    label: DONE_TONE.title,
    className: DONE_TONE.className,
  },
};

/**
 * A row's own trailing status chip. Resolves the turn-vs-background authority
 * before presenting: an OPEN chat's session tri-state (`chatActivityIndicator`)
 * is authoritative, because the epic-awareness bit also spans background-only
 * phases - letting it force the turn spinner would re-conflate the two tiers on
 * any host that does not publish `AGENT_WORKING_TURN_AWARENESS_FIELD` (a
 * steady state, not a rollout window). Awareness tiers remain the fallback for
 * unopened rows, which have no session to ask.
 *
 * The session read is deliberately narrow: `useExistingChatSessionHandle` only
 * resolves a handle for chats that are actually open, so the extra store
 * subscriptions are paid by those few rows rather than by every row. Note the
 * narrowing bounds THIS chip's cost, not the row's total: the status-aware
 * leading `ChatProgressIcon` makes the same session read on every chat row by
 * design - an accepted cost of keeping that icon.
 */
function ChatOwnStatusChip(props: ChatRowStatusProps): ReactNode {
  const indicatorState = useSurfaceNotificationIndicatorState({
    epicId: props.epicId,
    chatId: props.nodeId,
  });
  const awarenessTier = useEpicAgentActivityTiers().get(props.nodeId);
  const sessionHandle = useExistingChatSessionHandle(
    props.epicId,
    props.nodeId,
  );
  const isViewer = useContext(SidebarViewerContext);
  // Terminal-agent rows have no chat session and never carried a read-only
  // lock (their PTY runs host-side), so the viewer arm is chat-only.
  const isChat = props.artifactType === "chat";
  // Hoisted out of the JSX deliberately: `bun run lint` runs `eslint --fix`, and
  // the JSX-leaked-render rule rewrites an inline `{a && b}` attribute into
  // `{a ? b : null}`. That widens this to `boolean | null` and breaks
  // `ChatOwnStatusChipPresentation`'s `isReadOnly: boolean` prop, so the value
  // is computed here where the autofix does not reach.
  const isReadOnlyRow = isChat && isViewer;
  if (sessionHandle === null || !isChat) {
    return (
      <ChatOwnStatusChipPresentation
        nodeId={props.nodeId}
        indicatorState={indicatorState}
        running={awarenessTier ?? false}
        isReadOnly={isReadOnlyRow}
        updatedAt={props.updatedAt}
      />
    );
  }
  return (
    <ChatOwnStatusChipWithSession
      handle={sessionHandle}
      nodeId={props.nodeId}
      indicatorState={indicatorState}
      awarenessTier={awarenessTier}
      updatedAt={props.updatedAt}
    />
  );
}

/**
 * The open-session arm. `useStore(api, selector)` (not the bound-store call
 * form) so the React Compiler still sees a hook, and each selector collapses to
 * a primitive / stable slot so queue and background-item array churn cannot
 * re-render the chip.
 */
function ChatOwnStatusChipWithSession(props: {
  readonly handle: ChatSessionStoreHandle;
  readonly nodeId: string;
  readonly indicatorState: NotificationIndicatorState;
  readonly awarenessTier: AgentActivityTier | undefined;
  readonly updatedAt: number;
}): ReactNode {
  const activity = useStore(props.handle.store, (state) =>
    chatActivityIndicator(state),
  );
  const access = useStore(props.handle.store, (state) => state.access);
  return (
    <ChatOwnStatusChipPresentation
      nodeId={props.nodeId}
      indicatorState={props.indicatorState}
      // Session tri-state wins; awareness only backfills the brief
      // subscription-gap window where the session still reads idle.
      running={activity ?? props.awarenessTier ?? false}
      // A session's access snapshot is authoritative. Stay neutral while it is
      // unknown so an owner never sees a lock flash before it arrives.
      isReadOnly={access !== null && access.role !== "owner"}
      updatedAt={props.updatedAt}
    />
  );
}

/**
 * Pure presentation for a resolved status. Tone colors come from
 * `notification-indicator-tones.ts` so the chip cannot drift from the per-row
 * notification icon it replaces.
 */
function ChatOwnStatusChipPresentation(props: {
  readonly nodeId: string;
  readonly indicatorState: NotificationIndicatorState;
  readonly running: IndicatorRunningKind;
  readonly isReadOnly: boolean;
  readonly updatedAt: number;
}): ReactNode {
  const kind = chatOwnStatusKind(
    props.indicatorState,
    props.running,
    props.isReadOnly,
  );
  if (kind === "idle") {
    return (
      <ChatRowIdleTime nodeId={props.nodeId} updatedAt={props.updatedAt} />
    );
  }
  const presentation = CHAT_OWN_STATUS_PRESENTATION[kind];
  return (
    <span
      role="status"
      aria-label={presentation.label}
      // Kept even though `aria-label` duplicates it: the chip's VISIBLE text is
      // the short `presentation.text` ("Background"), so the native tooltip is
      // the only way a sighted mouse user gets the full
      // "Background activity — agent idle" detail. (The idle slot is the
      // opposite case - its title would repeat its own visible text verbatim,
      // so it has none.)
      title={presentation.label}
      data-testid={`chat-row-status-${kind}-${props.nodeId}`}
      className={cn(
        "flex-none inline-flex items-center gap-1 text-ui-xs",
        presentation.className,
      )}
    >
      <ChatOwnStatusGlyph kind={kind} />
      <span>{presentation.text}</span>
    </span>
  );
}

/**
 * Idle-slot muted relative time, in the reference design's compact form ("now",
 * "23m", "3h", "6d", then a short date) rather than the verbose app-wide
 * phrasing - the trailing slot competes with the title for truncation space, so
 * every character costs. A leaf component so only idle rows subscribe to the
 * shared 60s clock; a running/attention/done chip never pays for the tick.
 */
function ChatRowIdleTime(props: {
  readonly nodeId: string;
  readonly updatedAt: number;
}): ReactNode {
  const now = useSampledNow();
  return (
    <span
      data-testid={`chat-row-status-idle-${props.nodeId}`}
      className="flex-none text-ui-xs tabular-nums text-muted-foreground"
    >
      {compactRelativeTime(props.updatedAt, now)}
    </span>
  );
}

const COMPACT_MINUTE_MS = 60_000;
const COMPACT_HOUR_MS = 60 * COMPACT_MINUTE_MS;
const COMPACT_DAY_MS = 24 * COMPACT_HOUR_MS;
const COMPACT_WEEK_MS = 7 * COMPACT_DAY_MS;

/**
 * Compact last-activity label. Negative deltas (a clock-skewed `updatedAt` in
 * the future) clamp to "now" rather than rendering a negative age.
 */
function compactRelativeTime(updatedAt: number, now: number): string {
  const diffMs = Math.max(0, now - updatedAt);
  if (diffMs < COMPACT_MINUTE_MS) return "now";
  if (diffMs < COMPACT_HOUR_MS) {
    return `${Math.floor(diffMs / COMPACT_MINUTE_MS)}m`;
  }
  if (diffMs < COMPACT_DAY_MS) {
    return `${Math.floor(diffMs / COMPACT_HOUR_MS)}h`;
  }
  if (diffMs < COMPACT_WEEK_MS) {
    return `${Math.floor(diffMs / COMPACT_DAY_MS)}d`;
  }
  return new Date(updatedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * The chip glyph. `working` is the busy spinner; `background` the muted
 * background-activity glyph; the attention / done kinds reuse the shared
 * notification-tone icons (color inherited from the chip's tone class via
 * `currentColor`), so the chip and the nested rollup share one glyph source.
 */
function ChatOwnStatusGlyph(props: {
  readonly kind: Exclude<ChatOwnStatusKind, "idle">;
}): ReactNode {
  if (props.kind === "read-only") {
    return <MessageSquareLock aria-hidden className="size-3.5" />;
  }
  if (props.kind === "working") {
    return (
      <AgentSpinningDots
        className="text-current"
        testId={undefined}
        variant={undefined}
      />
    );
  }
  if (props.kind === "background") {
    return <BackgroundActivityGlyph testId={undefined} />;
  }
  const Icon = CHAT_DESCENDANT_STATUS_TONES[props.kind].Icon;
  return <Icon aria-hidden className="size-3.5" />;
}

/**
 * The row's archive menu state, or `null` on a host that lacks
 * `epic.setChatArchived` - in which case the entry is absent from both menus
 * rather than present-but-disabled.
 */
interface ChatRowArchiveEntry {
  readonly isArchived: boolean;
  readonly disabled: boolean;
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
 * Both archive affordances for a row, decided together so the menu entry and
 * the hover button can never disagree. Only called for rows whose host
 * supports the method.
 *
 * They are deliberately gated differently. The MENU entry is the complete,
 * keyboard-reachable surface: present on every row, merely disabled while the
 * row is busy. The hover BUTTON is a pointer shortcut that TAKES OVER the
 * trailing status slot, so it may only appear when that slot is showing the
 * idle time and nothing else.
 *
 * That last condition is stricter than "my own status is idle", which is why
 * `hasChildren`/`expanded` are inputs. A COLLAPSED PARENT's slot renders
 * `ChatRowStatusWithNestedRollup`, which may show a muted rollup glyph standing
 * in for a hidden descendant that needs attention - the only signal those
 * descendants have. Showing the button there would blank that glyph on hover
 * and offer to archive the whole subtree, failure included. The shell cannot
 * tell which way the rollup resolved without duplicating its subscription, so
 * every collapsed parent is excluded; the menu entry stays the archive path for
 * those rows.
 */
function chatRowArchiveState(args: {
  readonly canMutate: boolean;
  readonly isArchived: boolean;
  readonly archivePending: boolean;
  readonly statusKind: ChatOwnStatusKind;
  readonly selectionMode: boolean;
  readonly isRenaming: boolean;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}): ChatRowArchiveDecision {
  const isBusy =
    args.statusKind === "working" || args.statusKind === "background";
  const slotMayShowRollup = args.hasChildren && !args.expanded;
  return {
    entry: {
      isArchived: args.isArchived,
      disabled: isBusy || args.archivePending,
    },
    showButton:
      args.canMutate &&
      args.statusKind === "idle" &&
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
 * The row's resolved own status kind, for consumers OUTSIDE the trailing chip -
 * today the archive affordances, which must appear only on an idle row and stay
 * disabled while one is working.
 *
 * Resolves through the same `chatOwnStatusKind` lattice the chip renders from,
 * so the two can never disagree, but reads an open chat's session through
 * `useSyncExternalStore` rather than the chip's parent/child component split.
 * A hook cannot use that split - `useStore` can't be called conditionally on a
 * nullable handle - and the snapshots here are deliberately PRIMITIVES, so this
 * re-renders its caller only when the kind actually flips rather than on every
 * queue or background-item tick of an open chat.
 *
 * Same authority order as the chip: an open chat's session tri-state wins,
 * epic awareness backfills the subscription-gap window and covers unopened
 * rows, and a session's own access snapshot overrides the epic-level viewer
 * role.
 */
function useChatRowOwnStatusKind(args: {
  readonly epicId: string;
  readonly nodeId: string;
  readonly artifactType: EpicNodeKind;
}): ChatOwnStatusKind {
  const { epicId, nodeId, artifactType } = args;
  const indicatorState = useSurfaceNotificationIndicatorState({
    epicId,
    chatId: nodeId,
  });
  const awarenessTier = useEpicAgentActivityTiers().get(nodeId);
  const isViewer = useContext(SidebarViewerContext);
  // Terminal-agent rows have no chat session and never carried a read-only
  // lock (their PTY runs host-side), so the viewer arm is chat-only.
  const isChat = artifactType === "chat";
  const sessionHandle = useExistingChatSessionHandle(epicId, nodeId);
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
    return chatOwnStatusKind(
      indicatorState,
      awarenessTier ?? false,
      isChat && isViewer,
    );
  }
  return chatOwnStatusKind(
    indicatorState,
    sessionActivity ?? awarenessTier ?? false,
    // Stay neutral while the access snapshot is unknown so an owner never sees
    // a read-only row flash before it arrives.
    sessionRole !== null && sessionRole !== "owner",
  );
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
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
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
