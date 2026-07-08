/**
 * Chat/terminal-agent tree body for the sidebar. Renders the tree of chat nodes
 * with expansion, rename, delete, and drag-drop behaviors.
 */
import { useDraggable } from "@dnd-kit/core";
import { v4 as uuidv4 } from "uuid";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  useEpicDeleteChat,
  useEpicRenameChat,
} from "@/hooks/epic/use-epic-chat-mutations";
import {
  useEpicDeleteTuiAgent,
  useEpicRenameTuiAgent,
} from "@/hooks/epic/use-epic-tui-agent-mutations";
import {
  EPIC_NODE_ICONS,
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
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  useEpicActiveAgentIds,
  useEpicArtifactRecords,
  useEpicConnectionStatus,
  useEpicPermissionRole,
  useEpicTreeIndex,
  useEpicTreeNode,
  useMaybeEpicTuiAgentHarnessId,
} from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  Check,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  BASE_PAD_LEFT,
  EMPTY_PENDING_LIST,
  EMPTY_PRE_ACK_LIST,
  INDENT_PX,
  anyMutationPending,
  nodePadRightClass,
  rowAddControlRevealClass,
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
import { NewConversationModalAction } from "@/components/epic-canvas/sidebar/new-conversation-modal";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";

interface ChatTreePanelBodyProps {
  readonly epicId: string;
  readonly tabId: string;
}

type TreeFilterFn = (type: string | null | undefined) => boolean;

const CHATS_TREE_FILTER: TreeFilterFn = (type) =>
  type === "chat" || type === "terminal-agent";

const EMPTY_SELECTED_IDS: ReadonlySet<string> = new Set<string>();
const noopToggleSelection = (_id: string): void => undefined;
const noopRowAction = (): void => undefined;

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
        title="No chats yet."
        description={null}
        testId="epic-chat-sidebar-empty"
      />
    );
  } else if (filteredTreeEmpty) {
    panelContent = (
      <SidebarPanelEmptyState
        icon={MessagesSquare}
        title="No chats match the filter."
        description={null}
        testId="epic-chat-sidebar-filter-empty"
      />
    );
  } else {
    panelContent = (
      <ul role="tree" aria-label="Epic chats tree" className="space-y-0.5">
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
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);
  const closeCanvasTab = useEpicCanvasStore((s) => s.closeCanvasTab);
  const openTilePreviewInTab = useEpicCanvasStore(
    (s) => s.openTilePreviewInTab,
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
  const openableType: OpenableEpicNodeKind | null = isOpenableEpicNodeKind(
    artifactType,
  )
    ? artifactType
    : null;
  // Per-node boolean subscription: re-renders this node only when ITS active
  // state flips, not on every selection.
  const isActive = useIsActiveEpicArtifact(tabId, nodeId);
  const Icon = EPIC_NODE_ICONS[artifactType];
  const artifactIconColorMode = useSettingsStore(
    (state) => state.artifactIconColorMode,
  );
  const iconColor = useSettingsStore(
    (state) => state.artifactIconColors[artifactType],
  );
  const iconStyle =
    artifactIconColorMode === "byType" ? { color: iconColor } : undefined;

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
    openTilePreviewInTab(tabId, {
      id: nodeId,
      instanceId: uuidv4(),
      type: openableType,
      name: nodeName,
      hostId: activeHostId,
    });
  }, [
    activeHostId,
    isRenaming,
    nodeName,
    nodeId,
    openTilePreviewInTab,
    openableType,
    tabId,
  ]);

  const handleDoubleClick = useCallback(() => {
    if (isRenaming) return;
    if (openableType === null) return;
    const found = findOpenArtifactInTab(tabId, nodeId);
    if (found !== null) {
      promotePreviewInTab(tabId, found.paneId);
    } else {
      openTileInTab(tabId, {
        id: nodeId,
        instanceId: uuidv4(),
        type: openableType,
        name: nodeName,
        hostId: activeHostId,
      });
    }
  }, [
    activeHostId,
    isRenaming,
    nodeId,
    nodeName,
    openableType,
    openTileInTab,
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
        closeCanvasTab(tabId, found.paneId, found.instanceId);
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
      Icon={Icon}
      artifactIconColorMode={artifactIconColorMode}
      iconStyle={iconStyle}
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
  readonly Icon: LucideIcon;
  readonly artifactIconColorMode: "byType" | "none";
  readonly iconStyle: { color: string | undefined } | undefined;
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
    Icon,
    artifactIconColorMode,
    iconStyle,
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

  // The row `+` (child-create trigger) reserves right padding and is offered
  // whenever the epic is editable and we are not bulk-selecting.
  const showAddChild = canEdit && !selectionMode;

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
      >
        {isRenaming ? (
          <ChatRenameRow
            epicId={epicId}
            depth={depth}
            Icon={Icon}
            artifactIconColorMode={artifactIconColorMode}
            iconStyle={iconStyle}
            artifactType={artifactType}
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
            onToggle={onToggle}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            Icon={Icon}
            artifactIconColorMode={artifactIconColorMode}
            iconStyle={iconStyle}
            selectionMode={selectionMode}
            isSelected={isSelected}
            onToggleSelection={onToggleSelection}
            showAddChild={showAddChild}
          />
        )}

        {canEdit && !isRenaming && !selectionMode ? (
          // Same trigger + modal as the chats-panel `+`, seeded as a child of
          // this row. No dropdown: the modal's switcher is the one way to pick a
          // chat vs a terminal agent.
          <NewConversationModalAction
            epicId={epicId}
            tabId={tabId}
            parentId={nodeId}
            size="icon-xs"
            disabled={!canMutate}
            disabledTooltip={
              isDisconnected ? "Reconnect to make changes." : null
            }
            triggerLabel="Add child chat or agent"
            triggerTestId={`epic-sidebar-add-${nodeId}`}
            actionRevealClassName={cn(
              "absolute right-7 top-1/2 -translate-y-1/2",
              rowAddControlRevealClass(false),
            )}
          />
        ) : null}

        {canEdit && !isRenaming && !selectionMode ? (
          <ChatMoreMenu
            nodeId={nodeId}
            nodeName={nodeName}
            canMutate={canMutate}
            onStartRename={onStartRename}
            onPerformDelete={onPerformDelete}
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
        title={`Delete ${artifactType} "${nodeName}"?`}
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
  readonly Icon: LucideIcon;
  readonly artifactIconColorMode: "byType" | "none";
  readonly iconStyle: { color: string | undefined } | undefined;
  readonly artifactType: EpicNodeKind;
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
    Icon,
    artifactIconColorMode,
    iconStyle,
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
  return (
    <div
      className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2"
      style={{
        paddingLeft: `${depth * INDENT_PX + BASE_PAD_LEFT}px`,
      }}
    >
      <TreeChevronSpacer />
      <ChatSidebarNodeIcon
        epicId={epicId}
        nodeId={nodeId}
        artifactType={artifactType}
        Icon={Icon}
        artifactIconColorMode={artifactIconColorMode}
        iconStyle={iconStyle}
      />
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
  readonly showAddChild: boolean;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly onToggle: (event: React.MouseEvent<HTMLSpanElement>) => void;
  readonly onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  readonly onDoubleClick: () => void;
  readonly Icon: LucideIcon;
  readonly artifactIconColorMode: "byType" | "none";
  readonly iconStyle: { color: string | undefined } | undefined;
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
    showAddChild,
    hasChildren,
    expanded,
    onToggle,
    onClick,
    onDoubleClick,
    Icon,
    artifactIconColorMode,
    iconStyle,
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

  // A chat row's "+" (add child) and "⋯" (more menu) are both gated by canEdit
  // and hidden in selection mode, so both pad-right zones share one flag. The
  // "+" additionally hides when the row's host is offline, so the wider
  // two-control reserve is claimed only when the "+" actually renders.
  const showRowControls = selectionMode ? false : canEdit;
  const rowClassName = cn(
    "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-ui-sm font-normal transition-colors",
    "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
    isDragging && "cursor-grabbing opacity-60",
    nodePadRightClass(showRowControls, showRowControls && showAddChild),
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
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <ChatSidebarNodeIcon
            epicId={epicId}
            nodeId={nodeId}
            artifactType={artifactType}
            Icon={Icon}
            artifactIconColorMode={artifactIconColorMode}
            iconStyle={iconStyle}
          />
          <span className="min-w-0 flex-1 truncate">{nodeName}</span>
        </span>
      </label>
    );
  }

  return (
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
      <NodeChevron
        hasChildren={hasChildren}
        expanded={expanded}
        onToggle={onToggle}
      />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <ChatSidebarNodeIcon
          epicId={epicId}
          nodeId={nodeId}
          artifactType={artifactType}
          Icon={Icon}
          artifactIconColorMode={artifactIconColorMode}
          iconStyle={iconStyle}
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
      </span>
    </button>
  );
}

interface ChatSidebarNodeIconProps {
  readonly epicId: string;
  readonly nodeId: string;
  readonly artifactType: EpicNodeKind;
  readonly Icon: LucideIcon;
  readonly artifactIconColorMode: "byType" | "none";
  readonly iconStyle: { color: string | undefined } | undefined;
}

function ChatSidebarNodeIcon(props: ChatSidebarNodeIconProps) {
  if (props.artifactType === "chat") {
    return (
      <ChatProgressIcon
        epicId={props.epicId}
        chatId={props.nodeId}
        className={undefined}
        mutedClassName="text-muted-foreground/70"
        testId="chat-sidebar-spinner"
      />
    );
  }
  if (props.artifactType === "terminal-agent") {
    return (
      <TerminalAgentProgressIcon
        nodeId={props.nodeId}
        Icon={props.Icon}
        artifactIconColorMode={props.artifactIconColorMode}
        iconStyle={props.iconStyle}
      />
    );
  }
  return (
    <StaticSidebarNodeIcon
      Icon={props.Icon}
      artifactIconColorMode={props.artifactIconColorMode}
      iconStyle={props.iconStyle}
    />
  );
}

/**
 * Terminal-agent (TUI) sidebar icon. Swaps the static icon for the running
 * spinner while the agent is working, mirroring `ChatProgressIcon` for GUI
 * chats. Epic-wide active-agent awareness is the sole authority here - a TUI
 * agent's PTY runs host-side, so there is no renderer run-status to smooth
 * against and no waiting-for-approval state to style.
 */
function TerminalAgentProgressIcon(props: {
  readonly nodeId: string;
  readonly Icon: LucideIcon;
  readonly artifactIconColorMode: "byType" | "none";
  readonly iconStyle: { color: string | undefined } | undefined;
}) {
  const isActive = useEpicActiveAgentIds().has(props.nodeId);
  const harnessId = useMaybeEpicTuiAgentHarnessId(props.nodeId);
  if (!isActive) {
    // The underlying harness's brand mark (Claude, Codex, …) so the row reads
    // as the tool driving the agent. Brand marks keep their own colors and
    // intentionally don't follow the per-type icon-color customization; the
    // generic bot glyph is the fallback for unresolved/legacy records.
    if (harnessId !== null) {
      return (
        <HarnessIcon harnessId={harnessId} className="size-3.5 shrink-0" />
      );
    }
    return (
      <StaticSidebarNodeIcon
        Icon={props.Icon}
        artifactIconColorMode={props.artifactIconColorMode}
        iconStyle={props.iconStyle}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center",
        props.artifactIconColorMode === "none" && "text-muted-foreground/70",
      )}
      style={props.iconStyle}
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

function StaticSidebarNodeIcon(props: {
  readonly Icon: LucideIcon;
  readonly artifactIconColorMode: "byType" | "none";
  readonly iconStyle: { color: string | undefined } | undefined;
}) {
  const Icon = props.Icon;
  return (
    <Icon
      className={cn(
        "size-3.5 shrink-0",
        props.artifactIconColorMode === "none" && "text-muted-foreground/70",
      )}
      style={props.iconStyle}
    />
  );
}

interface SidebarNodeActionsProps {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly canMutate: boolean;
  readonly onStartRename: () => void;
  readonly onPerformDelete: () => void;
}

function ChatMoreMenu(props: SidebarNodeActionsProps) {
  const { nodeId, nodeName, canMutate, onStartRename, onPerformDelete } = props;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Chat actions for ${nodeName}`}
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
        <DropdownMenuItem
          data-testid={`epic-sidebar-rename-${nodeId}`}
          disabled={!canMutate}
          onSelect={() => {
            onStartRename();
          }}
        >
          <Pencil className="size-3.5" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid={`epic-sidebar-delete-${nodeId}`}
          disabled={!canMutate}
          onSelect={() => {
            onPerformDelete();
          }}
          variant="destructive"
        >
          <Trash2 className="size-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
