/**
 * Chat/terminal-agent tree body for the sidebar. Renders the tree of chat nodes
 * with expansion, rename, delete, and drag-drop behaviors.
 */
import { useDraggable } from "@dnd-kit/core";
import { v4 as uuidv4 } from "uuid";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  useEpicDeleteChat,
  useEpicRenameChat,
} from "@/hooks/epic/use-epic-chat-mutations";
import {
  useEpicDeleteTuiAgent,
  useEpicRenameTuiAgent,
} from "@/hooks/epic/use-epic-tui-agent-mutations";
import {
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
  useEpicAgentActivityTiers,
  type AgentActivityTier,
  useEpicArtifactRecords,
  useEpicConnectionStatus,
  useEpicNodeHostId,
  useEpicNodeOwnerKind,
  useEpicPermissionRole,
  useEpicTreeIndex,
  useEpicTreeNode,
} from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
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
 * `useEpicPermissionRole()` the way the removed leading icon did. A row's OWN
 * chat session access overrides it when that chat is open.
 */
const SidebarViewerContext = createContext<boolean>(false);

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
  const visibleIds = useChatVisibleIds(epicId);
  const rootIds = useMemo(
    () => applyVisibleFilter(allRootIds, visibleIds),
    [allRootIds, visibleIds],
  );
  const tree = useEpicTreeIndex();
  const activeArtifactId = useActiveEpicArtifactId(tabId);
  const permissionRole = useEpicPermissionRole();
  const connectionStatus = useEpicConnectionStatus();
  const isDisconnected = connectionStatus === "closed";
  const canEdit = isEditableRole(permissionRole);
  const canMutate = canEdit && !isDisconnected;
  // Read-only (viewer) indication is epic-level, so it is resolved ONCE here
  // and threaded down as a boolean rather than re-subscribing every row to
  // `useEpicPermissionRole()` the way the removed leading icon did. `viewer`
  // specifically - a null (not-yet-known) role must not flash the lock.
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
  const forcedExpandedIds = useMemo(
    () => mergeForcedExpanded(ancestorIdsOfActive, visibleIds),
    [ancestorIdsOfActive, visibleIds],
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
    visibleIds,
    rootIds,
    localRootPending,
    acknowledgedRootPending,
    preAckRootCreates,
    visiblePendingRootCreates,
  });
  const showEmptyState =
    visibleIds === null && allRootIds.length === 0 && !hasPendingRootRows;

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
  readonly treeFilter: TreeFilterFn;
  readonly selectionMode: boolean;
  readonly isSelected: boolean;
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggleSelection: (id: string) => void;
}

function ChatNodeShell(props: ChatNodeShellProps) {
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
  const rowMenuEntries = chatRowMenuEntries({
    nodeId,
    canMutate,
    onNewChildAgent: handleNewChildAgent,
    onStartRename,
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
          />
        )}

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
  // Two-line scaffold parity with the display row: the rename input owns row 1
  // (no leading icon), and the same self-collapsing row-2 slot follows so the
  // row height doesn't jump between viewing and renaming a two-line row.
  return (
    <div
      className="flex min-h-7 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-md px-2 py-1"
      style={{
        paddingLeft: `${depth * INDENT_PX + BASE_PAD_LEFT}px`,
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <TreeChevronSpacer />
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
        {/* The pre-refactor rename row rendered the (status-bearing) icon slot
            via `ChatSidebarNodeIcon`, which was NOT the rollup-aware variant -
            so renaming keeps showing this row's OWN status, not a nested one. */}
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
  // fed row-2 slot grows the row; `flex-col` stacks row 1 over the row-2 slot.
  const rowClassName = cn(
    "flex min-h-7 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-md py-1 text-left text-ui-sm font-normal transition-colors",
    "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
    isDragging && "cursor-grabbing opacity-60",
    nodePadRightClass(showRowControls, false),
    selectionMode && "cursor-pointer",
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
        <span className="flex min-w-0 items-center gap-1.5">
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
          <span className="min-w-0 flex-1 truncate">{nodeName}</span>
          {/* Selection mode is exactly when users act on rows in bulk, so the
              status signal (and a collapsed parent's rollup) has to survive
              here - the pre-refactor icon slot rendered in this variant too. */}
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
      </label>
    );
  }

  const button = (
    <button
      ref={dragRef}
      {...attributes}
      {...listeners}
      type="button"
      data-testid={`epic-sidebar-item-${nodeId}`}
      data-artifact-type={artifactType}
      className={rowClassName}
      style={{
        paddingLeft: `${depth * INDENT_PX + BASE_PAD_LEFT}px`,
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <NodeChevron
          hasChildren={hasChildren}
          expanded={expanded}
          onToggle={onToggle}
        />
        <span className="min-w-0 flex-1 truncate">{nodeName}</span>
        {resourceOwnerKind === null || !showNavigatorResourceStats ? null : (
          <OwnerResourceChip
            epicId={epicId}
            kind={resourceOwnerKind}
            ownerId={nodeId}
            className={undefined}
          />
        )}
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
 * subscriptions are paid by those few rows rather than by every row the way the
 * removed leading icon did.
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

interface ChatRowMenuEntriesProps {
  readonly nodeId: string;
  readonly canMutate: boolean;
  readonly onNewChildAgent: () => void;
  readonly onStartRename: () => void;
  readonly onPerformDelete: () => void;
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
