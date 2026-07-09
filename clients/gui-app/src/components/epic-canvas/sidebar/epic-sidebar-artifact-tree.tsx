/**
 * Artifact tree body for the sidebar. Renders specs, tickets, stories, and
 * their child artifacts with full tree navigation and management.
 */
import { useDraggable } from "@dnd-kit/core";
import { v4 as uuidv4 } from "uuid";
import {
  useEpicCreateArtifact,
  useEpicDeleteArtifact,
  useEpicRenameArtifact,
} from "@/hooks/epic/use-epic-node-mutations";
import {
  DEFAULT_EPIC_NODE_NAMES,
  EPIC_NODE_ICONS,
  isEpicArtifactKind,
  type EpicNodeKind,
} from "@/lib/artifacts/node-display";
import { AddNodeDropdown } from "@/components/epic-canvas/add-node-dropdown";
import {
  ARIA_DISABLED_TRIGGER_CLASS,
  resolveDisabledPresentation,
} from "@/lib/disabled-presentation";
import { ARTIFACT_PANEL_EXCLUDED_TYPES } from "@/components/epic-canvas/add-node-options";
import {
  computeDescendantCountsFromTree,
  formatCascadeSummary,
} from "@/lib/epic-tree-cascade";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { requestArtifactEditorFocus } from "@/lib/artifacts/pending-editor-focus";
import { openProjectedSidebarNodeInTabWhenAvailable } from "@/components/epic-canvas/sidebar/open-projected-sidebar-node";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { cn } from "@/lib/utils";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  isArtifactFilterActive,
  useAcknowledgedRootCreatePending,
  useArtifactFilter,
  useArtifactSort,
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
  type EpicNodeRef,
  type OpenableEpicNodeKind,
} from "@/stores/epics/canvas/types";
import {
  useEpicSidebarEffectiveExpanded,
  useEpicSidebarExpansionStore,
} from "@/stores/epics/epic-sidebar-expansion-store";
import {
  isArtifactUnread,
  useArtifactReadStateStore,
} from "@/stores/epics/artifact-read-state-store";
import {
  useAncestorIds,
  useEpicArtifactStatus,
  useEpicConnectionStatus,
  useEpicPermissionRole,
  useEpicTreeIndex,
  useEpicTreeNode,
  useRootIds,
} from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  Check,
  FileText,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  startTransition,
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
  STATUS_DOT_CLASSES,
  STATUS_LABELS,
  computeArtifactNodeAddChildPending,
  computeArtifactNodeStatusDot,
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
  useSidebarVisibleIds,
} from "./epic-sidebar-filter";
import {
  collectVisibleSidebarTreeIds,
  useMaybeSidebarBulkSelection,
} from "./epic-sidebar-selection";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useShallow } from "zustand/react/shallow";
import {
  getSidebarNodeDragId,
  SIDEBAR_NODE_DND_TYPE,
  type EpicCanvasSidebarNodeDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { SidebarReparentRowDropWrapper } from "@/components/epic-canvas/sidebar/sidebar-reparent-row-drop-wrapper";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import type { ArtifactsSlice, TreeSlice } from "@/stores/epics/open-epic/types";

interface ArtifactTreePanelBodyProps {
  readonly epicId: string;
  readonly tabId: string;
}

type TreeFilterFn = (type: string | null | undefined) => boolean;

const ARTIFACTS_TREE_FILTER: TreeFilterFn = (type) =>
  type !== null &&
  type !== undefined &&
  type !== "chat" &&
  type !== "terminal" &&
  type !== "terminal-agent";

const EMPTY_SELECTED_IDS: ReadonlySet<string> = new Set<string>();
const noopToggleSelection = (_id: string): void => undefined;
const noopRowAction = (): void => undefined;
const EMPTY_DESCENDANT_ENTRIES: ReadonlyArray<ArtifactDescendantEntry> = [];

interface ExpansionController {
  expandedIds: ReadonlySet<string>;
  toggleExpanded: (id: string) => void;
  ensureExpanded: (id: string) => void;
}

type ArtifactUnreadMarkerVariant = "self" | "descendant";

interface ArtifactReadSeedEntry {
  readonly id: string;
  readonly updatedAt: number;
}

interface ArtifactDescendantEntry {
  readonly id: string;
  readonly updatedAt: number;
}

function usePanelRootIds(
  comparator: NodeComparator | null,
): ReadonlyArray<string> {
  const yDocRootIds = useRootIds();
  // Filter roots by the TREE node's type, not the projected artifact records.
  // `useEpicArtifactRecords()` rebuilds a fresh record array (and fresh record
  // objects) on every store tick, so during chat streaming the active chat's
  // record changes identity each token and `liveRecords` churns - which used to
  // recompute this memo, churn `rootIds` -> `expandedIds` -> the `expansion`
  // controller, and re-render every memoized `ArtifactNode`. The tree index
  // (`s.tree`) does NOT change on chat tokens, and its `nodeById[id].type` is
  // the same value space this `treeFilter` already uses for CHILD nodes
  // (`usePanelChildIds`), so the result is identical but identity-stable while
  // streaming.
  const tree = useEpicTreeIndex();
  return useMemo(() => {
    const treeFilter = ARTIFACTS_TREE_FILTER;
    const roots = yDocRootIds.filter(
      (rootId) =>
        Object.hasOwn(tree.nodeById, rootId) &&
        treeFilter(tree.nodeById[rootId].type),
    );
    // `yDocRootIds` is in projector (default) order; re-sort only for a
    // non-default mode (`comparator !== null`).
    return sortNodeIds(roots, tree.nodeById, comparator);
  }, [tree, yDocRootIds, comparator]);
}

/**
 * Visible-id set for an active artifact filter (status / kind / read), expanded
 * to include ancestors so a matched ticket nested under a spec stays reachable.
 * Status and read are evaluated only against artifacts that carry them; specs
 * and reviews (status `null`, never assignable) drop out whenever a status or
 * kind constraint excludes them. `null` when no filter is active.
 */
function useArtifactVisibleIds(epicId: string): ReadonlySet<string> | null {
  const filter = useArtifactFilter(epicId);
  const artifacts = useEpicStore((s) => s.artifacts);
  const tree = useEpicTreeIndex();
  const readState = useArtifactReadStateStore(
    useShallow((s) => ({
      seedAtByEpic: s.seedAtByEpic,
      lastSeenByArtifact: s.lastSeenByArtifact,
    })),
  );
  return useMemo(() => {
    if (!isArtifactFilterActive(filter)) return null;
    const statusSet = new Set<number>(filter.statuses);
    const kindSet = new Set<string>(filter.kinds);
    const matches: string[] = [];
    for (const id of artifacts.allIds) {
      if (!Object.hasOwn(artifacts.byId, id)) continue;
      const artifact = artifacts.byId[id];
      if (kindSet.size > 0 && !kindSet.has(artifact.kind)) continue;
      if (
        statusSet.size > 0 &&
        (artifact.status === null || !statusSet.has(artifact.status))
      ) {
        continue;
      }
      if (filter.read !== "all") {
        const unread = isArtifactUnread({
          epicId,
          artifactId: artifact.id,
          updatedAt: artifact.updatedAt,
          seedAtByEpic: readState.seedAtByEpic,
          lastSeenByArtifact: readState.lastSeenByArtifact,
        });
        if (filter.read === "unread" && !unread) continue;
        if (filter.read === "read" && unread) continue;
      }
      matches.push(artifact.id);
    }
    return collectWithAncestors(matches, tree.nodeById);
  }, [filter, artifacts, tree, readState, epicId]);
}

/**
 * Collect the artifact-kind descendants of `nodeId` (id + version) so a
 * collapsed parent can roll up "contains unread artifacts" without mounting its
 * children. When a filter is active (`visibleIds !== null`), descendants hidden
 * by the filter are skipped along with their subtree - the rollup must never
 * point at a child the user cannot reach by expanding. Cycle-guarded via
 * `visited`.
 */
function collectDescendantArtifactEntries(
  nodeId: string,
  tree: TreeSlice,
  visibleIds: ReadonlySet<string> | null,
): ReadonlyArray<ArtifactDescendantEntry> {
  const rootChildren = Object.hasOwn(tree.childrenByParent, nodeId)
    ? tree.childrenByParent[nodeId]
    : null;
  if (rootChildren === null || rootChildren.length === 0) {
    return EMPTY_DESCENDANT_ENTRIES;
  }
  const entries: ArtifactDescendantEntry[] = [];
  const visited = new Set<string>([nodeId]);
  const stack = [...rootChildren];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    // A filtered-out node has no visible descendants (the visible set is
    // matches plus their ancestors), so skip its whole subtree.
    if (visibleIds !== null && !visibleIds.has(id)) continue;
    if (!Object.hasOwn(tree.nodeById, id)) continue;
    const node = tree.nodeById[id];
    if (isEpicArtifactKind(node.type)) {
      entries.push({ id, updatedAt: node.updatedAt });
    }
    if (Object.hasOwn(tree.childrenByParent, id)) {
      for (const childId of tree.childrenByParent[id]) stack.push(childId);
    }
  }
  return entries;
}

/**
 * Per-node unread marker variant, subscribed narrowly so marking one artifact
 * read re-renders only the affected row and its collapsed ancestors - never the
 * whole tree. The read-state selector returns a scalar variant, so Zustand
 * bails the render for any node whose variant did not flip. Returns:
 *   - "self": this artifact itself has unread changes.
 *   - "descendant": this collapsed parent hides unread artifacts.
 *   - null: nothing to show (non-artifact row, or expanded parent with no self
 *     unread).
 * This mirrors the per-entity `useIsActive...` pattern instead of threading a
 * tab-wide map through the recursive node tree.
 */
function useArtifactUnreadMarkerVariant(args: {
  readonly epicId: string;
  readonly nodeId: string;
  readonly isArtifactKind: boolean;
  readonly expanded: boolean;
  readonly selfUpdatedAt: number;
  readonly tree: TreeSlice;
}): ArtifactUnreadMarkerVariant | null {
  const { epicId, nodeId, isArtifactKind, expanded, selfUpdatedAt, tree } =
    args;
  const visibleIds = useSidebarVisibleIds();
  const descendantEntries = useMemo(
    () =>
      !isArtifactKind || expanded
        ? EMPTY_DESCENDANT_ENTRIES
        : collectDescendantArtifactEntries(nodeId, tree, visibleIds),
    [isArtifactKind, expanded, nodeId, tree, visibleIds],
  );
  return useArtifactReadStateStore((state) => {
    if (!isArtifactKind) return null;
    if (
      isArtifactUnread({
        epicId,
        artifactId: nodeId,
        updatedAt: selfUpdatedAt,
        seedAtByEpic: state.seedAtByEpic,
        lastSeenByArtifact: state.lastSeenByArtifact,
      })
    ) {
      return "self";
    }
    for (const entry of descendantEntries) {
      if (
        isArtifactUnread({
          epicId,
          artifactId: entry.id,
          updatedAt: entry.updatedAt,
          seedAtByEpic: state.seedAtByEpic,
          lastSeenByArtifact: state.lastSeenByArtifact,
        })
      ) {
        return "descendant";
      }
    }
    return null;
  });
}

function artifactsForReadSeed(
  artifacts: ArtifactsSlice,
): ReadonlyArray<ArtifactReadSeedEntry> {
  if (artifacts.allIds.length === 0) return [];
  return artifacts.allIds.flatMap((artifactId) => {
    if (!Object.hasOwn(artifacts.byId, artifactId)) return [];
    const artifact = artifacts.byId[artifactId];
    return [{ id: artifact.id, updatedAt: artifact.updatedAt }];
  });
}

export function ArtifactReadLifecycleBridge(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const { epicId, tabId } = props;
  const snapshotLoaded = useEpicStore((s) => s.snapshotLoaded);
  const artifacts = useEpicStore((s) => s.artifacts);
  const activeArtifactId = useActiveEpicArtifactId(tabId);
  // Only real artifacts may clear unread state. `useActiveEpicArtifactId` can
  // return any active tile id (chat/terminal too); `byId` already excludes
  // those, and the kind guard keeps the invariant explicit if ids ever unify.
  const activeArtifact = useEpicStore((s) => {
    if (activeArtifactId === null) return null;
    if (!Object.hasOwn(s.artifacts.byId, activeArtifactId)) return null;
    const artifact = s.artifacts.byId[activeArtifactId];
    return isEpicArtifactKind(artifact.kind) ? artifact : null;
  });

  useEffect(() => {
    if (!snapshotLoaded) return;
    // Seed exactly once per epic per device. The store action is itself
    // idempotent, but checking the guard here avoids rebuilding the full seed
    // array (O(artifacts)) on every later projection for the epic's lifetime.
    if (
      Object.hasOwn(useArtifactReadStateStore.getState().seedAtByEpic, epicId)
    ) {
      return;
    }
    useArtifactReadStateStore
      .getState()
      .seedEpicArtifacts(epicId, artifactsForReadSeed(artifacts));
  }, [artifacts, epicId, snapshotLoaded]);

  useEffect(() => {
    if (activeArtifact === null) return;
    useArtifactReadStateStore
      .getState()
      .markRead(epicId, activeArtifact.id, activeArtifact.updatedAt);
  }, [activeArtifact, epicId]);

  return null;
}

// Panel body composes sort/filter/expansion/selection/pending-create hooks in
// a stable order; child row complexity is isolated below.
// eslint-disable-next-line complexity
export function ArtifactTreePanelBody(props: ArtifactTreePanelBodyProps) {
  const { epicId, tabId } = props;
  const panelId: RootCreatePanelId = "artifacts";
  const sort = useArtifactSort(epicId);
  const comparator = useMemo<NodeComparator | null>(
    () => (isDefaultSort(sort) ? null : makeNodeComparator(sort)),
    [sort],
  );
  const allRootIds = usePanelRootIds(comparator);
  const visibleIds = useArtifactVisibleIds(epicId);
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
        treeFilter: ARTIFACTS_TREE_FILTER,
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
        icon={FileText}
        title="No artifacts yet."
        description={null}
        testId="epic-artifact-sidebar-empty"
      />
    );
  } else if (filteredTreeEmpty) {
    panelContent = (
      <SidebarPanelEmptyState
        icon={FileText}
        title="No artifacts match the filter."
        description={null}
        testId="epic-artifact-sidebar-filter-empty"
      />
    );
  } else {
    panelContent = (
      <ul role="tree" aria-label="Epic artifacts tree" className="space-y-0.5">
        {localRootPending !== null && (
          <PendingCreateRow depth={0} name={localRootPending.name} />
        )}
        {acknowledgedRootPending !== null && (
          <PendingCreateRow depth={0} name={acknowledgedRootPending.name} />
        )}
        {preAckRootCreates.map((e) => (
          <PendingCreateRow key={e.tempId} depth={0} name={e.name} />
        ))}
        {visiblePendingRootCreates.map((e) => (
          <PendingCreateRow key={e.id} depth={0} name={e.name} />
        ))}
        {rootIds.map((nodeId) => (
          <ArtifactNode
            key={nodeId}
            epicId={epicId}
            tabId={tabId}
            nodeId={nodeId}
            depth={0}
            expansion={expansion}
            canEdit={canEdit}
            canMutate={canMutate}
            isDisconnected={isDisconnected}
            treeFilter={ARTIFACTS_TREE_FILTER}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggleSelection={toggleSelection}
          />
        ))}
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

interface ArtifactNodeProps {
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

// Tree node renders many independent artifact states (kind / selection /
// expand / drag / status); branches are independent, not reducible nesting.
// eslint-disable-next-line complexity
const ArtifactNode = memo(function ArtifactNode(props: ArtifactNodeProps) {
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
  const { expandedIds, toggleExpanded, ensureExpanded } = expansion;
  const node = useEpicTreeNode(nodeId);
  const childIds = useFilteredPanelChildIds(nodeId, treeFilter);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );
  const prepareOpenTilePreviewInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTilePreviewInTabFocusTarget,
  );
  const promotePreviewInTab = useEpicCanvasStore((s) => s.promotePreviewInTab);
  const markArtifactSelfDeleted = useEpicCanvasStore(
    (s) => s.markArtifactSelfDeleted,
  );
  const unmarkArtifactSelfDeleted = useEpicCanvasStore(
    (s) => s.unmarkArtifactSelfDeleted,
  );
  const epicHandle = useOpenEpicHandle();

  const createArtifact = useEpicCreateArtifact();
  const deleteArtifact = useEpicDeleteArtifact();
  const renameArtifact = useEpicRenameArtifact();
  const renameArtifactInTab = useEpicCanvasStore((s) => s.renameArtifactInTab);

  const [pendingChildName, setPendingChildName] = useState<string | null>(null);
  const pendingProjectedOpenCancelRef = useRef<(() => void) | null>(null);
  // Read only what this node needs from the tree projection, NOT the full
  // `useEpicArtifactRecords()` array: that array gets a new identity whenever
  // ANY record changes (e.g. the active chat streaming a token), which used to
  // re-render every memoized node. The tree index is stable while streaming and
  // `status` is a per-id scalar.
  const tree = useEpicTreeIndex();
  const statusValue = useEpicArtifactStatus(nodeId);

  useEffect(() => {
    const pendingProjectedOpenCancel = pendingProjectedOpenCancelRef;
    return () => {
      pendingProjectedOpenCancel.current?.();
      pendingProjectedOpenCancel.current = null;
    };
  }, []);

  const expanded = expandedIds.has(nodeId);
  const hasChildren = childIds.length > 0;
  const showChildren = hasChildren && expanded;
  const artifactType = node?.type ?? "spec";
  const nodeName = node?.title ?? "";
  const openableType: OpenableEpicNodeKind | null = isOpenableEpicNodeKind(
    artifactType,
  )
    ? artifactType
    : null;
  // Every artifact row can parent a child artifact (any kind ⊃ any kind), so
  // the "+" shows on every row the user can edit - no per-kind gate. See the
  // tech plan "Create affordance" section (decision 11).
  const showAdd = canEdit;
  // Per-node boolean subscription: re-renders this node only when ITS active
  // state flips, instead of receiving the tab-wide `activeArtifactId` (which
  // re-rendered the whole tree on every selection).
  const isActive = useIsActiveEpicArtifact(tabId, nodeId);
  const isArtifactKind = isEpicArtifactKind(artifactType);
  // Per-node read-state subscription (mirrors `useIsActiveEpicArtifact`): only
  // the rows whose marker actually flips re-render, not the whole tree.
  const unreadMarkerVariant = useArtifactUnreadMarkerVariant({
    epicId,
    nodeId,
    isArtifactKind,
    expanded,
    selfUpdatedAt: node?.updatedAt ?? 0,
    tree,
  });

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
  const renamePending = renameArtifact.isPending;

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const deletePending = deleteArtifact.isPending;

  const activeHostId = useReactiveActiveHostId() ?? "unknown-host";

  const openProjectedChildInTab = useCallback(
    (
      projectedNodeId: string,
      onBeforeOpen: ((node: EpicNodeRef) => void) | null,
    ) => {
      pendingProjectedOpenCancelRef.current?.();
      pendingProjectedOpenCancelRef.current =
        openProjectedSidebarNodeInTabWhenAvailable({
          epicHandle,
          tabId,
          nodeId: projectedNodeId,
          fallbackHostId: activeHostId,
          openTileInTab: (targetTabId, nodeRef) => {
            navigateNested(epicId, targetTabId, () =>
              prepareOpenTileInTabFocusTarget(targetTabId, nodeRef),
            );
          },
          onBeforeOpen,
          onOpened: () => {
            pendingProjectedOpenCancelRef.current = null;
            startTransition(() => {
              setPendingChildName(null);
            });
          },
          onUnavailable: () => {
            pendingProjectedOpenCancelRef.current = null;
            startTransition(() => {
              setPendingChildName(null);
            });
          },
          onCleanup: null,
        });
    },
    [
      activeHostId,
      epicHandle,
      epicId,
      navigateNested,
      prepareOpenTileInTabFocusTarget,
      tabId,
    ],
  );

  const clearPendingChildCreate = useCallback(() => {
    pendingProjectedOpenCancelRef.current?.();
    pendingProjectedOpenCancelRef.current = null;
    startTransition(() => {
      setPendingChildName(null);
    });
  }, []);

  const selectArtifactNode = useCallback(() => {
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

  const performAddChild = useCallback(
    (type: EpicNodeKind) => {
      if (!canMutate) return;
      if (type === "chat" || type === "terminal" || type === "terminal-agent") {
        return;
      }
      ensureExpanded(nodeId);
      const childName = DEFAULT_EPIC_NODE_NAMES[type];
      setPendingChildName(childName);
      createArtifact.mutate(
        {
          epicId,
          parentId: nodeId,
          artifactType: type,
          title: DEFAULT_EPIC_NODE_NAMES[type],
        },
        {
          onSuccess: (result) => {
            openProjectedChildInTab(result.artifactId, (node) => {
              requestArtifactEditorFocus(node.id, node.instanceId);
            });
          },
          onError: () => {
            clearPendingChildCreate();
          },
        },
      );
    },
    [
      canMutate,
      clearPendingChildCreate,
      createArtifact,
      ensureExpanded,
      epicId,
      nodeId,
      openProjectedChildInTab,
    ],
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
    renameArtifact.mutate(
      { epicId, artifactId: nodeId, title: trimmed },
      {
        onSuccess: () => {
          setIsRenaming(false);
        },
      },
    );
  }, [
    epicHandle,
    epicId,
    nodeName,
    nodeId,
    renameArtifactInTab,
    renameArtifact,
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
    deleteArtifact.mutate(
      { epicId, artifactId: nodeId },
      { onSuccess: handleDeleteSuccess, onError: handleDeleteError },
    );
  };

  if (node === null) return null;
  if (!treeFilter(node.type)) return null;

  // Cascade counts feed only the delete-confirm dialog, computed from the
  // canonical tree structure (stable while streaming) rather than the churning
  // record list.
  const cascadeCounts = computeDescendantCountsFromTree(tree, nodeId);
  const cascadeSummary = formatCascadeSummary(cascadeCounts);

  const showStatusDot = computeArtifactNodeStatusDot(artifactType, statusValue);

  const addChildIsPending = computeArtifactNodeAddChildPending({
    pendingChildName,
    pendingChildRealId: null,
    createArtifactPending: createArtifact.isPending,
  });
  const rowClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (selectionMode || event.ctrlKey || event.metaKey) {
      event.preventDefault();
      onToggleSelection(nodeId);
      return;
    }
    selectArtifactNode();
  };
  const rowDoubleClick = selectionMode ? noopRowAction : handleDoubleClick;

  return (
    <ArtifactNodeShell
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
      showAdd={showAdd}
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
      statusValue={statusValue}
      showStatusDot={showStatusDot}
      unreadMarkerVariant={unreadMarkerVariant}
      addChildIsPending={addChildIsPending}
      onAddChild={performAddChild}
      onStartRename={startRename}
      onPerformDelete={performDelete}
      pendingChildName={pendingChildName}
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

interface ArtifactNodeShellProps {
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
  readonly showAdd: boolean;
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
  readonly statusValue: number | null;
  readonly showStatusDot: boolean;
  readonly unreadMarkerVariant: ArtifactUnreadMarkerVariant | null;
  readonly addChildIsPending: boolean;
  readonly onAddChild: (type: EpicNodeKind) => void;
  readonly onStartRename: () => void;
  readonly onPerformDelete: () => void;
  readonly pendingChildName: string | null;
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

function ArtifactNodeShell(props: ArtifactNodeShellProps) {
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
    showAdd,
    openableType,
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
    statusValue,
    showStatusDot,
    unreadMarkerVariant,
    addChildIsPending,
    onAddChild,
    onStartRename,
    onPerformDelete,
    pendingChildName,
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
        panelId="artifacts"
      >
        {isRenaming ? (
          <ArtifactRenameRow
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
            unreadMarkerVariant={unreadMarkerVariant}
          />
        ) : (
          <ArtifactRowButton
            epicId={epicId}
            viewTabId={tabId}
            nodeId={nodeId}
            nodeName={nodeName}
            artifactType={artifactType}
            depth={depth}
            isActive={isActive}
            canEdit={canEdit}
            showAdd={showAdd}
            openableType={openableType}
            hasChildren={hasChildren}
            expanded={expanded}
            onToggle={onToggle}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            Icon={Icon}
            artifactIconColorMode={artifactIconColorMode}
            iconStyle={iconStyle}
            statusValue={statusValue}
            showStatusDot={showStatusDot}
            unreadMarkerVariant={unreadMarkerVariant}
            selectionMode={selectionMode}
            isSelected={isSelected}
            onToggleSelection={onToggleSelection}
          />
        )}

        {showAdd && !isRenaming && !selectionMode ? (
          <ArtifactAddChildButton
            epicId={epicId}
            nodeId={nodeId}
            canMutate={canMutate}
            addChildIsPending={addChildIsPending}
            isDisconnected={isDisconnected}
            onAdd={onAddChild}
          />
        ) : null}

        {canEdit && !isRenaming && !selectionMode ? (
          <ArtifactMoreMenu
            nodeId={nodeId}
            nodeName={nodeName}
            canMutate={canMutate}
            onStartRename={onStartRename}
            onPerformDelete={onPerformDelete}
          />
        ) : null}
      </SidebarReparentRowDropWrapper>
      <ArtifactNodeChildren
        visible={showChildren || addChildIsPending}
        childIds={childIds}
        pendingChildName={pendingChildName}
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

interface ArtifactNodeChildrenProps {
  visible: boolean;
  childIds: readonly string[];
  pendingChildName: string | null;
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

function ArtifactNodeChildren(props: ArtifactNodeChildrenProps) {
  if (!props.visible) return null;
  return (
    <ul role="group" className="relative space-y-0.5">
      <TreeGroupGuide parentDepth={props.depth} />
      {props.pendingChildName !== null && (
        <PendingCreateRow
          depth={props.depth + 1}
          name={props.pendingChildName}
        />
      )}
      {props.childIds.map((childId) => (
        <ArtifactNode
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

interface ArtifactRenameRowProps {
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
  readonly unreadMarkerVariant: ArtifactUnreadMarkerVariant | null;
}

function ArtifactRenameRow(props: ArtifactRenameRowProps) {
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
    unreadMarkerVariant,
  } = props;
  return (
    <div
      className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2"
      style={{
        paddingLeft: `${depth * INDENT_PX + BASE_PAD_LEFT}px`,
      }}
    >
      <TreeChevronSpacer />
      <ArtifactUnreadMarker nodeId={nodeId} variant={unreadMarkerVariant} />
      <SidebarNodeIcon
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

interface ArtifactRowButtonProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly artifactType: EpicNodeKind;
  readonly depth: number;
  readonly isActive: boolean;
  readonly canEdit: boolean;
  readonly showAdd: boolean;
  readonly openableType: OpenableEpicNodeKind | null;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly onToggle: (event: React.MouseEvent<HTMLSpanElement>) => void;
  readonly onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  readonly onDoubleClick: () => void;
  readonly Icon: LucideIcon;
  readonly artifactIconColorMode: "byType" | "none";
  readonly iconStyle: { color: string | undefined } | undefined;
  readonly statusValue: number | null;
  readonly showStatusDot: boolean;
  readonly unreadMarkerVariant: ArtifactUnreadMarkerVariant | null;
  readonly selectionMode: boolean;
  readonly isSelected: boolean;
  readonly onToggleSelection: (id: string) => void;
}

function ArtifactRowButton(props: ArtifactRowButtonProps) {
  const {
    epicId,
    viewTabId,
    nodeId,
    nodeName,
    artifactType,
    depth,
    isActive,
    canEdit,
    showAdd,
    openableType,
    hasChildren,
    expanded,
    onToggle,
    onClick,
    onDoubleClick,
    Icon,
    artifactIconColorMode,
    iconStyle,
    statusValue,
    showStatusDot,
    unreadMarkerVariant,
    selectionMode,
    isSelected,
    onToggleSelection,
  } = props;
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
    disabled: selectionMode || openableType === null,
    data: dragData,
  });
  const selectionChevronToggle = useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      event.preventDefault();
      onToggle(event);
    },
    [onToggle],
  );

  const rowClassName = cn(
    "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-ui-sm font-normal transition-colors",
    "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
    isDragging && "cursor-grabbing opacity-60",
    nodePadRightClass(
      selectionMode ? false : canEdit,
      selectionMode ? false : showAdd,
    ),
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
          <ArtifactUnreadMarker nodeId={nodeId} variant={unreadMarkerVariant} />
          <SidebarNodeIcon
            epicId={epicId}
            nodeId={nodeId}
            artifactType={artifactType}
            Icon={Icon}
            artifactIconColorMode={artifactIconColorMode}
            iconStyle={iconStyle}
          />
          <span className="min-w-0 flex-1 truncate">{nodeName}</span>
          <ArtifactStatusDot
            nodeId={nodeId}
            statusValue={statusValue}
            showStatusDot={showStatusDot}
          />
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
        <ArtifactUnreadMarker nodeId={nodeId} variant={unreadMarkerVariant} />
        <SidebarNodeIcon
          epicId={epicId}
          nodeId={nodeId}
          artifactType={artifactType}
          Icon={Icon}
          artifactIconColorMode={artifactIconColorMode}
          iconStyle={iconStyle}
        />
        <span className="min-w-0 flex-1 truncate">{nodeName}</span>
        <ArtifactStatusDot
          nodeId={nodeId}
          statusValue={statusValue}
          showStatusDot={showStatusDot}
        />
      </span>
    </button>
  );
}

interface SidebarNodeIconProps {
  readonly epicId: string;
  readonly nodeId: string;
  readonly artifactType: EpicNodeKind;
  readonly Icon: LucideIcon;
  readonly artifactIconColorMode: "byType" | "none";
  readonly iconStyle: { color: string | undefined } | undefined;
}

function SidebarNodeIcon(props: SidebarNodeIconProps) {
  return (
    <StaticSidebarNodeIcon
      Icon={props.Icon}
      artifactIconColorMode={props.artifactIconColorMode}
      iconStyle={props.iconStyle}
    />
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

function ArtifactUnreadMarker(props: {
  readonly nodeId: string;
  readonly variant: ArtifactUnreadMarkerVariant | null;
}) {
  if (props.variant === null) {
    // Reserve the bar's footprint so the icon column stays aligned and a row
    // never shifts horizontally as it toggles read/unread.
    return <span aria-hidden className="h-4 w-0.5 shrink-0" />;
  }
  const label =
    props.variant === "self" ? "Unread artifact" : "Contains unread artifacts";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={label}
          data-testid={`epic-sidebar-unread-${props.nodeId}`}
          data-unread-marker={props.variant}
          className={cn(
            "h-4 w-0.5 shrink-0 rounded-full",
            props.variant === "self"
              ? "bg-blue-500 dark:bg-blue-400"
              : "bg-blue-500/50 dark:bg-blue-400/50",
          )}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

interface ArtifactStatusDotProps {
  readonly nodeId: string;
  readonly statusValue: number | null;
  readonly showStatusDot: boolean;
}

function ArtifactStatusDot(props: ArtifactStatusDotProps) {
  const { nodeId, statusValue, showStatusDot } = props;
  if (statusValue === null || !showStatusDot) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            STATUS_DOT_CLASSES[statusValue] ?? "bg-slate-400",
          )}
          data-testid={`epic-sidebar-status-dot-${nodeId}`}
          aria-hidden
        />
      </TooltipTrigger>
      <TooltipContent>{STATUS_LABELS[statusValue] ?? "Unknown"}</TooltipContent>
    </Tooltip>
  );
}

interface ArtifactAddChildButtonProps {
  readonly epicId: string;
  readonly nodeId: string;
  readonly canMutate: boolean;
  readonly addChildIsPending: boolean;
  readonly isDisconnected: boolean;
  readonly onAdd: (type: EpicNodeKind) => void;
}

function ArtifactAddChildButton(props: ArtifactAddChildButtonProps) {
  const {
    epicId,
    nodeId,
    canMutate,
    addChildIsPending,
    isDisconnected,
    onAdd,
  } = props;
  const disabled = !canMutate || addChildIsPending;
  const disabledTooltip = isDisconnected ? "Reconnect to make changes." : null;
  const { ariaDisabled, nativeDisabled } = resolveDisabledPresentation(
    disabled,
    disabledTooltip,
  );
  return (
    <AddNodeDropdown
      open={undefined}
      onOpenChange={undefined}
      epicId={epicId}
      menuTestId={`epic-sidebar-add-menu-${nodeId}`}
      itemTestId={(t) => `epic-sidebar-add-${t}-${nodeId}`}
      onAdd={onAdd}
      // Artifacts carry no host, so there is no terminal-agent child here -
      // only the four artifact kinds (spec / ticket / story / review).
      onAddTerminalAgent={undefined}
      terminalAgentWorkspaceSeed={null}
      terminalAgentHostScope={undefined}
      terminalAgentStagingKey={undefined}
      tuiAgentPending={undefined}
      excludeTypes={ARTIFACT_PANEL_EXCLUDED_TYPES}
      disabledTypes={undefined}
      disabled={disabled}
      disabledTooltip={disabledTooltip}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Add child artifact"
        aria-disabled={ariaDisabled ? true : undefined}
        data-testid={`epic-sidebar-add-${nodeId}`}
        className={cn(
          "absolute right-7 top-1/2 -translate-y-1/2",
          ARIA_DISABLED_TRIGGER_CLASS,
          rowAddControlRevealClass(addChildIsPending),
        )}
        disabled={nativeDisabled}
      >
        {addChildIsPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : (
          <Plus className="size-3" />
        )}
      </Button>
    </AddNodeDropdown>
  );
}

interface ArtifactMoreMenuProps {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly canMutate: boolean;
  readonly onStartRename: () => void;
  readonly onPerformDelete: () => void;
}

function ArtifactMoreMenu(props: ArtifactMoreMenuProps) {
  const { nodeId, nodeName, canMutate, onStartRename, onPerformDelete } = props;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Artifact actions for ${nodeName}`}
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
