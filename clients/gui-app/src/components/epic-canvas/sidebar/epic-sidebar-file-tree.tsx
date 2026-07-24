/**
 * The sidebar's workspace file tree.
 *
 * Two sources feed the same `@pierre/trees` model:
 *
 * - LIVE (default): `workspace.subscribeFileList` serves single-level
 *   listings and keeps every covered directory under a filesystem watch for
 *   as long as the stream is open. Expanding a row extends coverage; the
 *   union of covered listings is still a flat path list, so the tree adapter
 *   is unchanged. Git badges are overlaid from the existing
 *   `git.subscribeStatus` subscription - that pipeline stays the one source
 *   of truth - and `ignored` entries are dimmed through the tree's own
 *   ignored status, never hidden.
 * - FALLBACK: hosts older than the stream method reject it as unknown, and
 *   the panel transparently keeps using the unary `workspace.listFileTree`
 *   snapshot (25k files, 10s poll) with the git status that response carries.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type {
  FileTree as PierreFileTreeModel,
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
  GitStatusEntry,
} from "@pierre/trees";
import { Search } from "lucide-react";
import type { GitChangedFile } from "@traycer/protocol/host";
import {
  getWorkspaceFileDragId,
  WORKSPACE_FILE_DND_TYPE,
  type EpicCanvasDragSourceData,
} from "@/components/epic-canvas/dnd/dnd";
import { usePierreCanvasDragBridge } from "@/components/epic-canvas/dnd/use-pierre-canvas-drag-bridge";
import { extractPierreItemPathFromEvent } from "@/components/epic-canvas/pierre-tree-adapter";
import { PIERRE_FILE_TREE_THEME_STYLE } from "@/components/epic-canvas/pierre-tree-theme";
import { workspaceFileRefFromTreePath } from "@/components/epic-canvas/workspace-file/workspace-file-ref";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useGitListChangedFilesSubscription } from "@/hooks/git/use-git-list-changed-files-subscription";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useWorkspaceListFileTree } from "@/hooks/workspace/use-list-file-tree-query";
import { useWorkspaceFileListSubscription } from "@/hooks/workspace/use-workspace-file-list-subscription";
import { gitChangedFileToPierreStatusEntry } from "@/lib/git/panel-file-rendering";
import {
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";
import { mergeExpandedDirectoryPaths } from "@/lib/workspace/workspace-file-list-tree";
import {
  useFileTreeExpandedPaths,
  useFileTreeStore,
} from "@/stores/file-tree/file-tree-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

const WORKSPACE_FILE_LIST_METHOD = "workspace.subscribeFileList";

const EMPTY_TREE_PATHS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_GIT_STATUS: ReadonlyArray<GitStatusEntry> = Object.freeze([]);
const EMPTY_CHANGED_FILES: ReadonlyArray<GitChangedFile> = Object.freeze([]);
const EMPTY_FILE_NAMES: ReadonlyMap<string, string> = new Map();

interface FileTreeSource {
  readonly paths: ReadonlyArray<string>;
  /** Openable rows only; a path absent here is a directory row. */
  readonly fileNameByPath: ReadonlyMap<string, string>;
  readonly gitStatus: ReadonlyArray<GitStatusEntry>;
  readonly isLoading: boolean;
  readonly hasError: boolean;
  readonly truncationNotice: string | null;
  /** True while the live stream owns the tree, so expansion drives coverage. */
  readonly isLive: boolean;
}

function useFileTreeSource(args: {
  readonly epicId: string;
  readonly hostId: string | null;
  readonly workspacePath: string;
}): FileTreeSource {
  const wsStreamClient = useWsStreamClient();
  const streamSupport = useStreamMethodSupport(WORKSPACE_FILE_LIST_METHOD);
  // The client-side compatibility mirror marks a method the host does not
  // advertise as `"unsupported"` at handshake time and closes that session, so
  // this flag IS "the host rejected the subscribe as an unknown method". A
  // renderer with no stream transport at all can never be served by the stream
  // either, so it takes the same path.
  const useUnaryFallback =
    wsStreamClient === null || streamSupport === "unsupported";

  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );
  // Same params the Git panel subscribes with, so both surfaces share one
  // refcounted `git.subscribeStatus` session for this workspace.
  const gitStatusSubscription = useGitListChangedFilesSubscription({
    hostId: args.hostId,
    runningDir: args.workspacePath,
    ignoreWhitespace,
    enabled: !useUnaryFallback,
  });
  const stream = useWorkspaceFileListSubscription({
    epicId: args.epicId,
    hostId: args.hostId,
    workspacePath: args.workspacePath,
    enabled: !useUnaryFallback,
  });
  const unary = useWorkspaceListFileTree(args.workspacePath, useUnaryFallback);

  const unaryFiles = unary.data?.files;
  const unaryPaths = useMemo(
    () => unaryFiles?.map((file) => file.path) ?? EMPTY_TREE_PATHS,
    [unaryFiles],
  );
  const unaryFileNameByPath = useMemo(
    () =>
      unaryFiles === undefined
        ? EMPTY_FILE_NAMES
        : new Map(unaryFiles.map((file) => [file.path, file.name])),
    [unaryFiles],
  );

  const changedFiles = gitStatusSubscription.data?.files ?? EMPTY_CHANGED_FILES;
  const streamIgnoredPaths = stream.ignoredPaths;
  const liveGitStatus = useMemo<ReadonlyArray<GitStatusEntry>>(() => {
    const badges = changedFiles.map(gitChangedFileToPierreStatusEntry);
    const badgedPaths = new Set(badges.map((entry) => entry.path));
    return [
      ...badges,
      ...streamIgnoredPaths
        .filter((path) => !badgedPaths.has(path))
        .map((path) => ({ path, status: "ignored" as const })),
    ];
  }, [changedFiles, streamIgnoredPaths]);

  if (useUnaryFallback) {
    return {
      paths: unaryPaths,
      fileNameByPath: unaryFileNameByPath,
      gitStatus: unary.data?.gitStatus ?? EMPTY_GIT_STATUS,
      isLoading: unary.isLoading,
      hasError: unary.error !== null && unaryPaths.length === 0,
      truncationNotice:
        unary.data?.truncated === true
          ? `Showing the first ${unaryPaths.length.toLocaleString()} files - this workspace exceeds the preview limit.`
          : null,
      isLive: false,
    };
  }
  return {
    paths: stream.paths,
    fileNameByPath: stream.fileNameByPath,
    gitStatus: liveGitStatus,
    isLoading: stream.isPending,
    hasError: stream.error !== null && stream.paths.length === 0,
    truncationNotice: stream.truncated
      ? "Some folders hold more files than can be shown."
      : null,
    isLive: true,
  };
}

export function FileTreePanelBodyForWorkspace(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly workspacePath: string;
}) {
  // The file-tree panel resolves against the default host; opened tabs
  // stamp this host id onto their `WorkspaceFileRef` so they keep
  // resolving against the same host after a default-host swap or
  // reload (CLAUDE.md: tabs are bound to a host for life).
  const activeHostId = useReactiveActiveHostId();
  const source = useFileTreeSource({
    epicId: props.epicId,
    hostId: activeHostId,
    workspacePath: props.workspacePath,
  });

  // The source's path list is the source of truth for "what is an openable
  // file and what is its display name": a path absent from `fileNameByPath`
  // is a directory row and not openable.
  const treePaths = source.paths;
  const nameByTreePath = source.fileNameByPath;
  const gitStatus = source.gitStatus;

  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTilePreviewInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTilePreviewInTabFocusTarget,
  );
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );

  // Single source of truth for "tree row path -> workspace file ref". Reused by
  // the open handlers and the drag bridge so a row that is not an openable file
  // (no active host, or a directory row) is non-openable everywhere.
  const workspaceFileRefForTreePath = useCallback(
    (treePath: string): WorkspaceFileRef | null => {
      if (activeHostId === null) return null;
      const name = nameByTreePath.get(treePath);
      if (name === undefined) return null;
      return workspaceFileRefFromTreePath(
        activeHostId,
        props.workspacePath,
        treePath,
        name,
      );
    },
    [activeHostId, nameByTreePath, props.workspacePath],
  );

  // Pierre's useFileTree captures the onSelectionChange closure at mount,
  // so we forward the latest props through a ref the closure reads at
  // call time. Same trick for the double-click "open committed" handler.
  const handlersRef = useRef({
    onSelect(_treePath: string) {},
    onOpen(_treePath: string) {},
  });
  useEffect(() => {
    const openInTab = (
      treePath: string,
      open: (tabId: string, ref: WorkspaceFileRef) => NestedFocusTarget | null,
    ) => {
      const ref = workspaceFileRefForTreePath(treePath);
      if (ref === null) return;
      navigateNested(props.epicId, props.tabId, () => open(props.tabId, ref));
    };
    handlersRef.current.onSelect = (treePath) => {
      openInTab(treePath, prepareOpenTilePreviewInTabFocusTarget);
    };
    handlersRef.current.onOpen = (treePath) => {
      openInTab(treePath, prepareOpenTileInTabFocusTarget);
    };
  }, [
    navigateNested,
    workspaceFileRefForTreePath,
    props.epicId,
    props.tabId,
    prepareOpenTilePreviewInTabFocusTarget,
    prepareOpenTileInTabFocusTarget,
  ]);

  const { model } = useFileTree({
    paths: treePaths,
    initialExpansion: "closed",
    density: "compact",
    icons: "complete",
    stickyFolders: true,
    gitStatus,
    // `hide-non-matches`: the filter input below drops every row whose
    // name does not match, keeping only matches and their parents.
    fileTreeSearchMode: "hide-non-matches",
    onSelectionChange: (selectedPaths) => {
      const selectedPath = selectedPaths.at(-1);
      if (selectedPath === undefined) return;
      handlersRef.current.onSelect(selectedPath);
    },
  });
  const [searchQuery, setSearchQuery] = useState("");
  const searchDebounceTimerRef = useRef<number | null>(null);
  const clearPendingSearchDebounce = useCallback(() => {
    if (searchDebounceTimerRef.current === null) return;
    window.clearTimeout(searchDebounceTimerRef.current);
    searchDebounceTimerRef.current = null;
  }, []);
  const applySearchQuery = useCallback(
    (query: string) => {
      model.setSearch(query.length > 0 ? query : null);
      model.setGitStatus(gitStatus);
    },
    [model, gitStatus],
  );
  const handleSearchQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextQuery = event.target.value;
      setSearchQuery(nextQuery);
      clearPendingSearchDebounce();
      searchDebounceTimerRef.current = window.setTimeout(() => {
        searchDebounceTimerRef.current = null;
        applySearchQuery(nextQuery);
      }, 150);
    },
    [applySearchQuery, clearPendingSearchDebounce],
  );

  useEffect(() => clearPendingSearchDebounce, [clearPendingSearchDebounce]);

  useWorkspaceFileTreeExpansion({
    model,
    epicId: props.epicId,
    hostId: activeHostId,
    workspacePath: props.workspacePath,
    treePaths,
    enabled: source.isLive,
    searchQuery,
  });

  // Git status arrives from its own subscription; push it into Pierre's
  // imperative model whenever it changes. Pierre dedupes on stable inputs.
  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLElement>) => {
    const treePath = extractPierreItemPathFromEvent(event);
    if (treePath === null) return;
    handlersRef.current.onOpen(treePath);
  }, []);

  // Bridge Pierre's shadow-DOM rows into the canvas dnd-kit drag flow. The row
  // under the activating pointer is recovered via the same `data-item-path`
  // scrape used for open; directory rows resolve to `null` and stay
  // non-draggable.
  const epicId = props.epicId;
  const viewTabId = props.tabId;
  const resolveDragSourceData = useCallback(
    (event: PointerEvent): EpicCanvasDragSourceData | null => {
      const treePath = extractPierreItemPathFromEvent({ nativeEvent: event });
      if (treePath === null) return null;
      const ref = workspaceFileRefForTreePath(treePath);
      return ref === null
        ? null
        : { kind: WORKSPACE_FILE_DND_TYPE, epicId, viewTabId, ref };
    },
    [epicId, viewTabId, workspaceFileRefForTreePath],
  );
  const bridge = usePierreCanvasDragBridge({
    id: getWorkspaceFileDragId(props.workspacePath),
    resolveSourceData: resolveDragSourceData,
  });

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col px-2 pb-2"
      onDoubleClickCapture={handleDoubleClick}
    >
      <InputGroup className="mb-1.5 h-7 shrink-0">
        <InputGroupAddon align="inline-start">
          <Search className="size-3.5" aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="text"
          value={searchQuery}
          onChange={handleSearchQueryChange}
          placeholder="Filter files by name…"
          aria-label="Filter files by name"
          className="text-ui-sm"
        />
      </InputGroup>
      <div {...bridge.wrapperProps} className="relative min-h-0 flex-1">
        <FileTree model={model} style={PIERRE_FILE_TREE_THEME_STYLE} />
        {source.isLoading ? (
          <output
            aria-label="Loading files"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <AgentSpinningDots
              className="text-muted-foreground"
              testId={undefined}
              variant={undefined}
            />
          </output>
        ) : null}
        {source.hasError ? (
          <div className="flex items-center justify-between gap-2 p-1 text-ui-xs text-destructive">
            <span>Unable to load files.</span>
            <ReportIssueAction
              context={createReportIssueContext({
                title: "Unable to load files",
                message: "The workspace file tree could not be loaded.",
                code: null,
                source: "File tree",
              })}
              presentation="icon"
              className={undefined}
            />
          </div>
        ) : null}
      </div>
      {source.truncationNotice !== null ? (
        <p className="shrink-0 px-1 pt-1 text-ui-xs text-muted-foreground">
          {source.truncationNotice}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Keeps the tree's expansion and the store's expanded-path set in lockstep,
 * and re-seeds Pierre from the store on every path reset.
 *
 * Pierre owns expansion imperatively and rebuilds its store on `resetPaths`,
 * so the durable set has to be handed back on every reset or a live listing
 * frame would collapse the tree the user just opened. In the other direction
 * the store is what the stream's coverage is derived from, so a user
 * expand/collapse has to land there - Pierre exposes no expansion callback, so
 * its change notification is the trigger and the known directory rows are
 * re-read on each tick (a set comparison, and the store write is a no-op when
 * nothing moved).
 *
 * While a filter query is active the tree expands matches on its own and
 * restores the previous state when the query clears; that transient is not
 * user expansion and must not churn the stream's coverage, so syncing pauses.
 */
function useWorkspaceFileTreeExpansion(args: {
  readonly model: PierreFileTreeModel;
  readonly epicId: string;
  readonly hostId: string | null;
  readonly workspacePath: string;
  readonly treePaths: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly searchQuery: string;
}): void {
  const { model, epicId, hostId, workspacePath, treePaths, enabled } = args;
  const searchActive = args.searchQuery.length > 0;
  const setExpandedPaths = useFileTreeStore((s) => s.setExpandedPaths);
  const expandedPaths = useFileTreeExpandedPaths(epicId, hostId, workspacePath);
  const directoryPaths = useMemo(
    () => treePaths.filter((path) => path.endsWith("/")),
    [treePaths],
  );

  // Only a NEW path list resets the tree; `expandedPaths` is a dependency
  // because the reset re-seeds from it, not a trigger of its own (re-seeding
  // on every expansion write would fight the user).
  const appliedPathsRef = useRef<ReadonlyArray<string>>(EMPTY_TREE_PATHS);
  useEffect(() => {
    if (appliedPathsRef.current === treePaths) return;
    appliedPathsRef.current = treePaths;
    if (!enabled) {
      model.resetPaths(treePaths);
      return;
    }
    model.resetPaths(treePaths, {
      initialExpandedPaths: [...expandedPaths],
    });
  }, [enabled, expandedPaths, model, treePaths]);

  useEffect(() => {
    if (!enabled || hostId === null) return;
    const syncExpansion = () => {
      if (searchActive) return;
      setExpandedPaths(
        epicId,
        hostId,
        workspacePath,
        mergeExpandedDirectoryPaths(expandedPaths, directoryPaths, (path) =>
          isExpandedDirectory(model, path),
        ),
      );
    };
    const unsubscribe = model.subscribe(syncExpansion);
    syncExpansion();
    return unsubscribe;
  }, [
    directoryPaths,
    enabled,
    epicId,
    expandedPaths,
    hostId,
    model,
    searchActive,
    setExpandedPaths,
    workspacePath,
  ]);
}

function isExpandedDirectory(
  model: PierreFileTreeModel,
  directoryPath: string,
): boolean {
  const item = model.getItem(directoryPath);
  return item !== null && isDirectoryHandle(item) && item.isExpanded();
}

function isDirectoryHandle(
  item: FileTreeItemHandle,
): item is FileTreeDirectoryHandle {
  return item.isDirectory();
}
