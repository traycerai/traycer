import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Virtuoso } from "react-virtuoso";
import { SvgViewToggleButton } from "@/components/epic-canvas/renderers/svg-view-toggle-button";
import type {
  GitChangedFile,
  GitGetFileDiffResponse,
} from "@traycer/protocol/host";
import { useEditorOpen } from "@/hooks/editor/use-editor-open-mutation";
import { useEditorOpenFeedback } from "@/hooks/editor/use-editor-open-feedback";
import { useGitRefreshWorktreeStatus } from "@/hooks/git/use-git-refresh-worktree-status";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import {
  useGitListChangedFilesSubscription,
  type GitListChangedFilesSubscriptionResult,
} from "@/hooks/git/use-git-list-changed-files-subscription";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { DiffViewerPreferences } from "@/lib/diff/diff-viewer-preferences";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { GitDiffTileRef } from "@/stores/epics/canvas/types";
import {
  gitBundleGroupLabel,
  gitImageDiffRevisionKey,
  gitImageDiffRouting,
  gitImageDiffSides,
  gitStageLabel,
} from "@/lib/git/git-diff-tile";
import { gitChangedFileBelongsToBundleGroup } from "@/lib/git/panel-file-rendering";
import { ImageDiffView } from "@/components/epic-canvas/image-preview/image-diff-view";
import { getBasename, getDirname } from "@/lib/path/cross-platform-path";
import { DiffBundleLoadingSkeleton } from "@/components/epic-canvas/git-diff/diff-bundle-loading-skeleton";
import { DiffContentLoadingSkeleton } from "@/components/epic-canvas/git-diff/diff-content-loading-skeleton";
import {
  DiffTabHeaderPortal,
  DiffTabShell,
} from "@/components/epic-canvas/git-diff/diff-tab-shell";
import {
  DiffTabToolbar,
  type DiffTabToolbarView,
  type DiffTabToolbarViewPatch,
} from "@/components/epic-canvas/git-diff/diff-tab-toolbar";
import { FileDiffContent } from "@/components/epic-canvas/git-diff/file-diff-content";
import { BundleDiffFindRegistrationProvider } from "@/components/diff/bundle-diff-find-registration";
import { useDiffFindNavigation } from "@/components/diff/diff-find-navigation";
import { useRegisterDiffTileFindAdapter } from "@/components/diff/use-register-diff-tile-find-adapter";
import type { DiffFindMetadataUnitInput } from "@/lib/diff/diff-find";
import { useNativeDivScrollRestoration } from "@/hooks/scroll/use-native-div-scroll-restoration";
import { useBundleDiffScrollRestoration } from "@/hooks/scroll/use-bundle-diff-scroll-restoration";
import { BinaryPlaceholder } from "@/components/epic-canvas/binary-placeholder";
import { NoLongerChanged } from "@/components/epic-canvas/git-diff/placeholders/no-longer-changed";
import { SubscriptionErrorState } from "@/components/epic-canvas/git-diff/empty-states/subscription-error-state";
import { NoChangesInWorktree } from "@/components/epic-canvas/git-diff/empty-states/no-changes-in-worktree";
import { GitErrorBlock } from "@/components/epic-canvas/git-diff/git-error-block";
import { GitWatcherStatusNotice } from "@/components/epic-canvas/git-diff/git-watcher-status-notice";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEditableGitDiffSurface } from "@/components/epic-canvas/git-diff/git-diff-editing";
import { GitDiffEditStatusContent } from "@/components/epic-canvas/git-diff/git-diff-edit-status";
import {
  createLoadedDiffTileFindSource,
  createLoadingDiffTileFindSource,
  createMetadataOnlyDiffTileFindSource,
  createMissingDiffTileFindSource,
  type DiffTileFindRenderer,
  type DiffTileFindSource,
} from "@/stores/tile-find";
import {
  GIT_DIFF_BINARY_FIND_MESSAGE,
  GIT_DIFF_ERROR_FIND_MESSAGE,
  GIT_DIFF_LOADING_FIND_MESSAGE,
  GIT_DIFF_MISSING_FIND_MESSAGE,
  GIT_DIFF_TRUNCATED_FIND_MESSAGE,
  type GitBundleDiffTileRef,
  type GitFileDiffTileRef,
} from "@/components/epic-canvas/git-diff/git-diff-tile-shared";
import {
  gitBundleDiffFindFileId,
  useGitBundleDiffFind,
} from "@/components/epic-canvas/git-diff/git-bundle-diff-find";
import { BundleFileSection } from "@/components/epic-canvas/git-diff/git-bundle-file-section";
import { GitDiffDeadTileBanner } from "./dead-tile-banner";

// Safety cap so a hung host fetch can't wedge the spinning/disabled state.
const GIT_REFRESH_TIMEOUT_MS = 10_000;
const EMPTY_GIT_CHANGED_FILES: ReadonlyArray<GitChangedFile> = [];

interface GitDiffTileProps {
  readonly node: GitDiffTileRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
}

interface GitDiffTileLiveProps {
  readonly node: GitDiffTileRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
}

function isGitFileDiffTileRef(
  node: GitDiffTileRef,
): node is GitFileDiffTileRef {
  return node.diff.kind === "file";
}

function isGitBundleDiffTileRef(
  node: GitDiffTileRef,
): node is GitBundleDiffTileRef {
  return node.diff.kind === "bundle";
}

/** The file path a tile targets for "open in editor"; bundles have none. */
function tileOpenFilePath(diff: GitDiffTileRef["diff"]): string | null {
  return diff.kind === "bundle" ? null : diff.filePath;
}

export function GitDiffTile(props: GitDiffTileProps): ReactNode {
  const tabHostId = useTabHostId();
  const activeHostId = useReactiveActiveHostId();
  const reachability = useHostReachability(tabHostId);

  if (reachability.status === "unreachable") {
    return (
      <GitDiffDeadTileBanner
        hostLabel={reachability.hostLabel}
        reason="offline"
        testId={`git-diff-tile-${props.node.id}`}
      />
    );
  }
  if (tabHostId !== activeHostId) {
    return (
      <GitDiffDeadTileBanner
        hostLabel={reachability.hostLabel}
        reason="inactive"
        testId={`git-diff-tile-${props.node.id}`}
      />
    );
  }

  return (
    <GitDiffTileLive
      node={props.node}
      viewTabId={props.viewTabId}
      tileId={props.tileId}
      isActive={props.isActive}
    />
  );
}

function GitDiffTileLive(props: GitDiffTileLiveProps): ReactNode {
  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );
  // Gate on tile visibility: a diff tile in a background canvas tab must not
  // hold the host's status poller (and its watcher set) alive. On
  // re-activation, a still-running poller (another consumer kept it alive)
  // replays its cached snapshot immediately; if this tile was the sole
  // consumer, a fresh poller computes its first snapshot while the TanStack
  // cache keeps the previous data rendered - no blank frame either way.
  const subscription = useGitListChangedFilesSubscription({
    hostId: props.node.hostId,
    runningDir: props.node.diff.runningDir,
    ignoreWhitespace,
    enabled: props.isActive,
  });

  const bundleFileCount = bundleChangedFileCount(
    props.node,
    subscription.data?.files ?? null,
  );

  const header = buildTileHeader(
    props.node,
    subscription.data?.branch ?? null,
    subscription.data?.headSha ?? null,
    bundleFileCount,
  );

  return (
    <DiffTabShell
      primaryTitle={header.primaryTitle}
      secondaryLine={header.secondaryLine}
      contextLabel={header.contextLabel}
      toolbar={
        <>
          {/* Renders only while degraded, so the toolbar is unchanged in the
              healthy case rather than carrying a permanent empty slot. */}
          {/* Compact here, full-width in the panel header: a tile pane can be
              dragged to 240px and `DiffTabShell` makes the toolbar `shrink-0`,
              so a non-shrinking label would push the icon controls out. */}
          <GitWatcherStatusNotice
            status={subscription.watcherStatus}
            className={undefined}
            compact
          />
          <GitDiffTileToolbar
            node={props.node}
            viewTabId={props.viewTabId}
            onOpenFile={tileOpenFilePath(props.node.diff)}
            bundleFilePaths={bundleFilePaths(
              props.node,
              subscription.data?.files ?? null,
            )}
            initialLoading={subscription.isPending}
          />
        </>
      }
    >
      {isGitFileDiffTileRef(props.node) ? (
        <GitFileDiffTileBody
          node={props.node}
          subscription={subscription}
          isActive={props.isActive}
        />
      ) : null}
      {isGitBundleDiffTileRef(props.node) ? (
        <GitBundleDiffTileBody
          node={props.node}
          viewTabId={props.viewTabId}
          subscription={subscription}
          isActive={props.isActive}
        />
      ) : null}
    </DiffTabShell>
  );
}

interface GitDiffTileToolbarProps {
  readonly node: GitDiffTileRef;
  readonly viewTabId: string;
  readonly onOpenFile: string | null;
  // Bundle file paths for collapse/expand-all; null for single-file tiles.
  readonly bundleFilePaths: ReadonlyArray<string> | null;
  readonly initialLoading: boolean;
}

function GitDiffTileToolbar(props: GitDiffTileToolbarProps): ReactNode {
  const queryClient = useQueryClient();
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const diffViewerPreferences = useSettingsStore(
    (s) => s.diffViewerPreferences,
  );
  const patchDiffViewerPreferences = useSettingsStore(
    (s) => s.patchDiffViewerPreferences,
  );
  const editorOpen = useEditorOpen("file");
  const { mutateAsync: refreshWorktreeStatus } = useGitRefreshWorktreeStatus();
  const updateView = useEpicCanvasStore((s) => s.updateGitDiffTileViewInTab);
  const { active: openFileFeedbackActive, trigger: triggerOpenFileFeedback } =
    useEditorOpenFeedback();
  const openFileOpening = editorOpen.isPending || openFileFeedbackActive;

  const toolbarView = useMemo(
    () =>
      diffToolbarView(
        diffViewerPreferences,
        props.node.view.collapsedFilePaths,
      ),
    [diffViewerPreferences, props.node.view.collapsedFilePaths],
  );

  const handleViewPatch = useCallback(
    (patch: DiffTabToolbarViewPatch) => {
      if ("collapsedFilePaths" in patch) {
        updateView(props.viewTabId, props.node.id, {
          ...props.node.view,
          collapsedFilePaths: patch.collapsedFilePaths,
        });
        return;
      }
      patchDiffViewerPreferences(patch);
    },
    [
      patchDiffViewerPreferences,
      props.node.id,
      props.node.view,
      props.viewTabId,
      updateView,
    ],
  );

  const handleRefresh = useCallback(async () => {
    // Force a fresh status fetch and re-pull every open file diff in this
    // worktree; the promise settles once both land so the icon can spin.
    await Promise.all([
      refreshWorktreeStatus({
        hostId: props.node.hostId,
        runningDir: props.node.diff.runningDir,
        ignoreWhitespace: diffViewerPreferences.ignoreWhitespace,
      }),
      queryClient.invalidateQueries({
        predicate: (query) =>
          gitQueryKeys.matchFileDiff(
            query.queryKey,
            props.node.hostId,
            props.node.diff.runningDir,
            null,
          ),
      }),
    ]);
  }, [
    props.node.hostId,
    props.node.diff.runningDir,
    diffViewerPreferences.ignoreWhitespace,
    queryClient,
    refreshWorktreeStatus,
  ]);

  const refresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: props.initialLoading,
    timeoutMs: GIT_REFRESH_TIMEOUT_MS,
  });

  const handleOpenFile = useCallback(() => {
    if (props.onOpenFile === null) return;
    if (openFileOpening) return;
    triggerOpenFileFeedback();
    editorOpen.mutate({
      editorId: defaultEditor ?? "vscode",
      paths: [absoluteFilePath(props.node.diff.runningDir, props.onOpenFile)],
    });
  }, [
    defaultEditor,
    editorOpen,
    openFileOpening,
    props.node.diff.runningDir,
    props.onOpenFile,
    triggerOpenFileFeedback,
  ]);

  const paths = props.bundleFilePaths;
  const collapseAll =
    paths === null || paths.length === 0
      ? null
      : {
          allCollapsed: paths.every((path) =>
            props.node.view.collapsedFilePaths.includes(path),
          ),
          filePaths: paths,
        };

  return (
    <DiffTabToolbar
      view={toolbarView}
      onViewPatch={handleViewPatch}
      collapseAll={collapseAll}
      refreshing={refresh.refreshing}
      onRefresh={refresh.trigger}
      onOpenFile={props.onOpenFile !== null ? handleOpenFile : null}
      openFileDisabled={openFileOpening}
      openFileOpening={openFileOpening}
    />
  );
}

interface GitFileDiffTileBodyProps {
  readonly node: GitFileDiffTileRef;
  readonly subscription: GitListChangedFilesSubscriptionResult;
  readonly isActive: boolean;
}

function GitFileDiffTileBody(props: GitFileDiffTileBodyProps): ReactNode {
  const diffViewerPreferences = useSettingsStore(
    (s) => s.diffViewerPreferences,
  );
  if (props.subscription.error !== null) {
    return (
      <>
        <GitFileDiffFindRegistration
          tileInstanceId={props.node.instanceId}
          source={createMissingDiffTileFindSource({
            coverageMessage: GIT_DIFF_ERROR_FIND_MESSAGE,
          })}
          renderer={null}
        />
        <SubscriptionErrorState event={props.subscription.error} />
      </>
    );
  }
  if (props.subscription.isPending) {
    return (
      <>
        <GitFileDiffFindRegistration
          tileInstanceId={props.node.instanceId}
          source={createLoadingDiffTileFindSource({
            coverageMessage: GIT_DIFF_LOADING_FIND_MESSAGE,
          })}
          renderer={null}
        />
        <DiffContentLoadingSkeleton
          mode={diffViewerPreferences.mode}
          sizing="fill"
          density="full"
          sectionIndex={0}
        />
      </>
    );
  }

  const file =
    props.subscription.data?.files.find(
      (candidate) =>
        candidate.path === props.node.diff.filePath &&
        candidate.stage === props.node.diff.stage,
    ) ?? null;

  if (file === null) {
    return (
      <>
        <GitFileDiffFindRegistration
          tileInstanceId={props.node.instanceId}
          source={createMissingDiffTileFindSource({
            coverageMessage: GIT_DIFF_MISSING_FIND_MESSAGE,
          })}
          renderer={null}
        />
        <NoLongerChanged
          filePath={props.node.diff.filePath}
          stage={props.node.diff.stage}
        />
      </>
    );
  }

  return (
    <GitFileDiffPanel
      node={props.node}
      file={file}
      headSha={props.subscription.data?.headSha ?? ""}
      diffViewerPreferences={diffViewerPreferences}
      isActive={props.isActive}
    />
  );
}

interface GitFileDiffPanelProps {
  readonly node: GitFileDiffTileRef;
  readonly file: GitChangedFile;
  readonly headSha: string;
  readonly diffViewerPreferences: DiffViewerPreferences;
  readonly isActive: boolean;
}

function GitFileDiffPanel(props: GitFileDiffPanelProps): ReactNode {
  const tabHostClient = useTabHostClient();
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const editorOpen = useEditorOpen("file");
  const {
    active: openExternallyFeedbackActive,
    trigger: triggerOpenExternallyFeedback,
  } = useEditorOpenFeedback();
  const openExternallyOpening =
    editorOpen.isPending || openExternallyFeedbackActive;

  const { showImageDiff, svgToggle } = useGitImageDiffRouting(props.file);

  const {
    displayedDiff,
    displayedDiffError,
    displayedDiffPending,
    editing,
    loadFull,
  } = useEditableGitDiffSurface({
    client: tabHostClient,
    hostId: props.node.hostId,
    runningDir: props.node.diff.runningDir,
    file: props.file,
    headSha: props.headSha,
    ignoreWhitespace: props.diffViewerPreferences.ignoreWhitespace,
    surfaceId: `git-diff:${props.node.instanceId}`,
    isActive: props.isActive,
    queryEnabled: !props.file.isBinary && !showImageDiff,
    resumeDetachedDraft: false,
  });

  // Preserve scroll (both axes) across epic switches and remount, once the diff
  // has loaded for a non-binary file.
  const { scrollContainerRef, onScroll } = useNativeDivScrollRestoration(
    props.node.instanceId,
    isLoadedGitDiff(props.file.isBinary, displayedDiff, displayedDiffError),
  );
  const findNavigation = useDiffFindNavigation();
  const findSource = useMemo(
    () =>
      gitFileDiffFindSource({
        node: props.node,
        file: props.file,
        diff: displayedDiff ?? null,
        loading: displayedDiffPending,
        errored: displayedDiffError !== null,
        headSha: props.headSha,
        ignoreWhitespace: props.diffViewerPreferences.ignoreWhitespace,
        showingImage: showImageDiff,
      }),
    [
      displayedDiff,
      displayedDiffError,
      displayedDiffPending,
      props.diffViewerPreferences.ignoreWhitespace,
      props.file,
      props.headSha,
      props.node,
      showImageDiff,
    ],
  );
  useRegisterDiffTileFindAdapter({
    tileInstanceId: props.node.instanceId,
    tileKind: "git-diff",
    source: findSource,
    renderer: gitDiffFindRenderer({
      fileIsBinary: props.file.isBinary,
      isPending: displayedDiffPending,
      hasError: displayedDiffError !== null,
      diffIsBinary: displayedDiff?.isBinary ?? true,
      showingImage: showImageDiff,
      findNavigation,
    }),
  });
  const findScrollContainerRef = useCallback(
    (element: HTMLDivElement | null): void => {
      scrollContainerRef(element);
      findNavigation.setScrollContainer(element);
    },
    [findNavigation, scrollContainerRef],
  );

  const handleOpenExternally = useCallback(() => {
    if (openExternallyOpening) return;
    triggerOpenExternallyFeedback();
    editorOpen.mutate({
      editorId: defaultEditor ?? "vscode",
      paths: [absoluteFilePath(props.node.diff.runningDir, props.file.path)],
    });
  }, [
    defaultEditor,
    editorOpen,
    openExternallyOpening,
    props.file.path,
    props.node.diff.runningDir,
    triggerOpenExternallyFeedback,
  ]);

  if (showImageDiff) {
    const sides = gitImageDiffSides(props.file);
    const revisionKey = gitImageDiffRevisionKey(props.file, props.headSha);
    return (
      <>
        {svgToggle}
        <ImageDiffView
          key={revisionKey}
          revisionKey={revisionKey}
          runningDir={props.node.diff.runningDir}
          filePath={props.file.path}
          previousPath={props.file.previousPath}
          oldStage={sides.oldStage}
          newStage={sides.newStage}
          fileName={props.file.path}
          conflicted={sides.conflicted}
          compact={false}
          onOpenExternally={handleOpenExternally}
          openExternallyOpening={openExternallyOpening}
        />
      </>
    );
  }

  if (props.file.isBinary) {
    return (
      <>
        {svgToggle}
        <BinaryPlaceholder
          fileName={props.file.path}
          sizeBytes={props.file.sizeBytes}
          reason={null}
          onOpenExternally={handleOpenExternally}
          openExternallyOpening={openExternallyOpening}
          compact={false}
        />
      </>
    );
  }

  if (displayedDiff === undefined && displayedDiffError !== null) {
    return (
      <>
        {svgToggle}
        <GitErrorBlock error={displayedDiffError} />
      </>
    );
  }
  if (displayedDiff === undefined) {
    return (
      <>
        {svgToggle}
        <DiffContentLoadingSkeleton
          mode={props.diffViewerPreferences.mode}
          sizing="fill"
          density="full"
          sectionIndex={0}
        />
      </>
    );
  }

  if (displayedDiff.isBinary) {
    return (
      <>
        {svgToggle}
        <BinaryPlaceholder
          fileName={props.file.path}
          sizeBytes={props.file.sizeBytes}
          reason={null}
          onOpenExternally={handleOpenExternally}
          openExternallyOpening={openExternallyOpening}
          compact={false}
        />
      </>
    );
  }

  return (
    <>
      {svgToggle}
      <FileDiffContent
        diff={displayedDiff}
        mode={props.diffViewerPreferences.mode}
        wordWrap={props.diffViewerPreferences.wordWrap}
        backgrounds={props.diffViewerPreferences.backgrounds}
        lineNumbers={props.diffViewerPreferences.lineNumbers}
        indicatorStyle={props.diffViewerPreferences.indicatorStyle}
        sizing="fill"
        scrollContainerRef={findScrollContainerRef}
        onScroll={onScroll}
        onLoadFull={loadFull}
        fileIdentity={{
          findFilePath: props.file.path,
          bundleFindFileId: gitBundleDiffFindFileId(props.file),
        }}
        isEmptyFile={editing.canOfferEdit ? props.file.sizeBytes === 0 : false}
        editStatus={
          <DiffTabHeaderPortal>
            <GitDiffEditStatusContent editing={editing} appearance="pill" />
          </DiffTabHeaderPortal>
        }
        editAdapter={editing.editAdapter}
        editSession={editing.editSession}
      />
    </>
  );
}

/**
 * SVG keeps a per-tile, non-persisted toggle back to the existing text-diff
 * path, portaled into the tile's shared header (mirrors `editStatus` below)
 * - the routing decision itself is shared with bundle sections, see
 * `gitImageDiffRouting`.
 */
function useGitImageDiffRouting(file: GitChangedFile): {
  readonly showImageDiff: boolean;
  readonly svgToggle: ReactNode;
} {
  const { routeToImageDiff, isSvg } = gitImageDiffRouting(file);
  const [viewAsSource, setViewAsSource] = useState(false);
  const showImageDiff = routeToImageDiff && !(isSvg && viewAsSource);
  const svgToggle = isSvg ? (
    <DiffTabHeaderPortal>
      <SvgViewToggleButton
        switchTo={showImageDiff ? "source" : "image"}
        onClick={() => setViewAsSource((current) => !current)}
      />
    </DiffTabHeaderPortal>
  ) : null;
  return { showImageDiff, svgToggle };
}

function isLoadedGitDiff(
  fileIsBinary: boolean,
  diff: GitGetFileDiffResponse | undefined,
  error: unknown,
): boolean {
  return !fileIsBinary && diff !== undefined && error === null;
}

function gitDiffFindRenderer<T>(args: {
  readonly fileIsBinary: boolean;
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly diffIsBinary: boolean;
  /** Currently showing `ImageDiffView` (raster binary, or `.svg` still on its default image view) - no searchable diff text. */
  readonly showingImage: boolean;
  readonly findNavigation: T;
}): T | null {
  if (
    args.fileIsBinary ||
    args.showingImage ||
    args.isPending ||
    args.hasError ||
    args.diffIsBinary
  ) {
    return null;
  }
  return args.findNavigation;
}

function GitFileDiffFindRegistration(props: {
  readonly tileInstanceId: string;
  readonly source: DiffTileFindSource;
  readonly renderer: DiffTileFindRenderer | null;
}): ReactNode {
  useRegisterDiffTileFindAdapter({
    tileInstanceId: props.tileInstanceId,
    tileKind: "git-diff",
    source: props.source,
    renderer: props.renderer,
  });
  return null;
}

function gitFileDiffFindSource(args: {
  readonly node: GitFileDiffTileRef;
  readonly file: GitChangedFile;
  readonly diff: GitGetFileDiffResponse | null;
  readonly loading: boolean;
  readonly errored: boolean;
  readonly headSha: string;
  readonly ignoreWhitespace: boolean;
  /** Currently showing `ImageDiffView` (raster binary, or `.svg` still on its default image view) - no searchable diff text. */
  readonly showingImage: boolean;
}): DiffTileFindSource {
  const metadataUnits = gitFileDiffMetadataUnits({
    node: args.node,
    file: args.file,
  });

  if (args.file.isBinary || args.showingImage) {
    return createMetadataOnlyDiffTileFindSource({
      metadataUnits,
      coverageMessage: GIT_DIFF_BINARY_FIND_MESSAGE,
    });
  }
  if (args.loading) {
    return createLoadingDiffTileFindSource({
      coverageMessage: GIT_DIFF_LOADING_FIND_MESSAGE,
    });
  }
  if (args.errored || args.diff === null) {
    return createMissingDiffTileFindSource({
      coverageMessage: GIT_DIFF_ERROR_FIND_MESSAGE,
    });
  }
  if (args.diff.isBinary) {
    return createMetadataOnlyDiffTileFindSource({
      metadataUnits,
      coverageMessage: GIT_DIFF_BINARY_FIND_MESSAGE,
    });
  }
  return createLoadedDiffTileFindSource({
    patch: args.diff.patch,
    metadataUnits,
    cacheKey: [
      "git-file",
      args.node.instanceId,
      args.node.diff.runningDir,
      args.file.path,
      args.file.previousPath ?? "none",
      args.file.stage,
      args.headSha,
      args.diff.stagedOid ?? "none",
      args.diff.worktreeOid ?? "none",
      args.ignoreWhitespace ? "ignore-ws" : "with-ws",
      args.diff.isTruncated ? "truncated" : "full",
    ].join(":"),
    isPartial: args.diff.isTruncated,
    partialMessage: GIT_DIFF_TRUNCATED_FIND_MESSAGE,
  });
}

function gitFileDiffMetadataUnits(args: {
  readonly node: GitFileDiffTileRef;
  readonly file: GitChangedFile;
}): ReadonlyArray<DiffFindMetadataUnitInput> {
  const directory = getDirname(args.file.path);
  const previousPath = args.file.previousPath ?? "";
  return [
    {
      id: `git-file:${args.file.stage}:${args.file.path}`,
      filePath: args.file.path,
      scopeId: null,
      text: [
        getBasename(args.file.path),
        directory.length > 0 ? directory : "Repository root",
        args.file.path,
        previousPath,
        gitStageLabel(args.file.stage),
        getBasename(args.node.diff.runningDir),
      ]
        .filter((part) => part.length > 0)
        .join(" "),
    },
  ];
}

interface GitBundleDiffTileBodyProps {
  readonly node: GitBundleDiffTileRef;
  readonly viewTabId: string;
  readonly subscription: GitListChangedFilesSubscriptionResult;
  readonly isActive: boolean;
}

function GitBundleDiffTileBody(props: GitBundleDiffTileBodyProps): ReactNode {
  const diffViewerPreferences = useSettingsStore(
    (s) => s.diffViewerPreferences,
  );
  const bundleGroup = props.node.diff.bundleGroup;
  // Derive content before any early return so the restoration hooks run
  // unconditionally (React rules of hooks).
  const data = props.subscription.isPending ? null : props.subscription.data;
  const subscriptionFiles = data?.files ?? null;
  const files = useMemo(
    () =>
      subscriptionFiles === null
        ? EMPTY_GIT_CHANGED_FILES
        : subscriptionFiles.filter((file) =>
            gitChangedFileBelongsToBundleGroup(file, bundleGroup),
          ),
    [bundleGroup, subscriptionFiles],
  );
  const { virtuosoRef, restoreStateFrom, isScrolling } =
    useBundleDiffScrollRestoration(props.node.instanceId, files.length > 0);
  const { registration: bundleFindRegistration, setRootElement } =
    useGitBundleDiffFind({
      node: props.node,
      viewTabId: props.viewTabId,
      files,
      headSha: data?.headSha ?? null,
      ignoreWhitespace: diffViewerPreferences.ignoreWhitespace,
      hasSubscriptionError: props.subscription.error !== null,
      subscriptionPending: props.subscription.isPending,
      virtuosoRef,
    });

  if (props.subscription.error !== null) {
    return <SubscriptionErrorState event={props.subscription.error} />;
  }
  if (props.subscription.isPending) {
    return <DiffBundleLoadingSkeleton mode={diffViewerPreferences.mode} />;
  }
  if (data === null) return null;
  if (files.length === 0) {
    return (
      <NoChangesInWorktree
        lastUpdatedAtMs={props.subscription.pollStartedAtMs}
      />
    );
  }

  return (
    <BundleDiffFindRegistrationProvider value={bundleFindRegistration}>
      <div ref={setRootElement} className="h-full min-h-0">
        <Virtuoso
          ref={virtuosoRef}
          restoreStateFrom={restoreStateFrom}
          isScrolling={isScrolling}
          data={files}
          className="h-full min-h-0"
          overscan={6}
          computeItemKey={(_index, file) => `${file.path}:${file.stage}`}
          // eslint-disable-next-line react/no-unstable-nested-components -- Virtuoso row renderer, not a component definition.
          itemContent={(_index, file) => (
            <BundleFileSection
              node={props.node}
              viewTabId={props.viewTabId}
              file={file}
              headSha={data.headSha}
              diffViewerPreferences={diffViewerPreferences}
              isActive={props.isActive}
            />
          )}
        />
      </div>
    </BundleDiffFindRegistrationProvider>
  );
}

function diffToolbarView(
  preferences: DiffViewerPreferences,
  collapsedFilePaths: ReadonlyArray<string>,
): DiffTabToolbarView {
  return {
    ...preferences,
    collapsedFilePaths,
  };
}

function buildTileHeader(
  node: GitDiffTileRef,
  branch: string | null,
  headSha: string | null,
  bundleFileCount: number | null,
): {
  readonly primaryTitle: string;
  readonly secondaryLine: ReactNode | null;
  readonly contextLabel: string | null;
} {
  const contextLabel = formatTileWorktreeContext(
    node.diff.runningDir,
    branch,
    headSha,
  );

  if (node.diff.kind === "bundle") {
    const fileCountLabel =
      bundleFileCount === null
        ? null
        : `${bundleFileCount} file${bundleFileCount === 1 ? "" : "s"}`;
    return {
      primaryTitle: gitBundleGroupLabel(node.diff.bundleGroup),
      secondaryLine: fileCountLabel,
      contextLabel,
    };
  }

  const directoryName = getDirname(node.diff.filePath);
  const pathLabel =
    directoryName.length > 0 ? directoryName : "Repository root";

  return {
    primaryTitle: getBasename(node.diff.filePath),
    secondaryLine: (
      <>
        {pathLabel}
        <span className="text-muted-foreground/50"> · </span>
        {gitStageLabel(node.diff.stage)}
      </>
    ),
    contextLabel,
  };
}

function formatTileWorktreeContext(
  runningDir: string,
  branch: string | null,
  headSha: string | null,
): string {
  const repo = getBasename(runningDir);
  if (branch !== null) return `${repo} · ${branch}`;
  if (headSha !== null) return `${repo} · ${headSha.slice(0, 7)}`;
  return `${repo} · detached`;
}

function bundleChangedFileCount(
  node: GitDiffTileRef,
  files: ReadonlyArray<GitChangedFile> | null,
): number | null {
  if (!isGitBundleDiffTileRef(node) || files === null) return null;
  const bundleGroup = node.diff.bundleGroup;
  return files.filter((file) =>
    gitChangedFileBelongsToBundleGroup(file, bundleGroup),
  ).length;
}

// Paths of every file the bundle currently renders; null for single-file tiles
// (which have nothing to collapse). Drives the toolbar's collapse/expand-all.
function bundleFilePaths(
  node: GitDiffTileRef,
  files: ReadonlyArray<GitChangedFile> | null,
): ReadonlyArray<string> | null {
  if (!isGitBundleDiffTileRef(node) || files === null) return null;
  const bundleGroup = node.diff.bundleGroup;
  return files.flatMap((file) =>
    gitChangedFileBelongsToBundleGroup(file, bundleGroup) ? [file.path] : [],
  );
}

function absoluteFilePath(runningDir: string, filePath: string): string {
  return `${runningDir.replace(/\/$/, "")}/${filePath}`;
}
