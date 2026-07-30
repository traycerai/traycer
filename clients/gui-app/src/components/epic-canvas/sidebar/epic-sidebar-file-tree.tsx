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
 *
 * Filtering has its own source, because lazy coverage makes a local filter
 * structurally incomplete - it can only match rows the panel already loaded.
 * With a live tree and a host that has `workspace.searchPaths`, a non-empty
 * filter is answered by that host-ranked search over the whole root; without
 * it (old host, refused root, reply in flight) the tree adapter's own
 * `hide-non-matches` filter runs over the loaded rows instead. See
 * `FileTreeMode`.
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
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { cn } from "@/lib/utils";
import type {
  FileTree as PierreFileTreeModel,
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
  GitStatusEntry,
} from "@pierre/trees";
import { Search } from "lucide-react";
import type { GitChangedFile } from "@traycer/protocol/host";
import type {
  WorkspaceListFileTreeResponse,
  WorkspaceSearchPathResult,
} from "@traycer/protocol/host/workspace/unary-schemas";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  getPaneScopedDndId,
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
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { useWorkspaceListFileTree } from "@/hooks/workspace/use-list-file-tree-query";
import {
  useWorkspaceFileListSubscription,
  type WorkspaceFileListSubscriptionResult,
} from "@/hooks/workspace/use-workspace-file-list-subscription";
import {
  readSearchPathsResponseForSource,
  useWorkspaceSearchPaths,
} from "@/hooks/workspace/use-workspace-search-paths-query";
import { useHostClient } from "@/lib/host";
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
  projectWorkspaceSearchPaths,
  type WorkspaceSearchPathsProjection,
} from "@/lib/workspace/workspace-path-search-projection";
import {
  useFileTreeExpandedPaths,
  useFileTreeStore,
} from "@/stores/file-tree/file-tree-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

const WORKSPACE_FILE_LIST_METHOD = "workspace.subscribeFileList";

/** Filter-box pause before either filter source runs. */
const SEARCH_DEBOUNCE_MS = 200;

const EMPTY_TREE_PATHS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_GIT_STATUS: ReadonlyArray<GitStatusEntry> = Object.freeze([]);
const EMPTY_CHANGED_FILES: ReadonlyArray<GitChangedFile> = Object.freeze([]);
const EMPTY_FILE_NAMES: ReadonlyMap<string, string> = new Map();
const EMPTY_SEARCH_PATH_RESULTS: ReadonlyArray<WorkspaceSearchPathResult> =
  Object.freeze([]);

/**
 * Which of the three inputs is currently building the tree.
 *
 * - `browse` - no filter query: the live listings (or the unary snapshot).
 * - `host-search` - the host answered `workspace.searchPaths` for this query,
 *   so its ranked matches ARE the tree. The only mode that can surface a file
 *   the panel never listed, which is the whole point: with lazy coverage the
 *   local filter can only ever match rows already loaded.
 * - `local-filter` - a query with no usable host answer (host too old, root
 *   refused, response still in flight, or the panel is on the unary snapshot
 *   and already holds every path): the tree adapter's own `hide-non-matches`
 *   filter runs over the loaded rows, exactly as before.
 *
 * A live tree whose host CANNOT search (the unsupported latch, not a reply
 * merely in flight) has a fourth wrinkle: its loaded rows are just the
 * expanded directories, so a local filter over them silently matches nothing
 * (the adapter shows the full tree when zero rows match). For that case the
 * panel borrows the deprecated whole-workspace snapshot for exactly the
 * lifetime of the query - `local-filter` then runs over every path, matching
 * the filter's whole-workspace mental model - and returns to the live stream
 * when the query clears. Stream coverage stays subscribed throughout.
 */
type FileTreeMode = "browse" | "host-search" | "local-filter";

interface FileTreeSource {
  readonly mode: FileTreeMode;
  readonly paths: ReadonlyArray<string>;
  /** Openable rows only; a path absent here is a directory row. */
  readonly fileNameByPath: ReadonlyMap<string, string>;
  readonly gitStatus: ReadonlyArray<GitStatusEntry>;
  /** What the tree adapter's own filter should match, or `null` for no filter. */
  readonly localFilterQuery: string | null;
  /** Rows to force open so host matches are visible; `null` outside search. */
  readonly searchExpandedPaths: ReadonlyArray<string> | null;
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
  /** Already debounced by the caller - this drives the host RPC. */
  readonly searchQuery: string;
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
  const search = useHostPathSearch({
    epicId: args.epicId,
    hostId: args.hostId,
    workspacePath: args.workspacePath,
    query: args.searchQuery,
    // Host search only earns its keep against the LIVE tree, where the loaded
    // rows are just the expanded directories. The unary snapshot already holds
    // every path, so filtering it locally is both complete and free.
    enabled: !useUnaryFallback,
  });
  const localFilterQuery =
    args.searchQuery.trim().length > 0 ? args.searchQuery : null;
  // A live tree whose host cannot search: the local filter would only see the
  // expanded rows (and the adapter shows everything when zero rows match), so
  // the query borrows the whole-workspace snapshot for its lifetime instead.
  const filterViaSnapshot =
    !useUnaryFallback &&
    localFilterQuery !== null &&
    search.hostSearchUnavailable;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the sanctioned legacy call site: the old-host fallback plus the filter's whole-workspace degrade while host search is unavailable
  const unary = useWorkspaceListFileTree(
    args.workspacePath,
    useUnaryFallback || filterViaSnapshot,
  );

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

  if (useUnaryFallback || filterViaSnapshot) {
    return unaryFileTreeSource({
      unary,
      paths: unaryPaths,
      fileNameByPath: unaryFileNameByPath,
      localFilterQuery,
    });
  }
  if (search.result !== null) {
    return hostSearchFileTreeSource(search.result, liveGitStatus);
  }
  return liveFileTreeSource(stream, liveGitStatus, localFilterQuery);
}

function unaryFileTreeSource(args: {
  readonly unary: UseQueryResult<WorkspaceListFileTreeResponse, HostRpcError>;
  readonly paths: ReadonlyArray<string>;
  readonly fileNameByPath: ReadonlyMap<string, string>;
  readonly localFilterQuery: string | null;
}): FileTreeSource {
  const { unary, paths, localFilterQuery } = args;
  return {
    mode: localFilterQuery === null ? "browse" : "local-filter",
    paths,
    fileNameByPath: args.fileNameByPath,
    gitStatus: unary.data?.gitStatus ?? EMPTY_GIT_STATUS,
    localFilterQuery,
    searchExpandedPaths: null,
    isLoading: unary.isLoading,
    hasError: unary.error !== null && paths.length === 0,
    truncationNotice:
      unary.data?.truncated === true
        ? `Showing the first ${paths.length.toLocaleString()} files - this workspace exceeds the preview limit.`
        : null,
    isLive: false,
  };
}

function hostSearchFileTreeSource(
  search: HostPathSearchResult,
  gitStatus: ReadonlyArray<GitStatusEntry>,
): FileTreeSource {
  return {
    mode: "host-search",
    paths: search.projection.paths,
    fileNameByPath: search.projection.fileNameByPath,
    gitStatus,
    // The host already ranked and filtered; re-running the row filter on top
    // would drop matches whose NAME does not contain the query verbatim.
    localFilterQuery: null,
    searchExpandedPaths: search.projection.expandedDirectoryPaths,
    isLoading: false,
    hasError: false,
    truncationNotice: search.truncated
      ? `Showing the first ${search.projection.paths.length.toLocaleString()} matches - narrow the filter to see more.`
      : null,
    isLive: true,
  };
}

function liveFileTreeSource(
  stream: WorkspaceFileListSubscriptionResult,
  gitStatus: ReadonlyArray<GitStatusEntry>,
  localFilterQuery: string | null,
): FileTreeSource {
  return {
    mode: localFilterQuery === null ? "browse" : "local-filter",
    paths: stream.paths,
    fileNameByPath: stream.fileNameByPath,
    gitStatus,
    localFilterQuery,
    searchExpandedPaths: null,
    isLoading: stream.isPending,
    hasError: stream.error !== null && stream.paths.length === 0,
    truncationNotice: stream.truncated
      ? "Some folders hold more files than can be shown."
      : null,
    isLive: true,
  };
}

interface HostPathSearchResult {
  readonly projection: WorkspaceSearchPathsProjection;
  readonly truncated: boolean;
}

/**
 * "This host cannot serve the method, ever" - the signal that latches the
 * panel onto local filtering for this (host, workspace). Two shapes qualify:
 * the clean client-side `E_HOST_UNSUPPORTED` (method absent from the
 * negotiated manifest), and the host-side 404 `RPC_ERROR` a host returns when
 * its registry carries the CONTRACT but no resolver is wired (a host built
 * between an OSS contract landing and its internal resolver landing
 * over-advertised exactly this way; see `handler.ts` "No resolver registered").
 * Transient failures (timeouts, connection drops) deliberately do NOT latch.
 */
function isHostCannotServeError(error: HostRpcError): boolean {
  if (error.code === "E_HOST_UNSUPPORTED") return true;
  return (
    error.code === "RPC_ERROR" &&
    error.message.includes("No resolver registered")
  );
}

interface HostPathSearch {
  /** Ranked matches ready to become the tree, or `null` when there are none usable. */
  readonly result: HostPathSearchResult | null;
  /**
   * The latched verdict that this (host, workspace) cannot serve
   * `workspace.searchPaths` at all - as opposed to a reply merely in flight.
   * The panel uses it to back the filter with the whole-workspace snapshot.
   */
  readonly hostSearchUnavailable: boolean;
}

/**
 * Host-ranked path search for the current filter query, or `null` whenever the
 * panel must keep filtering locally.
 *
 * `null` covers every degrade in one value: no query, the response still in
 * flight, a late reply whose echoed Epic/root no longer matches this panel, a
 * `root_unavailable` outcome (the root is not attached/authorized for this
 * Epic on this host), and a host that predates the method. That last one is
 * latched per (host, workspace): `workspace.searchPaths` is off the released
 * floor, so an old host rejects it CLIENT-side with `E_HOST_UNSUPPORTED` from
 * the negotiated manifest - cheap, but retried per keystroke otherwise, and
 * each new query mints a new cache key with a clean error slate. Latching
 * turns that into one verdict per host+workspace; changing either scope
 * re-probes, since the state is compared against the live scope key rather
 * than reset by an effect.
 */
function useHostPathSearch(args: {
  readonly epicId: string;
  readonly hostId: string | null;
  readonly workspacePath: string;
  readonly query: string;
  readonly enabled: boolean;
}): HostPathSearch {
  const hostClient = useHostClient();
  const scopeKey = `${args.hostId ?? ""}|${args.workspacePath}`;
  const [unsupportedScopeKey, setUnsupportedScopeKey] = useState<string | null>(
    null,
  );
  const unsupported = unsupportedScopeKey === scopeKey;

  const searchQuery = useWorkspaceSearchPaths({
    client: hostClient,
    epicId: args.epicId,
    root: args.workspacePath,
    query: args.query,
    // Files AND folders: this is a file-tree filter, so a folder whose name
    // matches is a legitimate destination, not just a container.
    kinds: "both",
    enabled: args.enabled && !unsupported,
  });

  if (
    searchQuery.error !== null &&
    isHostCannotServeError(searchQuery.error) &&
    unsupportedScopeKey !== scopeKey
  ) {
    setUnsupportedScopeKey(scopeKey);
  }

  const searchSource = useMemo(
    () => ({ root: args.workspacePath }),
    [args.workspacePath],
  );
  const view = readSearchPathsResponseForSource(
    searchQuery.data,
    args.epicId,
    searchSource,
  );
  const results =
    view !== null && view.outcome === "ready"
      ? view.results
      : EMPTY_SEARCH_PATH_RESULTS;
  const projection = useMemo(
    () => projectWorkspaceSearchPaths(results),
    [results],
  );
  const result = ((): HostPathSearchResult | null => {
    if (!args.enabled || unsupported) return null;
    if (args.query.trim().length === 0) return null;
    if (view === null || view.outcome !== "ready") return null;
    return { projection, truncated: view.truncated };
  })();
  return { result, hostSearchUnavailable: unsupported };
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
  // The box is a filter, not a search field: the query is applied on a pause,
  // and the same debounced value gates both the host RPC and the local row
  // filter so the two can never disagree about what is being filtered for.
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);
  const source = useFileTreeSource({
    epicId: props.epicId,
    hostId: activeHostId,
    workspacePath: props.workspacePath,
    searchQuery: debouncedQuery,
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
  const handleSearchQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(event.target.value);
    },
    [],
  );

  // Runs BEFORE the path reset below, deliberately. Clearing the tree
  // adapter's filter restores the expansion it captured when the filter was
  // applied; doing that after a reset would collapse the rows the reset just
  // opened for the host matches (the local-filter -> host-search handover).
  useEffect(() => {
    model.setSearch(source.localFilterQuery);
  }, [model, source.localFilterQuery]);

  useWorkspaceFileTreeExpansion({
    model,
    epicId: props.epicId,
    hostId: activeHostId,
    workspacePath: props.workspacePath,
    treePaths,
    enabled: source.isLive,
    mode: source.mode,
    searchExpandedPaths: source.searchExpandedPaths,
    localFilterQuery: source.localFilterQuery,
  });

  // Git status arrives from its own subscription; push it into Pierre's
  // imperative model whenever it changes. Pierre dedupes on stable inputs.
  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  // Pierre renders the FULL tree when a search matches zero rows - honest for
  // an always-fully-loaded tree, but here it reads as "the filter is broken".
  // Both filter modes surface an explicit empty state instead: host search by
  // an empty result set, the local filter by the model's live match count.
  const pierreSearch = useFileTreeSearch(model);
  const noMatches =
    source.mode === "host-search"
      ? source.paths.length === 0
      : source.localFilterQuery !== null &&
        pierreSearch.value.length > 0 &&
        pierreSearch.matchingPaths.length === 0;

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
    // Pane-scoped: the same workspace file tree can be open in both sides of a
    // split, and an unscoped drag id would collide between the two panes.
    id: getPaneScopedDndId(
      props.tabId,
      getWorkspaceFileDragId(props.workspacePath),
    ),
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
        {/* `invisible`, not unmount: the model keeps its DOM/state for the
            instant the query changes to something that does match. */}
        <div className={cn("h-full", noMatches && "invisible")}>
          <FileTree model={model} style={PIERRE_FILE_TREE_THEME_STYLE} />
        </div>
        {noMatches ? (
          <output
            aria-label="No matching files"
            className="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center text-ui-xs text-muted-foreground"
          >
            No files match the filter.
          </output>
        ) : null}
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
 * Pierre's `resetPaths` swaps the store but keeps the current search VALUE
 * while never recomputing its match set, and `setSearch` no-ops on an
 * unchanged value - so a filter that is active across a paths reset silently
 * stops filtering: the projection rebuilds against the stale match set from
 * the OLD store (often empty, which Pierre renders as "show everything").
 * Observed live when the whole-workspace snapshot replaced the live listings
 * mid-query. The null->value cycle forces a recomputation against the new
 * store, which also re-expands the ancestors of every hit.
 */
function reassertFilterAfterReset(
  model: PierreFileTreeModel,
  localFilterQuery: string | null,
): void {
  if (localFilterQuery === null) return;
  model.setSearch(null);
  model.setSearch(localFilterQuery);
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
 * While a filter query is active - either mode - expansion is driven by the
 * filter (the tree adapter expands its own matches; host search expands the
 * ancestors of the ranked results) rather than by the user, so syncing pauses
 * and the stream's coverage stays exactly where browsing left it.
 */
function useWorkspaceFileTreeExpansion(args: {
  readonly model: PierreFileTreeModel;
  readonly epicId: string;
  readonly hostId: string | null;
  readonly workspacePath: string;
  readonly treePaths: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly mode: FileTreeMode;
  readonly searchExpandedPaths: ReadonlyArray<string> | null;
  /** Active adapter filter, re-asserted after every reset (see below). */
  readonly localFilterQuery: string | null;
}): void {
  const {
    model,
    epicId,
    hostId,
    workspacePath,
    treePaths,
    enabled,
    mode,
    searchExpandedPaths,
    localFilterQuery,
  } = args;
  const setExpandedPaths = useFileTreeStore((s) => s.setExpandedPaths);
  const expandedPaths = useFileTreeExpandedPaths(epicId, hostId, workspacePath);
  const directoryPaths = useMemo(
    () => treePaths.filter((path) => path.endsWith("/")),
    [treePaths],
  );

  // Only a NEW path list resets the tree; the expansion sets are dependencies
  // because the reset re-seeds from them, not triggers of their own (re-seeding
  // on every expansion write would fight the user).
  const appliedPathsRef = useRef<ReadonlyArray<string>>(EMPTY_TREE_PATHS);
  useEffect(() => {
    if (appliedPathsRef.current === treePaths) return;
    appliedPathsRef.current = treePaths;
    if (!enabled) {
      model.resetPaths(treePaths);
      reassertFilterAfterReset(model, localFilterQuery);
      return;
    }
    // Host results are a flat ranked list, so nothing is visible until their
    // ancestors are open; browsing re-seeds the durable set instead. Either
    // way the reset owns expansion - the tree adapter's own default would
    // close everything.
    model.resetPaths(treePaths, {
      initialExpandedPaths: [...(searchExpandedPaths ?? expandedPaths)],
    });
    reassertFilterAfterReset(model, localFilterQuery);
  }, [
    enabled,
    expandedPaths,
    localFilterQuery,
    model,
    searchExpandedPaths,
    treePaths,
  ]);

  useEffect(() => {
    if (!enabled || hostId === null) return;
    const syncExpansion = () => {
      if (mode !== "browse") return;
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
    mode,
    model,
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
