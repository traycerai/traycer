/**
 * This is the main orchestrator that composes extracted sub-components:
 * - epic-sidebar-header.tsx: header with collapse/drag
 * - epic-sidebar-chat-tree.tsx: chat panel tree
 * - epic-sidebar-artifact-tree.tsx: artifact panel tree
 * - epic-sidebar-context-menu.tsx: right-click menu
 * - epic-terminal-sidebar.tsx: raw terminals (pre-extracted)
 * - epic-sidebar-footer.tsx: footer placeholder
 */
import { useDroppable } from "@dnd-kit/core";
import {
  getLeftPanelGroupDropId,
  getPaneScopedDndId,
  getSidebarReparentPanelDropId,
  type EpicCanvasDropPreview,
  type EpicCanvasDropTargetData,
} from "@/components/epic-canvas/dnd/dnd";
import {
  useEpicDndStore,
  useSidebarReparentRootActive,
} from "@/components/epic-canvas/dnd/dnd-store";
import {
  isLeftPanelVisible,
  LEFT_PANEL_DEFINITIONS,
  resolveActiveVisibleGroupIndex,
  type LeftPanelAvailabilityContext,
  type LeftPanelMetadataDefinition,
  type LeftPanelSlotProps,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  TerminalsPanelActions,
  TerminalsPanelBody,
} from "@/components/epic-canvas/sidebar/epic-terminal-sidebar";
import {
  ArtifactFilterMenu,
  ChatFilterMenu,
} from "@/components/epic-canvas/sidebar/epic-sidebar-filter-menu";
import { CommGraphOpenMenuItem } from "@/components/epic-canvas/comm-graph/comm-graph-open-button";
import { FileTreeWorkspacePicker } from "@/components/epic-canvas/sidebar/file-tree-workspace-picker";
import { FileTreePanelBodyForWorkspace } from "@/components/epic-canvas/sidebar/epic-sidebar-file-tree";
import { WorkspacePickerWithOpener } from "@/components/worktree/workspace-picker-with-opener";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { isBrowsable } from "@/lib/worktree/worktree-row-browsable";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { requestArtifactEditorFocus } from "@/lib/artifacts/pending-editor-focus";
import { openProjectedSidebarNodeInTabWhenAvailable } from "@/components/epic-canvas/sidebar/open-projected-sidebar-node";
import { type EpicNodeRef } from "@/stores/epics/canvas/types";
import { getCurrentNestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { EMPTY_CANVAS } from "@/stores/epics/canvas/canvas-state";
import { PanelGroupSectionHeader } from "@/components/epic-canvas/sidebar/epic-sidebar-header";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import {
  ArtifactReadLifecycleBridge,
  ArtifactTreePanelBody,
} from "@/components/epic-canvas/sidebar/epic-sidebar-artifact-tree";
import { SharingPanel } from "@/components/epic-canvas/panels/epic-sharing/panel";
import { SnapshotGate } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import { AddNodeDropdown } from "@/components/epic-canvas/add-node-dropdown";
import { NewConversationModalAction } from "@/components/epic-canvas/sidebar/new-conversation-modal";
import {
  ARTIFACT_PANEL_EXCLUDED_TYPES,
  CHAT_PANEL_EXCLUDED_TYPES,
} from "@/components/epic-canvas/add-node-options";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { ArtifactsPanelSkeleton } from "@/components/epic-canvas/skeletons/artifacts-panel-skeleton";
import { ChatsPanelSkeleton } from "@/components/epic-canvas/skeletons/chats-panel-skeleton";
import { CommentsPanelSkeleton } from "@/components/epic-canvas/skeletons/comments-panel-skeleton";
import { FileTreePanelSkeleton } from "@/components/epic-canvas/skeletons/file-tree-panel-skeleton";
import { TerminalsPanelSkeleton } from "@/components/epic-canvas/skeletons/terminals-panel-skeleton";
import { CommentSidebar } from "@/components/comments";
import { DropLine } from "@/components/ui/drop-line";
import { Sidebar } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useArtifactAnchorPositions } from "@/stores/comments/anchor-positions-store";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import {
  DEFAULT_LEFT_PANEL_ID,
  useActiveLeftPanelId,
  useAcknowledgedRootCreatePending,
  useCommentsPanelRevealed,
  useEpicLeftPanelStore,
  useLeftPanelGroups,
  useLeftPanelSectionCollapsed,
  useLocalRootCreatePending,
  usePanelVisibilityOverrides,
  type LeftPanelGroup,
  type LeftPanelId,
  type RootCreatePanelId,
} from "@/stores/epics/left-panel-store";
import {
  selectPrScopeHasItems,
  usePrPresenceStore,
} from "@/stores/epics/pr-presence-store";
import {
  useFileTreeStore,
  useSelectedFileTreeWorkspace,
} from "@/stores/file-tree/file-tree-store";
import {
  useEpicSidebarEffectiveExpanded,
  useEpicSidebarExpansionStore,
} from "@/stores/epics/epic-sidebar-expansion-store";
import {
  findOpenArtifactInTab,
  useActiveEpicArtifactId,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import {
  useEpicArtifact,
  useEpicActiveAgentIds,
  useAncestorIds,
  useEpicArtifactRecords,
  useEpicConnectionStatus,
  useEpicPermissionRole,
  useEpicSnapshotMeta,
  useEpicTreeIndex,
  useRootIds,
  type EpicArtifactProjection,
  type EpicChatProjection,
  type EpicTuiAgentProjection,
  type EpicTreeRecord,
} from "@/lib/epic-selectors";
import { isEditableRole, mutationDisabledHint } from "@/lib/epic-permissions";
import { useEpicExportArtifacts } from "@/hooks/epic/use-epic-export-artifacts-mutation";
import {
  ARIA_DISABLED_TRIGGER_CLASS,
  resolveDisabledPresentation,
} from "@/lib/disabled-presentation";
import { displayTitle } from "@/lib/display-title";
import {
  useEpicArchiveChats,
  useEpicDeleteChat,
} from "@/hooks/epic/use-epic-chat-mutations";
import { useChatArchiveSupported } from "@/hooks/epic/use-chat-archive-support";
import {
  useEpicCreateArtifact,
  useEpicDeleteArtifact,
} from "@/hooks/epic/use-epic-node-mutations";
import { useEpicDeleteTuiAgent } from "@/hooks/epic/use-epic-tui-agent-mutations";
import {
  DEFAULT_EPIC_NODE_NAMES,
  isEpicArtifactKind,
  type EpicNodeKind,
} from "@/lib/artifacts/node-display";
import {
  isArtifactUnread,
  useArtifactReadStateStore,
} from "@/stores/epics/artifact-read-state-store";
import { revealCommentThreadAnchor } from "@/lib/comments/comment-editor-registry";
import { useArtifactSearchAvailable } from "@/components/epic-canvas/sidebar/artifact-search-availability";
import { usePanelHeaderSearchStore } from "@/stores/epics/panel-header-search-store";
import {
  usePanelHeaderMenuOpen,
  usePanelHeaderMenuStore,
} from "@/stores/epics/panel-header-menu-store";
import { cn } from "@/lib/utils";
import {
  Archive,
  Download,
  FolderOpen,
  ListChecks,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { GitDiffPanelBodyLive } from "@/components/epic-canvas/git-diff/git-diff-panel-body-live";
import { GitDiffPanelActions } from "@/components/epic-canvas/git-diff/git-diff-panel-actions";
import { PrPanelBody } from "@/components/epic-canvas/pr/pr-panel-body";
import { PrPanelActions } from "@/components/epic-canvas/pr/pr-panel-actions";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ComponentType,
  type ReactNode,
} from "react";
import { SplitResizeHandle } from "@/components/epic-canvas/canvas/resize-handle";
import {
  isSidebarBulkSelectionPanelId,
  rootmostSelectedSidebarIds,
  sidebarIdsWithinRoots,
  SidebarBulkSelectionProvider,
  useSidebarBulkSelection,
  type SidebarBulkSelectionPanelId,
} from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { useShallow } from "zustand/react/shallow";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
interface ArtifactReadTarget {
  readonly id: string;
  readonly updatedAt: number;
}

const CHATS_PANEL_SKELETON = <ChatsPanelSkeleton />;
const ARTIFACTS_PANEL_SKELETON = <ArtifactsPanelSkeleton />;
const COMMENTS_PANEL_SKELETON = <CommentsPanelSkeleton />;
const FILE_TREE_PANEL_SKELETON = <FileTreePanelSkeleton />;
const TERMINALS_PANEL_SKELETON = <TerminalsPanelSkeleton />;
const GENERIC_PANEL_SKELETON = <GenericPanelSkeleton />;

interface FileTreeWorkspaceSelection {
  readonly hostId: string | null;
  readonly selectedWorkspacePath: string | null;
  readonly setSelectedWorkspacePath: (workspacePath: string) => void;
}

function useFileTreeWorkspaceSelection(
  epicId: string,
): FileTreeWorkspaceSelection {
  const hostId = useReactiveActiveHostId();
  const workspacesQuery = useWorktreeListBindingsForEpic({
    epicId,
    enabled: hostId !== null,
  });
  const storedWorkspacePath = useSelectedFileTreeWorkspace(epicId, hostId);
  const setSelectedWorkspace = useFileTreeStore((s) => s.setSelectedWorkspace);
  const workspaceRoots = useMemo<ReadonlyArray<string>>(() => {
    if (workspacesQuery.data === undefined) return [];
    const seenPaths = new Set<string>();
    return workspacesQuery.data.rows.flatMap((row) => {
      if (!isBrowsable(row)) return [];
      if (seenPaths.has(row.runningDir)) return [];
      seenPaths.add(row.runningDir);
      return [row.runningDir];
    });
  }, [workspacesQuery.data]);
  const resolvedPath = resolveFileTreeWorkspaceRoot(
    workspaceRoots,
    storedWorkspacePath,
  );
  // Hold the last non-null resolved workspace path so transient refetches
  // (which momentarily empty `workspacesQuery.data`) do not flip the
  // selection to `null` and remount the file-tree state. Uses the
  // React-recommended "adjust state during render" idiom.
  //
  // The sticky value is scoped to `hostId`: on a host swap it is
  // reset to the new host's resolution (never carried over), so the
  // panel can't briefly show the previous host's workspace path. It is
  // also cleared once the query has finished with an explicitly empty
  // result so a removed folder doesn't linger as the selection forever.
  const queryResolved = workspacesQuery.data !== undefined;
  const [previousHostId, setPreviousHostId] = useState<string | null>(hostId);
  const [previousResolved, setPreviousResolved] = useState<string | null>(
    resolvedPath,
  );
  const [stickyResolved, setStickyResolved] = useState<string | null>(
    resolvedPath,
  );
  const hostChanged = hostId !== previousHostId;
  if (hostChanged) {
    setPreviousHostId(hostId);
    setPreviousResolved(resolvedPath);
    setStickyResolved(resolvedPath);
  } else {
    if (resolvedPath !== previousResolved) {
      setPreviousResolved(resolvedPath);
      if (resolvedPath !== null) setStickyResolved(resolvedPath);
    }
    if (queryResolved && resolvedPath === null && stickyResolved !== null) {
      setStickyResolved(null);
    }
  }
  // On the render where `hostId` just changed, `stickyResolved` still
  // holds the *previous* host's path (its setState is not yet applied).
  // Use the freshly-resolved value for that render so the panel never
  // mounts against the old host's workspace, even for one frame.
  const effectiveSticky = hostChanged ? resolvedPath : stickyResolved;
  const selectedWorkspacePath = queryResolved
    ? resolvedPath
    : (resolvedPath ?? effectiveSticky);
  const setSelectedWorkspacePath = useCallback(
    (workspacePath: string) => {
      if (hostId === null) return;
      setSelectedWorkspace(epicId, hostId, workspacePath);
    },
    [epicId, hostId, setSelectedWorkspace],
  );
  return {
    hostId,
    selectedWorkspacePath,
    setSelectedWorkspacePath,
  };
}

function resolveFileTreeWorkspaceRoot(
  workspaceRoots: ReadonlyArray<string>,
  storedWorkspacePath: string | null,
): string | null {
  if (
    storedWorkspacePath !== null &&
    workspaceRoots.includes(storedWorkspacePath)
  ) {
    return storedWorkspacePath;
  }
  return workspaceRoots[0] ?? null;
}

export interface EpicLeftPanelHostProps {
  epicId: string;
  tabId: string;
  side: "left" | "right" | undefined;
}

export type LeftPanelBodyProps = LeftPanelSlotProps;
export interface LeftPanelHeaderSlotProps extends LeftPanelSlotProps {
  readonly collapsed: boolean;
  readonly mode: "normal" | "search" | "selection";
}

export interface LeftPanelDefinition extends LeftPanelMetadataDefinition {
  readonly Body: ComponentType<LeftPanelSlotProps>;
  readonly Actions: ComponentType<LeftPanelHeaderSlotProps> | null;
  readonly Subtitle: ComponentType<LeftPanelSlotProps> | null;
}

type LeftPanelSlots = Pick<
  LeftPanelDefinition,
  "Body" | "Actions" | "Subtitle"
>;

interface LeftPanelModeSlots {
  readonly live: LeftPanelSlots;
  readonly loading: LeftPanelSlots;
}

const emptyLoadingSlots = (
  Body: ComponentType<LeftPanelSlotProps>,
): LeftPanelSlots => ({
  Body,
  Actions: null,
  Subtitle: null,
});

const PANEL_SLOTS_BY_ID: Readonly<Record<LeftPanelId, LeftPanelModeSlots>> = {
  chats: {
    live: {
      Body: ChatsPanelBody,
      Actions: ChatsPanelActions,
      Subtitle: null,
    },
    loading: emptyLoadingSlots(ChatsLoadingPanelBody),
  },
  terminals: {
    live: {
      Body: TerminalsPanelBody,
      Actions: TerminalsPanelActions,
      Subtitle: null,
    },
    loading: emptyLoadingSlots(TerminalsLoadingPanelBody),
  },
  artifacts: {
    live: {
      Body: ArtifactsPanelBody,
      Actions: ArtifactsPanelActions,
      Subtitle: null,
    },
    loading: emptyLoadingSlots(ArtifactsLoadingPanelBody),
  },
  "git-diff": {
    live: {
      Body: GitDiffPanelBody,
      Actions: GitDiffPanelActions,
      Subtitle: null,
    },
    loading: emptyLoadingSlots(GenericLoadingPanelBody),
  },
  "pull-requests": {
    live: {
      Body: PrPanelBody,
      Actions: PrPanelActions,
      Subtitle: null,
    },
    loading: emptyLoadingSlots(GenericLoadingPanelBody),
  },
  "file-tree": {
    live: {
      Body: FileTreePanelBody,
      Actions: null,
      Subtitle: null,
    },
    loading: emptyLoadingSlots(FileTreeLoadingPanelBody),
  },
  sharing: {
    live: {
      Body: SharingPanelBody,
      Actions: null,
      Subtitle: null,
    },
    loading: emptyLoadingSlots(GenericLoadingPanelBody),
  },
  comments: {
    live: {
      Body: CommentsPanelBody,
      Actions: CommentsPanelActions,
      Subtitle: CommentsPanelSubtitle,
    },
    loading: emptyLoadingSlots(CommentsLoadingPanelBody),
  },
};

type LeftPanelDefinitionMode = keyof LeftPanelModeSlots;

function buildLeftPanelDefinitionsById(
  mode: LeftPanelDefinitionMode,
): ReadonlyMap<LeftPanelId, LeftPanelDefinition> {
  return new Map(
    LEFT_PANEL_DEFINITIONS.map((definition) => [
      definition.id,
      { ...definition, ...PANEL_SLOTS_BY_ID[definition.id][mode] },
    ]),
  );
}

const EPIC_LEFT_PANEL_DEFINITIONS_BY_ID: ReadonlyMap<
  LeftPanelId,
  LeftPanelDefinition
> = buildLeftPanelDefinitionsById("live");

const EPIC_LEFT_PANEL_LOADING_DEFINITIONS_BY_ID: ReadonlyMap<
  LeftPanelId,
  LeftPanelDefinition
> = buildLeftPanelDefinitionsById("loading");

function getLeftPanelDefinition(
  definitionsById: ReadonlyMap<LeftPanelId, LeftPanelDefinition>,
  panelId: LeftPanelId,
): LeftPanelDefinition {
  const definition = definitionsById.get(panelId);
  if (definition === undefined) {
    throw new Error(`No definition registered for left panel "${panelId}"`);
  }
  return definition;
}

function getVisiblePanelGroupDefinitions(
  group: LeftPanelGroup,
  context: LeftPanelAvailabilityContext,
  definitionsById: ReadonlyMap<LeftPanelId, LeftPanelDefinition>,
): ReadonlyArray<LeftPanelDefinition> {
  return group.panelIds.flatMap((panelId) => {
    const definition = getLeftPanelDefinition(definitionsById, panelId);
    return isLeftPanelVisible(definition, context) ? [definition] : [];
  });
}

function getActivePanelDefinitions(
  groups: ReadonlyArray<LeftPanelGroup>,
  activePanelId: LeftPanelId,
  context: LeftPanelAvailabilityContext,
  definitionsById: ReadonlyMap<LeftPanelId, LeftPanelDefinition>,
): ReadonlyArray<LeftPanelDefinition> {
  const visibleGroups = groups.flatMap((group) => {
    const definitions = getVisiblePanelGroupDefinitions(
      group,
      context,
      definitionsById,
    );
    return definitions.length === 0 ? [] : [definitions];
  });
  // Shared with the rail so the highlighted icon and the rendered body agree
  // even when the active panel is hidden.
  const activeIndex = resolveActiveVisibleGroupIndex(
    visibleGroups.map((definitions) =>
      definitions.map((definition) => definition.id),
    ),
    activePanelId,
  );
  if (activeIndex === null) {
    return [getLeftPanelDefinition(definitionsById, DEFAULT_LEFT_PANEL_ID)];
  }
  return visibleGroups[activeIndex];
}

export function EpicLeftPanelHost(props: EpicLeftPanelHostProps) {
  const { epicId, tabId, side } = props;
  const activePanelId = useActiveLeftPanelId(tabId);
  const panelGroups = useLeftPanelGroups();
  const commentsPanelRevealed = useCommentsPanelRevealed(tabId);
  const activeArtifactId = useActiveEpicArtifactId(tabId);
  const activeArtifact = useEpicArtifact(activeArtifactId);
  const hasActiveCommentableArtifact =
    activeArtifact !== null && "kind" in activeArtifact;
  const hostId = useReactiveActiveHostId();
  const hasPullRequests = usePrPresenceStore(
    selectPrScopeHasItems(hostId, epicId),
  );
  const visibilityOverrideById = usePanelVisibilityOverrides();
  const availabilityContext = useMemo<LeftPanelAvailabilityContext>(
    () => ({
      commentsPanelRevealed,
      hasActiveCommentableArtifact,
      hasPullRequests,
      visibilityOverrideById,
    }),
    [
      commentsPanelRevealed,
      hasActiveCommentableArtifact,
      hasPullRequests,
      visibilityOverrideById,
    ],
  );
  const panels = useMemo(
    () =>
      getActivePanelDefinitions(
        panelGroups,
        activePanelId,
        availabilityContext,
        EPIC_LEFT_PANEL_DEFINITIONS_BY_ID,
      ),
    [activePanelId, availabilityContext, panelGroups],
  );
  const primaryPanel = panels[0];

  return (
    <Sidebar
      side={side ?? "left"}
      collapsible="none"
      className="w-full"
      data-testid="epic-sidebar"
      data-epic-id={epicId}
      data-left-panel-id={primaryPanel.id}
      data-left-panel-group-size={panels.length}
    >
      <ArtifactReadLifecycleBridge epicId={epicId} tabId={tabId} />
      <PanelGroupBody epicId={epicId} tabId={tabId} panels={panels} />
    </Sidebar>
  );
}

export function EpicLeftPanelLoadingHost(props: EpicLeftPanelHostProps) {
  const { epicId, tabId, side } = props;
  const activePanelId = useActiveLeftPanelId(tabId);
  const panelGroups = useLeftPanelGroups();
  const commentsPanelRevealed = useCommentsPanelRevealed(tabId);
  const hostId = useReactiveActiveHostId();
  // The persisted PR baseline is readable before the epic's Y.doc resolves, so
  // the loading rail already shows the same set of panels the live one will -
  // no icon appears or disappears as the epic finishes opening.
  const hasPullRequests = usePrPresenceStore(
    selectPrScopeHasItems(hostId, epicId),
  );
  const visibilityOverrideById = usePanelVisibilityOverrides();
  const availabilityContext = useMemo<LeftPanelAvailabilityContext>(
    () => ({
      commentsPanelRevealed,
      hasActiveCommentableArtifact: false,
      hasPullRequests,
      visibilityOverrideById,
    }),
    [commentsPanelRevealed, hasPullRequests, visibilityOverrideById],
  );
  const panels = useMemo(
    () =>
      getActivePanelDefinitions(
        panelGroups,
        activePanelId,
        availabilityContext,
        EPIC_LEFT_PANEL_LOADING_DEFINITIONS_BY_ID,
      ),
    [activePanelId, availabilityContext, panelGroups],
  );
  const primaryPanel = panels[0];

  return (
    <Sidebar
      side={side ?? "left"}
      collapsible="none"
      className="w-full"
      data-testid="epic-sidebar"
      data-epic-id={epicId}
      data-left-panel-id={primaryPanel.id}
      data-left-panel-group-size={panels.length}
      data-session-ready="false"
    >
      <PanelGroupBody epicId={epicId} tabId={tabId} panels={panels} />
    </Sidebar>
  );
}

function PanelBodyDropRegion(props: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {props.children}
      </div>
    </div>
  );
}

type PanelSectionBoundaryEdge = "top" | "bottom";

function PanelSectionBoundaryLine(props: {
  readonly edge: PanelSectionBoundaryEdge;
}) {
  return (
    <div
      aria-hidden
      data-edge={props.edge}
      className={cn(
        "pointer-events-none absolute left-7 right-7 z-20",
        props.edge === "top" ? "top-0" : "bottom-0",
      )}
    >
      <DropLine
        orientation="horizontal"
        glow
        className="w-full"
        testId="epic-left-panel-section-drop-preview"
      />
    </div>
  );
}

function getSectionBoundaryEdge(
  panelId: LeftPanelId,
  dropPreview: EpicCanvasDropPreview,
): PanelSectionBoundaryEdge | null {
  if (dropPreview?.kind !== "left-panel-section") return null;
  if (dropPreview.panelId !== panelId) return null;
  return dropPreview.position === "before" ? "top" : "bottom";
}

function PanelGroupBody(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly panels: ReadonlyArray<LeftPanelDefinition>;
}) {
  return (
    <GroupedPanelBody
      epicId={props.epicId}
      tabId={props.tabId}
      panels={
        props.panels.length === 0
          ? [
              getLeftPanelDefinition(
                EPIC_LEFT_PANEL_DEFINITIONS_BY_ID,
                DEFAULT_LEFT_PANEL_ID,
              ),
            ]
          : props.panels
      }
    />
  );
}

interface PanelSectionRun {
  readonly type: "collapsed" | "expanded";
  readonly panels: ReadonlyArray<LeftPanelDefinition>;
}

function bucketPanelSectionRuns(
  panels: ReadonlyArray<LeftPanelDefinition>,
  collapsedById: Readonly<Partial<Record<LeftPanelId, boolean>>>,
): ReadonlyArray<PanelSectionRun> {
  return panels.reduce<PanelSectionRun[]>((runs, panel) => {
    const type: PanelSectionRun["type"] = collapsedById[panel.id]
      ? "collapsed"
      : "expanded";
    const last = runs.at(-1);
    if (last !== undefined && last.type === type) {
      return [...runs.slice(0, -1), { type, panels: [...last.panels, panel] }];
    }
    return [...runs, { type, panels: [panel] }];
  }, []);
}

function GroupedPanelBody(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly panels: ReadonlyArray<LeftPanelDefinition>;
}) {
  const collapsedById = useEpicLeftPanelStore(
    (s) => s.panelSectionCollapsedByPanelId,
  );
  const panelIds = useMemo(
    () => props.panels.map((panel) => panel.id),
    [props.panels],
  );
  const sectionRuns = useMemo(
    () => bucketPanelSectionRuns(props.panels, collapsedById),
    [props.panels, collapsedById],
  );
  const groupDropId = getLeftPanelGroupDropId(
    props.epicId,
    panelIds[0] ?? DEFAULT_LEFT_PANEL_ID,
  );
  const groupDropData = useMemo<EpicCanvasDropTargetData>(
    () => ({ kind: "left-panel-group", viewTabId: props.tabId, panelIds }),
    [panelIds, props.tabId],
  );
  const { setNodeRef: groupDropRef } = useDroppable({
    id: getPaneScopedDndId(props.tabId, groupDropId),
    data: groupDropData,
  });
  // Narrow selector: only a left-panel-section preview tick re-renders this
  // group body; canvas strip/body preview ticks never reach it.
  const sectionDropPreview = useEpicDndStore((s) =>
    s.dropPreview?.kind === "left-panel-section" &&
    s.dropPreview.viewTabId === props.tabId &&
    s.activeSource?.kind === "left-panel-rail-item" &&
    s.activeSource.viewTabId === props.tabId
      ? s.dropPreview
      : null,
  );
  return (
    <div
      ref={groupDropRef}
      data-dnd-droppable-id={getPaneScopedDndId(props.tabId, groupDropId)}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {sectionRuns.map((run, runIndex) => (
        <PanelSectionRunRenderer
          key={run.panels.map((panel) => panel.id).join("|")}
          epicId={props.epicId}
          tabId={props.tabId}
          run={run}
          runIndex={runIndex}
          dropPreview={sectionDropPreview}
        />
      ))}
    </div>
  );
}

/**
 * Synthetic group id for the section run's resize handles; the commit
 * callback maps fractions straight back to panel weights, so the id is only
 * surfaced on the handle's `data-resize-group-id` for tests.
 */
const SECTION_RUN_GROUP_ID = "epic-left-panel-sections";
/** Old `minSize="2rem"` floor, now enforced by the custom handle. */
const SECTION_MIN_PX = 32;

function PanelSectionRunRenderer(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly run: PanelSectionRun;
  readonly runIndex: number;
  readonly dropPreview: EpicCanvasDropPreview;
}) {
  const { epicId, tabId, run, dropPreview } = props;
  const isResizable = run.type === "expanded" && run.panels.length >= 2;

  if (!isResizable) {
    return (
      <>
        {run.panels.map((panel) => (
          <PanelGroupSection
            key={panel.id}
            epicId={epicId}
            tabId={tabId}
            panel={panel}
            boundaryEdge={getSectionBoundaryEdge(panel.id, dropPreview)}
          />
        ))}
      </>
    );
  }
  return (
    <ResizableSectionRun
      epicId={epicId}
      tabId={tabId}
      panels={run.panels}
      dropPreview={dropPreview}
    />
  );
}

function ResizableSectionRun(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly panels: ReadonlyArray<LeftPanelDefinition>;
  readonly dropPreview: EpicCanvasDropPreview;
}) {
  const { epicId, tabId, panels, dropPreview } = props;
  const setPanelSectionWeights = useEpicLeftPanelStore(
    (s) => s.setPanelSectionWeights,
  );
  const weightsByPanelId = useEpicLeftPanelStore(
    (s) => s.panelSectionWeightsByPanelId,
  );

  // Stored weights are an arbitrary-sum unit (legacy percent-ish numbers);
  // the resize engine works on fractions. Normalize live - a handle drag
  // mutates DOM only, then commits fractions which map back to weights
  // preserving the run's current weight sum.
  const { fractions, referenceSum } = useMemo(() => {
    const fallback = 100 / panels.length;
    const weights = panels.map((panel) => {
      const stored = weightsByPanelId[panel.id];
      if (stored === undefined || stored <= 0) return fallback;
      return stored;
    });
    const sum = weights.reduce((acc, weight) => acc + weight, 0);
    return {
      fractions: weights.map((weight) => weight / sum),
      referenceSum: sum,
    };
  }, [panels, weightsByPanelId]);

  const handleCommitSizes = useCallback(
    (_groupId: string, sizes: ReadonlyArray<number>) => {
      setPanelSectionWeights(
        panels.map((panel, panelIndex) => ({
          panelId: panel.id,
          weight: (sizes[panelIndex] ?? 0) * referenceSum,
        })),
      );
    },
    [panels, referenceSum, setPanelSectionWeights],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {panels.map((panel, panelIndex) => (
        <Fragment key={panel.id}>
          {panelIndex > 0 ? (
            <SplitResizeHandle
              groupId={SECTION_RUN_GROUP_ID}
              index={panelIndex - 1}
              direction="vertical"
              sizes={fractions}
              minChildPx={SECTION_MIN_PX}
              className="bg-border/60"
              onCommitSizes={handleCommitSizes}
            />
          ) : null}
          <div
            data-split-child
            className="relative min-h-0 min-w-0"
            style={{
              flexGrow: fractions[panelIndex],
              flexBasis: 0,
              flexShrink: 1,
            }}
          >
            <div className="flex h-full min-h-0 flex-col">
              <PanelGroupSection
                epicId={epicId}
                tabId={tabId}
                panel={panel}
                boundaryEdge={getSectionBoundaryEdge(panel.id, dropPreview)}
              />
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function PanelGroupSection(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly panel: LeftPanelDefinition;
  readonly boundaryEdge: PanelSectionBoundaryEdge | null;
}) {
  const collapsed = useLeftPanelSectionCollapsed(props.panel.id);
  if (
    isSidebarBulkSelectionPanelId(props.panel.id) &&
    props.panel.Actions !== null
  ) {
    return (
      <SidebarBulkSelectionProvider
        panelId={props.panel.id}
        collapsed={collapsed}
      >
        <PanelGroupSectionContent
          epicId={props.epicId}
          tabId={props.tabId}
          panel={props.panel}
          boundaryEdge={props.boundaryEdge}
          collapsed={collapsed}
        />
        <SidebarBulkDeleteController
          epicId={props.epicId}
          tabId={props.tabId}
        />
      </SidebarBulkSelectionProvider>
    );
  }
  return (
    <PanelGroupSectionContent
      epicId={props.epicId}
      tabId={props.tabId}
      panel={props.panel}
      boundaryEdge={props.boundaryEdge}
      collapsed={collapsed}
    />
  );
}

function PanelGroupSectionContent(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly panel: LeftPanelDefinition;
  readonly boundaryEdge: PanelSectionBoundaryEdge | null;
  readonly collapsed: boolean;
}) {
  const Body = props.panel.Body;
  return (
    <section
      className={cn(
        "group/panel-section relative flex min-h-0 flex-col border-b border-border/60 last:border-b-0",
        props.collapsed ? "flex-none" : "flex-1",
      )}
      data-testid={`epic-left-panel-section-${props.panel.id}`}
      data-left-panel-section-id={props.panel.id}
    >
      <PanelGroupSectionHeader
        epicId={props.epicId}
        tabId={props.tabId}
        panel={props.panel}
      />
      {props.collapsed ? null : (
        <PanelBodyDropRegion>
          <Body epicId={props.epicId} tabId={props.tabId} />
        </PanelBodyDropRegion>
      )}
      {props.boundaryEdge !== null ? (
        <PanelSectionBoundaryLine edge={props.boundaryEdge} />
      ) : null}
    </section>
  );
}

/**
 * Per-panel empty-space reparent drop target (`sidebar-reparent-panel`). The
 * tree rows sit INSIDE this droppable; the collision ladder picks a row when
 * the pointer is over a row and the panel only when it is over empty space, so
 * a drop here un-nests the dragged node to root (`parentId = null`). Filling
 * the panel's scroll area (`min-h-full`) makes the empty area below the rows
 * droppable. Highlighted (subtle inset ring) when this panel is the active
 * root target.
 */
function SidebarReparentPanelDropZone(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly panelId: RootCreatePanelId;
  readonly children: ReactNode;
}) {
  const { epicId, viewTabId, panelId, children } = props;
  const dropData = useMemo<EpicCanvasDropTargetData>(
    () => ({
      kind: "sidebar-reparent-panel",
      epicId,
      viewTabId,
      panelId,
    }),
    [epicId, viewTabId, panelId],
  );
  const { setNodeRef } = useDroppable({
    id: getPaneScopedDndId(viewTabId, getSidebarReparentPanelDropId(panelId)),
    data: dropData,
  });
  const isRootTarget = useSidebarReparentRootActive(viewTabId, panelId);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-full flex-col rounded-md",
        isRootTarget && "ring-2 ring-inset ring-primary/50",
      )}
    >
      {children}
    </div>
  );
}

function ChatsPanelBody(props: LeftPanelBodyProps) {
  return (
    <SnapshotGate skeleton={CHATS_PANEL_SKELETON}>
      <SidebarReparentPanelDropZone
        epicId={props.epicId}
        viewTabId={props.tabId}
        panelId="chats"
      >
        <ChatTreePanelBody epicId={props.epicId} tabId={props.tabId} />
      </SidebarReparentPanelDropZone>
    </SnapshotGate>
  );
}

function ArtifactsPanelBody(props: LeftPanelBodyProps) {
  return (
    <SnapshotGate skeleton={ARTIFACTS_PANEL_SKELETON}>
      <SidebarReparentPanelDropZone
        epicId={props.epicId}
        viewTabId={props.tabId}
        panelId="artifacts"
      >
        <ArtifactTreePanelBody epicId={props.epicId} tabId={props.tabId} />
      </SidebarReparentPanelDropZone>
    </SnapshotGate>
  );
}

function CommentsPanelBody(props: LeftPanelBodyProps) {
  return (
    <SnapshotGate skeleton={COMMENTS_PANEL_SKELETON}>
      <CommentsPanelBodyLive epicId={props.epicId} tabId={props.tabId} />
    </SnapshotGate>
  );
}

function ChatsLoadingPanelBody(): ReactNode {
  return CHATS_PANEL_SKELETON;
}

function ArtifactsLoadingPanelBody(): ReactNode {
  return ARTIFACTS_PANEL_SKELETON;
}

function CommentsLoadingPanelBody(): ReactNode {
  return COMMENTS_PANEL_SKELETON;
}

function FileTreeLoadingPanelBody(): ReactNode {
  return FILE_TREE_PANEL_SKELETON;
}

function TerminalsLoadingPanelBody(): ReactNode {
  return TERMINALS_PANEL_SKELETON;
}

function GenericLoadingPanelBody(): ReactNode {
  return GENERIC_PANEL_SKELETON;
}

function GenericPanelSkeleton(): ReactNode {
  return (
    <div
      aria-busy="true"
      className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-2"
    >
      <Skeleton className="h-3 w-2/3 rounded" />
      <Skeleton className="h-3 w-full rounded" />
      <Skeleton className="h-3 w-5/6 rounded" />
      <Skeleton className="h-3 w-3/5 rounded" />
    </div>
  );
}

function CommentsPanelBodyLive(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const activeArtifactId = useActiveEpicArtifactId(props.tabId);
  // Normally unreachable - the panel is revealed by an artifact that has
  // comments. Reachable once a user checks Comments in the rail context menu,
  // which keeps the panel there regardless of what the canvas is showing.
  if (activeArtifactId === null) {
    return (
      <SidebarPanelEmptyState
        icon={MessageSquareText}
        title="No artifact open"
        description="Open an artifact to see and add comments on it."
        testId="epic-comments-empty"
      />
    );
  }
  return (
    <CommentSidebarPanel
      epicId={props.epicId}
      activeArtifactId={activeArtifactId}
    />
  );
}

function GitDiffPanelBody(props: LeftPanelBodyProps): ReactNode {
  return <GitDiffPanelBodyLive epicId={props.epicId} tabId={props.tabId} />;
}

function FileTreePanelBody(props: LeftPanelBodyProps) {
  return (
    <SnapshotGate skeleton={FILE_TREE_PANEL_SKELETON}>
      <FileTreePanelBodyLive epicId={props.epicId} tabId={props.tabId} />
    </SnapshotGate>
  );
}

function FileTreePanelBodyLive(props: LeftPanelBodyProps) {
  const selection = useFileTreeWorkspaceSelection(props.epicId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {selection.selectedWorkspacePath === null ? (
        <SidebarPanelEmptyState
          icon={FolderOpen}
          title="No workspace linked."
          description={null}
          testId="epic-file-tree-empty"
        />
      ) : (
        <>
          <div className="shrink-0 px-2 pb-1.5 pt-0.5">
            <WorkspacePickerWithOpener
              picker={
                <FileTreeWorkspacePicker
                  epicId={props.epicId}
                  hostId={selection.hostId}
                  selectedPath={selection.selectedWorkspacePath}
                  onSelectPath={selection.setSelectedWorkspacePath}
                />
              }
              openTarget={
                selection.hostId !== null
                  ? {
                      workspacePath: selection.selectedWorkspacePath,
                      hostId: selection.hostId,
                    }
                  : null
              }
            />
          </div>
          <FileTreePanelBodyForWorkspace
            key={selection.selectedWorkspacePath}
            epicId={props.epicId}
            tabId={props.tabId}
            workspacePath={selection.selectedWorkspacePath}
          />
        </>
      )}
    </div>
  );
}

function SharingPanelBody(props: LeftPanelBodyProps) {
  return <SharingPanel epicId={props.epicId} />;
}

// Display title for a projection: artifacts carry a `kind`; every Agent
// projection (Chat- or Terminal-interface) falls back to "Untitled agent" -
// the durable Agent identity - when its stored title is empty, never
// "Untitled chat" or the harness label.
function epicArtifactRecordDisplayTitle(
  record: EpicArtifactProjection | EpicChatProjection | EpicTuiAgentProjection,
): string {
  if ("kind" in record) return displayTitle(record.title, record.kind);
  return displayTitle(record.title, "agent");
}

function CommentsPanelSubtitle(props: LeftPanelSlotProps) {
  const activeArtifactId = useActiveEpicArtifactId(props.tabId);
  const artifactRecord = useEpicArtifact(activeArtifactId);
  if (artifactRecord === null) return null;
  return (
    <p className="truncate text-overline text-muted-foreground">
      {epicArtifactRecordDisplayTitle(artifactRecord)}
    </p>
  );
}

// Root-create "+" reuses the same per-panel exclude lists as the row "+"
// (derived from ADDABLE_TYPES in add-node-dropdown), so root and child menus
// can't drift.

type SidebarDeleteTargetKind = "artifact" | "chat" | "terminal-agent";

interface SidebarDeleteTarget {
  readonly id: string;
  readonly kind: SidebarDeleteTargetKind;
}

function SidebarBulkDeleteController(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const selection = useSidebarBulkSelection();
  const liveRecords = useEpicArtifactRecords();
  const tree = useEpicTreeIndex();
  const epicHandle = useOpenEpicHandle();
  const navigateNested = useEpicNestedFocusNavigation();
  const closeCanvasTab = useEpicCanvasStore((s) => s.closeCanvasTab);
  const markArtifactSelfDeleted = useEpicCanvasStore(
    (s) => s.markArtifactSelfDeleted,
  );
  const unmarkArtifactSelfDeleted = useEpicCanvasStore(
    (s) => s.unmarkArtifactSelfDeleted,
  );
  const deleteArtifact = useEpicDeleteArtifact();
  const deleteChat = useEpicDeleteChat();
  const deleteTerminalAgent = useEpicDeleteTuiAgent();
  const recordById = useMemo(
    () => new Map(liveRecords.map((record) => [record.id, record])),
    [liveRecords],
  );
  const {
    pendingDeleteIds,
    deletePending,
    panelId,
    closeDeleteDialog,
    setDeletePending,
    clearSelectedIds,
    cancelSelection,
  } = selection;

  const handleConfirmDelete = useCallback(() => {
    if (pendingDeleteIds === null || deletePending) return;
    const rootmostIds = rootmostSelectedSidebarIds({
      ids: pendingDeleteIds,
      tree,
    });
    const targets = rootmostIds.flatMap((id) => {
      const target = sidebarDeleteTargetForRecord(recordById.get(id));
      return target === null ? [] : [target];
    });
    if (targets.length === 0) {
      closeDeleteDialog();
      return;
    }
    targets.forEach((target) => {
      epicHandle.store.getState().deleteArtifact(target.id);
      markArtifactSelfDeleted(target.id);
    });
    setDeletePending(true);
    void Promise.allSettled(
      targets.map((target) => {
        switch (target.kind) {
          case "artifact":
            return deleteArtifact.mutateAsync({
              epicId: props.epicId,
              artifactId: target.id,
            });
          case "chat":
            return deleteChat.mutateAsync({
              epicId: props.epicId,
              chatId: target.id,
            });
          case "terminal-agent":
            return deleteTerminalAgent.mutateAsync({
              epicId: props.epicId,
              tuiAgentId: target.id,
            });
        }
      }),
    )
      .then((results) => {
        const successfulIds = targets.flatMap((target, index) =>
          results[index].status === "fulfilled" ? [target.id] : [],
        );
        const failedIds = targets.flatMap((target, index) =>
          results[index].status === "rejected" ? [target.id] : [],
        );
        // Closing several tabs is one focus-relevant change, not N: closing
        // each through its own `prepareCloseCanvasTabFocusTarget` call would
        // let an intermediate iteration's fallback focus (e.g. the next
        // still-being-deleted tab) get pushed as a route entry. Instead,
        // close every successfully-deleted open tab raw, then compute and
        // commit the post-batch focus target exactly once.
        const openTargets = successfulIds.flatMap((id) => {
          const found = findOpenArtifactInTab(props.tabId, id);
          return found === null ? [] : [found];
        });
        if (openTargets.length > 0) {
          navigateNested(props.epicId, props.tabId, () => {
            openTargets.forEach((found) => {
              closeCanvasTab(props.tabId, found.paneId, found.instanceId);
            });
            const canvas =
              useEpicCanvasStore.getState().canvasByTabId[props.tabId] ??
              EMPTY_CANVAS;
            return getCurrentNestedFocusTarget(canvas);
          });
        }
        failedIds.forEach((id) => {
          unmarkArtifactSelfDeleted(id);
        });
        clearSelectedIds(successfulIds);
        if (failedIds.length === 0) {
          cancelSelection();
        } else {
          closeDeleteDialog();
        }
      })
      .finally(() => {
        setDeletePending(false);
      });
  }, [
    cancelSelection,
    clearSelectedIds,
    closeCanvasTab,
    closeDeleteDialog,
    deleteArtifact,
    deleteChat,
    deletePending,
    deleteTerminalAgent,
    epicHandle,
    markArtifactSelfDeleted,
    navigateNested,
    pendingDeleteIds,
    props.epicId,
    props.tabId,
    recordById,
    setDeletePending,
    tree,
    unmarkArtifactSelfDeleted,
  ]);

  return (
    <ConfirmDestructiveDialog
      open={pendingDeleteIds !== null}
      onOpenChange={(open) => {
        if (!open) closeDeleteDialog();
      }}
      title={describeSidebarBulkDeleteTitle(
        panelId,
        pendingDeleteIds,
        recordById,
      )}
      description={describeSidebarBulkDeleteDescription(pendingDeleteIds)}
      cascadeSummary={null}
      actionLabel="Delete"
      isPending={deletePending}
      onConfirm={handleConfirmDelete}
    />
  );
}

function sidebarDeleteTargetForRecord(
  record: EpicTreeRecord | undefined,
): SidebarDeleteTarget | null {
  if (record === undefined) return null;
  if (record.type === "chat") {
    return { id: record.id, kind: "chat" };
  }
  if (record.type === "terminal-agent") {
    return { id: record.id, kind: "terminal-agent" };
  }
  return { id: record.id, kind: "artifact" };
}

interface SelectedChatArchiveAction {
  readonly supported: boolean;
  readonly pending: boolean;
  readonly selectedHasActiveAgent: boolean;
  readonly archiveSelected: () => void;
}

function useSelectedChatArchive(canMutate: boolean): SelectedChatArchiveAction {
  const selection = useSidebarBulkSelection();
  const supported = useChatArchiveSupported();
  const archiveChats = useEpicArchiveChats();
  const activeAgentIds = useEpicActiveAgentIds();
  const tree = useEpicTreeIndex();
  const latestTreeRef = useRef(tree);
  useLayoutEffect(() => {
    latestTreeRef.current = tree;
  }, [tree]);
  const epicId = useOpenEpicHandle().epicId;
  const selectedRootIds = useMemo(
    () =>
      rootmostSelectedSidebarIds({
        ids: selection.selectedVisibleIds,
        tree,
      }),
    [selection.selectedVisibleIds, tree],
  );
  const selectedHasActiveAgent =
    sidebarIdsWithinRoots({
      ids: [...activeAgentIds],
      rootIds: selectedRootIds,
      tree,
    }).length > 0;
  const archiveSelected = useCallback(() => {
    if (
      selection.panelId !== "chats" ||
      !supported ||
      !canMutate ||
      archiveChats.isPending ||
      selectedRootIds.length === 0 ||
      selectedHasActiveAgent
    ) {
      return;
    }
    archiveChats.mutate(
      { epicId, chatIds: selectedRootIds, archived: true },
      {
        onSuccess: (results) => {
          const successfulRootIds = selectedRootIds.filter(
            (_id, index) => results[index].status === "fulfilled",
          );
          // Checkboxes stay interactive while the batch is pending. Clear each
          // successful root even if projection already removed it, plus only
          // the descendants still beneath it in the latest committed tree.
          // That includes collaborators' additions without clearing children
          // they moved elsewhere while the request was in flight.
          const latestTree = latestTreeRef.current;
          const successfulSubtreeIds = new Set([
            ...successfulRootIds,
            ...sidebarIdsWithinRoots({
              ids: Object.keys(latestTree.nodeById),
              rootIds: successfulRootIds,
              tree: latestTree,
            }),
          ]);
          selection.clearSelectedIds([...successfulSubtreeIds]);
          // If a collaborator moves a selected row beneath this root after
          // the response snapshot, the later archive projection can be the
          // event that removes the final selection. Arm that one projection
          // path so it exits instead of leaving a zero-selected toolbar.
          if (successfulRootIds.length > 0) {
            selection.armSelectablePruneExit(successfulRootIds);
          }
        },
      },
    );
  }, [
    archiveChats,
    canMutate,
    epicId,
    selectedHasActiveAgent,
    selectedRootIds,
    selection,
    supported,
  ]);
  return {
    supported,
    pending: archiveChats.isPending,
    selectedHasActiveAgent,
    archiveSelected,
  };
}

function describeSidebarBulkDeleteTitle(
  panelId: SidebarBulkSelectionPanelId,
  ids: readonly string[] | null,
  recordById: ReadonlyMap<string, EpicTreeRecord>,
): string {
  if (ids === null || ids.length === 0) return "";
  if (ids.length === 1) {
    const record = recordById.get(ids[0]);
    return record === undefined
      ? "Delete selected item?"
      : `Delete "${record.name}"?`;
  }
  return `Delete ${ids.length} selected ${panelRowNoun(panelId, ids.length)}?`;
}

/**
 * Plural noun naming a panel's rows in user-facing copy.
 *
 * Deliberately NOT the panel `id`: the id is an internal identifier on the
 * compatibility boundary (`"chats"`), and interpolating it directly produced
 * "Delete 3 selected chats" - copy that silently drifts from the panel's own
 * title. A mixed Chat/Terminal selection summarizes as **agents**, because
 * Agent is the durable entity being deleted and the interface is incidental.
 *
 * `count` selects number: the delete button is enabled from one row, so a
 * plural-only noun produced "Delete 1 selected agents".
 */
function panelRowNoun(panelId: LeftPanelId, count: number): string {
  if (panelId === "chats") return count === 1 ? "agent" : "agents";
  return count === 1 ? "artifact" : "artifacts";
}

function describeSidebarBulkDeleteDescription(
  ids: readonly string[] | null,
): string {
  if (ids === null || ids.length < 2) return "This action cannot be undone.";
  return "This action cannot be undone. Nested items under selected rows may also be deleted.";
}

function usePanelRootIds(panelId: LeftPanelId): ReadonlyArray<string> {
  const yDocRootIds = useRootIds();
  const liveRecords = useEpicArtifactRecords();
  return useMemo(() => {
    const treeFilter =
      panelId === "chats"
        ? (type: string | null | undefined) =>
            type === "chat" || type === "terminal-agent"
        : (type: string | null | undefined) =>
            type !== null &&
            type !== undefined &&
            type !== "chat" &&
            type !== "terminal" &&
            type !== "terminal-agent";
    const recordById = new Map(
      liveRecords.map((record) => [record.id, record]),
    );
    // Both panels derive root order from `yDocRootIds` (the projector's
    // `rootIds`, already sorted by `createdAt`). For chats this keeps GUI
    // chats and terminal-agents interleaved by time; iterating the record
    // list instead would surface the slice order (all chats, then all
    // terminal-agents). `yDocRootIds` only holds parentless nodes, so
    // nested child agents are excluded for free.
    return yDocRootIds.filter((rootId) =>
      treeFilter(recordById.get(rootId)?.type),
    );
  }, [liveRecords, panelId, yDocRootIds]);
}

interface TreePanelActionsProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly panelId: RootCreatePanelId;
  readonly collapsed: boolean;
  readonly addLabel: string;
  readonly menuTestId: string;
  readonly triggerTestId: string;
  readonly itemTestId: (type: EpicNodeKind) => string;
  readonly excludeTypes: ReadonlyArray<EpicNodeKind>;
}

class ProjectedOpenCancelRegistry {
  private readonly cancels = new Set<() => void>();

  add(cancel: () => void): void {
    this.cancels.add(cancel);
  }

  delete(cancel: () => void): void {
    this.cancels.delete(cancel);
  }

  cancelAll(): void {
    for (const cancel of this.cancels) {
      cancel();
    }
    this.cancels.clear();
  }
}

function useCollapseAllPanelAction(
  tabId: string,
  panelId: RootCreatePanelId,
): () => void {
  const rootIds = usePanelRootIds(panelId);
  const activeArtifactId = useActiveEpicArtifactId(tabId);
  const ancestorIdsOfActive = useAncestorIds(activeArtifactId);
  const expandedIds = useEpicSidebarEffectiveExpanded(
    tabId,
    panelId,
    rootIds,
    ancestorIdsOfActive,
  );
  const collapseAll = useEpicSidebarExpansionStore((s) => s.collapseAll);
  return useCallback(() => {
    collapseAll(tabId, panelId, expandedIds);
  }, [collapseAll, expandedIds, panelId, tabId]);
}

function TreePanelActions(props: TreePanelActionsProps) {
  const permissionRole = useEpicPermissionRole();
  const connectionStatus = useEpicConnectionStatus();
  const isDisconnected = connectionStatus === "closed";
  const canEdit = isEditableRole(permissionRole);
  const canMutate = canEdit && !isDisconnected;
  const epicHandle = useOpenEpicHandle();
  const activeHostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const createArtifact = useEpicCreateArtifact();
  const setLocalRootCreatePending = useEpicLeftPanelStore(
    (s) => s.setLocalRootCreatePending,
  );
  const clearLocalRootCreatePending = useEpicLeftPanelStore(
    (s) => s.clearLocalRootCreatePending,
  );
  const setAcknowledgedRootCreatePending = useEpicLeftPanelStore(
    (s) => s.setAcknowledgedRootCreatePending,
  );
  const clearAcknowledgedRootCreatePending = useEpicLeftPanelStore(
    (s) => s.clearAcknowledgedRootCreatePending,
  );
  const projectedOpenCancels = useMemo(
    () => new ProjectedOpenCancelRegistry(),
    [],
  );
  useEffect(() => {
    return () => {
      projectedOpenCancels.cancelAll();
    };
  }, [projectedOpenCancels]);
  const openRootWhenProjected = useCallback(
    (nodeId: string, onBeforeOpen: ((node: EpicNodeRef) => void) | null) => {
      const cancel = openProjectedSidebarNodeInTabWhenAvailable({
        epicHandle,
        tabId: props.tabId,
        nodeId,
        fallbackHostId: activeHostId,
        openTileInTab: (targetTabId, nodeRef) => {
          navigateNested(props.epicId, targetTabId, () =>
            prepareOpenTileInTabFocusTarget(targetTabId, nodeRef),
          );
        },
        onBeforeOpen,
        onOpened: () => {
          clearAcknowledgedRootCreatePending(props.epicId, props.panelId);
        },
        onUnavailable: () => {
          clearAcknowledgedRootCreatePending(props.epicId, props.panelId);
        },
        onCleanup: (cleanup) => {
          projectedOpenCancels.delete(cleanup);
        },
      });
      projectedOpenCancels.add(cancel);
    },
    [
      activeHostId,
      clearAcknowledgedRootCreatePending,
      epicHandle,
      navigateNested,
      prepareOpenTileInTabFocusTarget,
      projectedOpenCancels,
      props.epicId,
      props.panelId,
      props.tabId,
    ],
  );
  const localRootPending = useLocalRootCreatePending(
    props.epicId,
    props.panelId,
  );
  const acknowledgedRootPending = useAcknowledgedRootCreatePending(
    props.epicId,
    props.panelId,
  );
  const artifactMenuOpen = usePanelHeaderMenuOpen(
    props.tabId,
    props.panelId,
    "create",
  );
  const setPanelHeaderMenuOpen = usePanelHeaderMenuStore(
    (state) => state.setMenuOpen,
  );
  const setPanelSectionCollapsed = useEpicLeftPanelStore(
    (state) => state.setPanelSectionCollapsed,
  );
  const addIsPending =
    localRootPending !== null ||
    acknowledgedRootPending !== null ||
    createArtifact.isPending;
  const addRoot = useCallback(
    (type: EpicNodeKind) => {
      if (!canMutate) return;
      if (type === "chat" || type === "terminal" || type === "terminal-agent") {
        return;
      }
      const pendingName = DEFAULT_EPIC_NODE_NAMES[type];
      setLocalRootCreatePending(props.epicId, props.panelId, pendingName);
      createArtifact.mutate(
        {
          epicId: props.epicId,
          parentId: null,
          artifactType: type,
          title: DEFAULT_EPIC_NODE_NAMES[type],
        },
        {
          onSuccess: (result) => {
            clearLocalRootCreatePending(props.epicId, props.panelId);
            setAcknowledgedRootCreatePending(
              props.epicId,
              props.panelId,
              result.artifactId,
              pendingName,
            );
            openRootWhenProjected(result.artifactId, (node) => {
              requestArtifactEditorFocus(node.id, node.instanceId);
            });
          },
          onError: () => {
            clearLocalRootCreatePending(props.epicId, props.panelId);
          },
        },
      );
    },
    [
      canMutate,
      clearLocalRootCreatePending,
      createArtifact,
      props.epicId,
      props.panelId,
      openRootWhenProjected,
      setAcknowledgedRootCreatePending,
      setLocalRootCreatePending,
    ],
  );

  const artifactsDisabledTooltip = mutationDisabledHint(
    permissionRole,
    isDisconnected,
    "create artifacts",
  );
  const artifactsAddDisabled = !canMutate || addIsPending;
  const artifactsPresentation = resolveDisabledPresentation(
    artifactsAddDisabled,
    artifactsDisabledTooltip,
  );

  const expandBeforeOpen = useCallback(() => {
    if (props.collapsed) setPanelSectionCollapsed(props.panelId, false);
  }, [props.collapsed, props.panelId, setPanelSectionCollapsed]);
  const handleArtifactMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open) expandBeforeOpen();
      setPanelHeaderMenuOpen(props.tabId, props.panelId, "create", open);
    },
    [expandBeforeOpen, props.panelId, props.tabId, setPanelHeaderMenuOpen],
  );

  if (props.panelId === "chats") {
    return (
      <NewConversationModalAction
        epicId={props.epicId}
        tabId={props.tabId}
        parentId={null}
        size="icon-sm"
        disabled={!canMutate || addIsPending}
        disabledTooltip={mutationDisabledHint(
          permissionRole,
          isDisconnected,
          "create agents",
        )}
        triggerLabel={props.addLabel}
        triggerTestId={props.triggerTestId}
        actionRevealClassName=""
        onBeforeOpen={expandBeforeOpen}
      />
    );
  }

  return (
    <AddNodeDropdown
      open={artifactMenuOpen}
      onOpenChange={handleArtifactMenuOpenChange}
      menuPlacement="header"
      epicId={props.epicId}
      menuTestId={props.menuTestId}
      itemTestId={props.itemTestId}
      onAdd={addRoot}
      onAddTerminalAgent={undefined}
      terminalAgentWorkspaceSeed={null}
      terminalAgentHostScope={undefined}
      // Root create keeps the epic-scoped default launcher slot; only chat /
      // agent ROWS override with a per-parent key (T4).
      terminalAgentStagingKey={undefined}
      tuiAgentPending={undefined}
      excludeTypes={props.excludeTypes}
      disabledTypes={undefined}
      disabled={artifactsAddDisabled}
      disabledTooltip={artifactsDisabledTooltip}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={props.addLabel}
        aria-disabled={artifactsPresentation.ariaDisabled ? true : undefined}
        data-testid={props.triggerTestId}
        className={cn(
          "text-muted-foreground hover:text-foreground",
          ARIA_DISABLED_TRIGGER_CLASS,
        )}
        disabled={artifactsPresentation.nativeDisabled}
      >
        {addIsPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : (
          <Plus className="size-4" />
        )}
      </Button>
    </AddNodeDropdown>
  );
}

function ChatsPanelActions(props: LeftPanelHeaderSlotProps) {
  const selection = useSidebarBulkSelection();
  const canArchive = useChatArchiveSupported();
  const collapseAll = useCollapseAllPanelAction(props.tabId, "chats");
  if (selection.selectionMode) return <SidebarBulkSelectionActions />;
  return (
    <div className="flex items-center gap-0.5">
      {props.mode === "search" ? null : (
        <>
          <TreePanelActions
            epicId={props.epicId}
            tabId={props.tabId}
            panelId="chats"
            collapsed={props.collapsed}
            addLabel="Add agent"
            menuTestId="epic-sidebar-add-chat-root-menu"
            triggerTestId="epic-sidebar-add-chat-root"
            itemTestId={(type) => `epic-sidebar-add-chat-root-${type}`}
            excludeTypes={CHAT_PANEL_EXCLUDED_TYPES}
          />
          <ChatHeaderMoreMenu
            epicId={props.epicId}
            tabId={props.tabId}
            collapsed={props.collapsed}
          />
        </>
      )}
      <ChatFilterMenu
        epicId={props.epicId}
        tabId={props.tabId}
        collapsed={props.collapsed}
        canArchive={canArchive}
        onCollapseAll={collapseAll}
      />
    </div>
  );
}

function useUnreadArtifactReadTargets(
  epicId: string,
): ReadonlyArray<ArtifactReadTarget> {
  const records = useEpicArtifactRecords();
  const tree = useEpicTreeIndex();
  const readState = useArtifactReadStateStore(
    useShallow((s) => ({
      seedAtByEpic: s.seedAtByEpic,
      lastSeenByArtifact: s.lastSeenByArtifact,
    })),
  );
  return useMemo(
    () =>
      records.flatMap((record) => {
        if (!isEpicArtifactKind(record.type)) return [];
        if (!Object.hasOwn(tree.nodeById, record.id)) return [];
        const node = tree.nodeById[record.id];
        return isArtifactUnread({
          epicId,
          artifactId: record.id,
          updatedAt: node.updatedAt,
          seedAtByEpic: readState.seedAtByEpic,
          lastSeenByArtifact: readState.lastSeenByArtifact,
        })
          ? [{ id: record.id, updatedAt: node.updatedAt }]
          : [];
      }),
    [epicId, readState, records, tree],
  );
}

function PanelHeaderMoreMenuTrigger(props: {
  readonly label: string;
  readonly testId: string;
}) {
  return (
    <TooltipWrapper
      label={props.label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={props.label}
          className="shrink-0 text-muted-foreground hover:text-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground"
          data-testid={props.testId}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
    </TooltipWrapper>
  );
}

function useExpandableHeaderMenu(
  tabId: string,
  panelId: LeftPanelId,
  collapsed: boolean,
): {
  readonly open: boolean;
  readonly handleOpenChange: (open: boolean) => void;
} {
  const open = usePanelHeaderMenuOpen(tabId, panelId, "more");
  const setMenuOpen = usePanelHeaderMenuStore((state) => state.setMenuOpen);
  const setPanelSectionCollapsed = useEpicLeftPanelStore(
    (state) => state.setPanelSectionCollapsed,
  );
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && collapsed) setPanelSectionCollapsed(panelId, false);
      setMenuOpen(tabId, panelId, "more", nextOpen);
    },
    [collapsed, panelId, setMenuOpen, setPanelSectionCollapsed, tabId],
  );
  return { open, handleOpenChange };
}

function ChatHeaderMoreMenu(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly collapsed: boolean;
}) {
  const selection = useSidebarBulkSelection();
  const permissionRole = useEpicPermissionRole();
  const connectionStatus = useEpicConnectionStatus();
  const menu = useExpandableHeaderMenu(props.tabId, "chats", props.collapsed);
  const selectionEnabled = selection.canSelect && connectionStatus !== "closed";

  return (
    <DropdownMenu open={menu.open} onOpenChange={menu.handleOpenChange}>
      <PanelHeaderMoreMenuTrigger
        label="More agent actions"
        testId="epic-sidebar-more-chats"
      />
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        avoidCollisions={false}
        className="w-[var(--radix-dropdown-menu-content-available-width)] min-w-0 max-w-56"
      >
        <CommGraphOpenMenuItem epicId={props.epicId} disabled={false} />
        {isEditableRole(permissionRole) ? (
          <DropdownMenuItem
            disabled={!selectionEnabled}
            onSelect={selection.enterSelectionMode}
          >
            <ListChecks className="size-4" />
            Select agents
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArtifactHeaderMoreMenu(props: {
  readonly tabId: string;
  readonly collapsed: boolean;
}) {
  const selection = useSidebarBulkSelection();
  const searchAvailable = useArtifactSearchAvailable();
  const openSearch = usePanelHeaderSearchStore((state) => state.openSearch);
  const menu = useExpandableHeaderMenu(
    props.tabId,
    "artifacts",
    props.collapsed,
  );

  return (
    <DropdownMenu open={menu.open} onOpenChange={menu.handleOpenChange}>
      <PanelHeaderMoreMenuTrigger
        label="More artifact actions"
        testId="epic-sidebar-more-artifacts"
      />
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        avoidCollisions={false}
        className="w-[var(--radix-dropdown-menu-content-available-width)] min-w-0 max-w-52"
      >
        {searchAvailable ? (
          <DropdownMenuItem
            onSelect={() => openSearch(props.tabId, "artifacts", "")}
            data-testid="epic-sidebar-more-search-artifacts"
          >
            Search artifacts
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          disabled={!selection.canSelect}
          onSelect={selection.enterSelectionMode}
        >
          <ListChecks className="size-4" />
          Select artifacts
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArtifactsPanelActions(props: LeftPanelHeaderSlotProps) {
  const selection = useSidebarBulkSelection();
  const unreadArtifacts = useUnreadArtifactReadTargets(props.epicId);
  const markRead = useArtifactReadStateStore((state) => state.markRead);
  const collapseAll = useCollapseAllPanelAction(props.tabId, "artifacts");
  const markAllRead = useCallback(() => {
    unreadArtifacts.forEach((artifact) => {
      markRead(props.epicId, artifact.id, artifact.updatedAt);
    });
  }, [markRead, props.epicId, unreadArtifacts]);
  if (selection.selectionMode) return <SidebarBulkSelectionActions />;
  return (
    <div className="flex items-center gap-0.5">
      {props.mode === "search" ? null : (
        <>
          <TreePanelActions
            epicId={props.epicId}
            tabId={props.tabId}
            panelId="artifacts"
            collapsed={props.collapsed}
            addLabel="Add artifact"
            menuTestId="epic-sidebar-add-artifact-root-menu"
            triggerTestId="epic-sidebar-add-artifact-root"
            itemTestId={(type) => `epic-sidebar-add-artifact-root-${type}`}
            excludeTypes={ARTIFACT_PANEL_EXCLUDED_TYPES}
          />
          <ArtifactHeaderMoreMenu
            tabId={props.tabId}
            collapsed={props.collapsed}
          />
        </>
      )}
      <ArtifactFilterMenu
        epicId={props.epicId}
        tabId={props.tabId}
        collapsed={props.collapsed}
        onCollapseAll={collapseAll}
        onMarkAllRead={markAllRead}
        markAllReadDisabled={unreadArtifacts.length === 0}
      />
    </div>
  );
}

function SidebarSelectedChatArchiveButton(props: {
  readonly visible: boolean;
  readonly selectedCount: number;
  readonly canMutate: boolean;
  readonly action: SelectedChatArchiveAction;
}) {
  if (!props.visible || !props.action.supported) return null;
  const label =
    props.selectedCount > 0
      ? `Archive ${props.selectedCount} selected ${panelRowNoun("chats", props.selectedCount)}`
      : "Archive selected agents";
  return (
    <TooltipWrapper
      label={
        props.action.selectedHasActiveAgent
          ? "Wait for selected agents to finish"
          : "Archive selected agents"
      }
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          data-testid="epic-sidebar-archive-selected-chats"
          disabled={
            props.selectedCount === 0 ||
            !props.canMutate ||
            props.action.pending ||
            props.action.selectedHasActiveAgent
          }
          onClick={props.action.archiveSelected}
        >
          {props.action.pending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : (
            <Archive className="size-4" />
          )}
        </Button>
      </span>
    </TooltipWrapper>
  );
}
function SidebarBulkSelectionActions() {
  const selection = useSidebarBulkSelection();
  const permissionRole = useEpicPermissionRole();
  const connectionStatus = useEpicConnectionStatus();
  const exportArtifacts = useEpicExportArtifacts();
  const records = useEpicArtifactRecords();
  const meta = useEpicSnapshotMeta();
  const canMutate =
    isEditableRole(permissionRole) && connectionStatus !== "closed";
  const chatArchive = useSelectedChatArchive(canMutate);
  const recordById = useMemo(
    () => new Map(records.map((record) => [record.id, record])),
    [records],
  );
  const selectedArtifacts = selection.selectedVisibleIds.flatMap((id) => {
    const record = recordById.get(id);
    if (record === undefined || !isEpicArtifactKind(record.type)) return [];
    return [{ id: record.id, title: record.name }];
  });
  const canExportSelected = selectedArtifacts.length >= 2;
  const exportSelected = (format: "markdown" | "pdf"): void => {
    exportArtifacts.mutate({
      artifacts: selectedArtifacts,
      format,
      archive: true,
      archiveTitle: meta?.epicLight?.title ?? "Traycer",
    });
  };
  return (
    <div className="flex items-center gap-0.5">
      <span
        className="mr-1 whitespace-nowrap text-ui-xs font-medium text-foreground @max-[21rem]:hidden"
        data-testid="epic-sidebar-artifact-selection-count"
        aria-live="polite"
      >
        {selection.selectedCount} selected
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={!selection.canSelect || chatArchive.pending}
        onClick={
          selection.allVisibleSelected
            ? selection.deselectAllVisible
            : selection.selectAllVisible
        }
      >
        {selection.allVisibleSelected ? "Deselect all" : "Select all"}
      </Button>
      <TooltipWrapper
        label="Cancel selection"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel selection"
            disabled={selection.deletePending || chatArchive.pending}
            onClick={selection.cancelSelection}
          >
            <X className="size-3.5" />
          </Button>
        </span>
      </TooltipWrapper>
      {selection.panelId === "artifacts" ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Export selected artifacts"
              disabled={!canExportSelected || exportArtifacts.isPending}
            >
              {exportArtifacts.isPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                />
              ) : (
                <Download className="size-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              data-testid="epic-sidebar-export-selected-markdown"
              disabled={!canExportSelected || exportArtifacts.isPending}
              onSelect={() => {
                exportSelected("markdown");
              }}
            >
              Export as Markdown ZIP
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="epic-sidebar-export-selected-pdf"
              disabled={!canExportSelected || exportArtifacts.isPending}
              onSelect={() => {
                exportSelected("pdf");
              }}
            >
              Export as PDF ZIP
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <SidebarSelectedChatArchiveButton
        visible={selection.panelId === "chats"}
        selectedCount={selection.selectedCount}
        canMutate={canMutate}
        action={chatArchive}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={
          selection.selectedCount > 0
            ? `Delete ${selection.selectedCount} selected ${panelRowNoun(selection.panelId, selection.selectedCount)}`
            : `Delete selected ${panelRowNoun(selection.panelId, 0)}`
        }
        data-testid={`epic-sidebar-delete-selected-${selection.panelId}`}
        disabled={
          selection.selectedCount === 0 ||
          !canMutate ||
          selection.deletePending ||
          chatArchive.pending
        }
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={selection.requestDeleteSelected}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

function CommentsPanelActions(props: LeftPanelHeaderSlotProps) {
  const setActivePanelId = useEpicLeftPanelStore((s) => s.setActivePanelId);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Close comments"
      data-testid="epic-sidebar-comments-close"
      className="text-muted-foreground hover:text-foreground"
      onClick={() => setActivePanelId(props.tabId, DEFAULT_LEFT_PANEL_ID)}
    >
      <X className="size-4" />
    </Button>
  );
}

interface CommentSidebarPanelProps {
  readonly epicId: string;
  readonly activeArtifactId: string;
}

function CommentSidebarPanel(props: CommentSidebarPanelProps) {
  const { epicId, activeArtifactId } = props;
  const artifactRecord = useEpicArtifact(activeArtifactId);
  const setFlashThread = useCommentThreadsStore((s) => s.setFlashThread);
  const anchorPositions = useArtifactAnchorPositions(epicId, activeArtifactId);
  const currentUserId = useAuthStore((state) => state.profile?.userId ?? null);

  const artifactKind =
    artifactRecord !== null && "kind" in artifactRecord
      ? artifactRecord.kind
      : null;

  if (artifactRecord === null || artifactKind === null) {
    return null;
  }

  return (
    <CommentSidebar
      epicId={epicId}
      artifactType={artifactKind}
      artifactId={activeArtifactId}
      anchorPositions={anchorPositions}
      currentUserId={currentUserId}
      canModerate={false}
      onActivateThread={(threadId) => {
        setFlashThread(epicId, threadId);
        revealCommentThreadAnchor(epicId, activeArtifactId, threadId);
      }}
    />
  );
}
