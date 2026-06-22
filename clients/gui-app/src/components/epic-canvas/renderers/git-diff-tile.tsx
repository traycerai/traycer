import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Virtuoso } from "react-virtuoso";
import {
  DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  type GitChangedFile,
} from "@traycer/protocol/host";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { useEditorOpen } from "@/hooks/editor/use-editor-open-mutation";
import { useEditorOpenFeedback } from "@/hooks/editor/use-editor-open-feedback";
import { useGitGetFileDiffQuery } from "@/hooks/git/use-git-get-file-diff-query";
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
import type {
  GitDiffBundleTilePayload,
  GitDiffFileTilePayload,
  GitDiffTileRef,
} from "@/stores/epics/canvas/types";
import {
  gitBundleGroupLabel,
  gitStageLabel,
  makeGitFileDiffTileForFile,
} from "@/lib/git/git-diff-tile";
import { gitChangedFileBelongsToBundleGroup } from "@/lib/git/panel-file-rendering";
import { getBasename, getDirname } from "@/lib/path/cross-platform-path";
import { BUNDLE_INLINE_LINE_THRESHOLD } from "@/lib/git/bundle-thresholds";
import { DiffBundleLoadingSkeleton } from "@/components/epic-canvas/git-diff/diff-bundle-loading-skeleton";
import { DiffContentLoadingSkeleton } from "@/components/epic-canvas/git-diff/diff-content-loading-skeleton";
import { DiffTabShell } from "@/components/epic-canvas/git-diff/diff-tab-shell";
import {
  DiffTabToolbar,
  type DiffTabToolbarView,
  type DiffTabToolbarViewPatch,
} from "@/components/epic-canvas/git-diff/diff-tab-toolbar";
import {
  DiffBundleCollapseChevron,
  DiffBundleFileSectionFrame,
} from "@/components/epic-canvas/git-diff/diff-bundle-file-section";
import { GitChangedFileRow } from "@/components/epic-canvas/git-diff/git-changed-file-row";
import { NO_HIGHLIGHT } from "@/lib/git/path-highlight";
import { FileDiffContent } from "@/components/epic-canvas/git-diff/file-diff-content";
import { useNativeDivScrollRestoration } from "@/hooks/scroll/use-native-div-scroll-restoration";
import { useBundleDiffScrollRestoration } from "@/hooks/scroll/use-bundle-diff-scroll-restoration";
import { BinaryPlaceholder } from "@/components/epic-canvas/git-diff/binary-placeholder";
import { NoLongerChanged } from "@/components/epic-canvas/git-diff/placeholders/no-longer-changed";
import { SubscriptionErrorState } from "@/components/epic-canvas/git-diff/empty-states/subscription-error-state";
import { NoChangesInWorktree } from "@/components/epic-canvas/git-diff/empty-states/no-changes-in-worktree";
import { GitErrorBlock } from "@/components/epic-canvas/git-diff/git-error-block";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { GitDiffDeadTileBanner } from "./dead-tile-banner";

// Safety cap so a hung host fetch can't wedge the spinning/disabled state.
const GIT_REFRESH_TIMEOUT_MS = 10_000;

interface GitDiffTileProps {
  readonly node: GitDiffTileRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
}

type GitFileDiffTileRef = Omit<GitDiffTileRef, "diff"> & {
  readonly diff: GitDiffFileTilePayload;
};

type GitBundleDiffTileRef = Omit<GitDiffTileRef, "diff"> & {
  readonly diff: GitDiffBundleTilePayload;
};

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
  const subscription = useGitListChangedFilesSubscription({
    hostId: props.node.hostId,
    runningDir: props.node.diff.runningDir,
    ignoreWhitespace,
    enabled: true,
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
        <GitDiffTileToolbar
          node={props.node}
          viewTabId={props.viewTabId}
          onOpenFile={
            props.node.diff.kind === "file" ? props.node.diff.filePath : null
          }
          bundleFilePaths={bundleFilePaths(
            props.node,
            subscription.data?.files ?? null,
          )}
          initialLoading={subscription.isPending}
        />
      }
    >
      {isGitFileDiffTileRef(props.node) ? (
        <GitFileDiffTileBody node={props.node} subscription={subscription} />
      ) : null}
      {isGitBundleDiffTileRef(props.node) ? (
        <GitBundleDiffTileBody
          node={props.node}
          viewTabId={props.viewTabId}
          subscription={subscription}
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
  const editorOpen = useEditorOpen();
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
}

function GitFileDiffTileBody(props: GitFileDiffTileBodyProps): ReactNode {
  const diffViewerPreferences = useSettingsStore(
    (s) => s.diffViewerPreferences,
  );
  if (props.subscription.error !== null) {
    return <SubscriptionErrorState event={props.subscription.error} />;
  }
  if (props.subscription.isPending) {
    return (
      <DiffContentLoadingSkeleton
        mode={diffViewerPreferences.mode}
        sizing="fill"
        density="full"
        sectionIndex={0}
      />
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
      <NoLongerChanged
        filePath={props.node.diff.filePath}
        stage={props.node.diff.stage}
      />
    );
  }

  return (
    <GitFileDiffPanel
      node={props.node}
      file={file}
      headSha={props.subscription.data?.headSha ?? ""}
      diffViewerPreferences={diffViewerPreferences}
    />
  );
}

interface GitFileDiffPanelProps {
  readonly node: GitFileDiffTileRef;
  readonly file: GitChangedFile;
  readonly headSha: string;
  readonly diffViewerPreferences: DiffViewerPreferences;
}

function GitFileDiffPanel(props: GitFileDiffPanelProps): ReactNode {
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const editorOpen = useEditorOpen();
  const {
    active: openExternallyFeedbackActive,
    trigger: triggerOpenExternallyFeedback,
  } = useEditorOpenFeedback();
  const openExternallyOpening =
    editorOpen.isPending || openExternallyFeedbackActive;
  const diffIdentity = fileDiffLoadFullIdentity({
    runningDir: props.node.diff.runningDir,
    filePath: props.file.path,
    previousPath: props.file.previousPath,
    stage: props.file.stage,
    headSha: props.headSha,
    stagedOid: props.file.stagedOid,
    worktreeOid: props.file.worktreeOid,
    ignoreWhitespace: props.diffViewerPreferences.ignoreWhitespace,
  });
  const [fullDiffIdentity, setFullDiffIdentity] = useState<string | null>(null);
  const byteBudget =
    fullDiffIdentity === diffIdentity
      ? null
      : DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET;

  const diffQuery = useGitGetFileDiffQuery({
    hostId: props.node.hostId,
    runningDir: props.node.diff.runningDir,
    filePath: props.file.path,
    previousPath: props.file.previousPath,
    stage: props.file.stage,
    headSha: props.headSha,
    stagedOid: props.file.stagedOid,
    worktreeOid: props.file.worktreeOid,
    ignoreWhitespace: props.diffViewerPreferences.ignoreWhitespace,
    byteBudget,
    enabled: !props.file.isBinary,
  });

  // Preserve scroll (both axes) across epic switches and remount, once the diff
  // has loaded for a non-binary file.
  const { scrollContainerRef, onScroll } = useNativeDivScrollRestoration(
    props.node.instanceId,
    !props.file.isBinary &&
      diffQuery.data !== undefined &&
      diffQuery.error === null,
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

  if (props.file.isBinary) {
    return (
      <BinaryPlaceholder
        fileName={props.file.path}
        sizeBytes={props.file.sizeBytes}
        onOpenExternally={handleOpenExternally}
        openExternallyOpening={openExternallyOpening}
      />
    );
  }

  if (diffQuery.isPending) {
    return (
      <DiffContentLoadingSkeleton
        mode={props.diffViewerPreferences.mode}
        sizing="fill"
        density="full"
        sectionIndex={0}
      />
    );
  }
  if (diffQuery.error !== null)
    return <GitErrorBlock error={diffQuery.error} />;

  if (diffQuery.data.isBinary) {
    return (
      <BinaryPlaceholder
        fileName={props.file.path}
        sizeBytes={props.file.sizeBytes}
        onOpenExternally={handleOpenExternally}
        openExternallyOpening={openExternallyOpening}
      />
    );
  }

  return (
    <FileDiffContent
      diff={diffQuery.data}
      mode={props.diffViewerPreferences.mode}
      wordWrap={props.diffViewerPreferences.wordWrap}
      backgrounds={props.diffViewerPreferences.backgrounds}
      lineNumbers={props.diffViewerPreferences.lineNumbers}
      indicatorStyle={props.diffViewerPreferences.indicatorStyle}
      sizing="fill"
      scrollContainerRef={scrollContainerRef}
      onScroll={onScroll}
      onLoadFull={() => {
        setFullDiffIdentity(diffIdentity);
      }}
    />
  );
}

interface GitBundleDiffTileBodyProps {
  readonly node: GitBundleDiffTileRef;
  readonly viewTabId: string;
  readonly subscription: GitListChangedFilesSubscriptionResult;
}

function GitBundleDiffTileBody(props: GitBundleDiffTileBodyProps): ReactNode {
  const diffViewerPreferences = useSettingsStore(
    (s) => s.diffViewerPreferences,
  );
  // Derive content before any early return so the restoration hooks run
  // unconditionally (React rules of hooks).
  const data = props.subscription.isPending ? null : props.subscription.data;
  const files =
    data === null
      ? []
      : data.files.filter((file) =>
          gitChangedFileBelongsToBundleGroup(file, props.node.diff.bundleGroup),
        );
  const { virtuosoRef, restoreStateFrom, isScrolling } =
    useBundleDiffScrollRestoration(props.node.instanceId, files.length > 0);

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
        />
      )}
    />
  );
}

interface BundleFileSectionProps {
  readonly node: GitBundleDiffTileRef;
  readonly viewTabId: string;
  readonly file: GitChangedFile;
  readonly headSha: string;
  readonly diffViewerPreferences: DiffViewerPreferences;
}

function BundleFileSection(props: BundleFileSectionProps): ReactNode {
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);
  const toggleCollapsed = useEpicCanvasStore(
    (s) => s.toggleGitDiffBundleFileCollapsedInTab,
  );
  const collapsed = props.node.view.collapsedFilePaths.includes(
    props.file.path,
  );
  const totalChangedLines = props.file.insertions + props.file.deletions;
  const isLarge = totalChangedLines > BUNDLE_INLINE_LINE_THRESHOLD;

  const handleOpenFileTile = useCallback(() => {
    openTileInTab(
      props.viewTabId,
      makeGitFileDiffTileForFile({
        hostId: props.node.hostId,
        runningDir: props.node.diff.runningDir,
        file: props.file,
      }),
    );
  }, [
    openTileInTab,
    props.file,
    props.node.hostId,
    props.node.diff.runningDir,
    props.viewTabId,
  ]);

  const handleToggleCollapsed = useCallback(() => {
    toggleCollapsed(props.viewTabId, props.node.id, props.file.path);
  }, [props.file.path, props.node.id, props.viewTabId, toggleCollapsed]);
  const leading = useMemo(
    () => <DiffBundleCollapseChevron collapsed={collapsed} />,
    [collapsed],
  );
  const headerRow = useMemo(
    () => (
      <GitChangedFileRow
        file={props.file}
        density="tile"
        active={false}
        leading={leading}
        trailing={null}
        pathRanges={NO_HIGHLIGHT}
        onClick={handleToggleCollapsed}
        onDoubleClick={undefined}
        ariaExpanded={!collapsed}
        className={undefined}
      />
    ),
    [collapsed, handleToggleCollapsed, leading, props.file],
  );

  return (
    <DiffBundleFileSectionFrame
      collapsed={collapsed}
      headerRow={headerRow}
      onOpenFileTile={handleOpenFileTile}
    >
      <BundleFileSectionBody
        node={props.node}
        file={props.file}
        headSha={props.headSha}
        isLarge={isLarge}
        onOpenFileTile={handleOpenFileTile}
        diffViewerPreferences={props.diffViewerPreferences}
      />
    </DiffBundleFileSectionFrame>
  );
}

interface BundleFileSectionBodyProps {
  readonly node: GitBundleDiffTileRef;
  readonly file: GitChangedFile;
  readonly headSha: string;
  readonly isLarge: boolean;
  readonly onOpenFileTile: () => void;
  readonly diffViewerPreferences: DiffViewerPreferences;
}

function BundleFileSectionBody(props: BundleFileSectionBodyProps): ReactNode {
  if (props.file.isBinary) {
    return <BundleBinaryPlaceholder file={props.file} />;
  }
  if (props.isLarge) {
    return (
      <div className="p-4">
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/30 p-3">
          <div className="min-w-0">
            <div className="text-ui-sm font-medium">Large diff</div>
            <StartTruncatedText className="block min-w-0 text-ui-xs text-muted-foreground">
              {props.file.path}
            </StartTruncatedText>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onOpenFileTile}
          >
            Open file
          </Button>
        </div>
      </div>
    );
  }
  return (
    <BundleInlineDiff
      node={props.node}
      file={props.file}
      headSha={props.headSha}
      diffViewerPreferences={props.diffViewerPreferences}
    />
  );
}

interface BundleInlineDiffProps {
  readonly node: GitBundleDiffTileRef;
  readonly file: GitChangedFile;
  readonly headSha: string;
  readonly diffViewerPreferences: DiffViewerPreferences;
}

function BundleInlineDiff(props: BundleInlineDiffProps): ReactNode {
  const diffIdentity = fileDiffLoadFullIdentity({
    runningDir: props.node.diff.runningDir,
    filePath: props.file.path,
    previousPath: props.file.previousPath,
    stage: props.file.stage,
    headSha: props.headSha,
    stagedOid: props.file.stagedOid,
    worktreeOid: props.file.worktreeOid,
    ignoreWhitespace: props.diffViewerPreferences.ignoreWhitespace,
  });
  const [fullDiffIdentity, setFullDiffIdentity] = useState<string | null>(null);
  const byteBudget =
    fullDiffIdentity === diffIdentity
      ? null
      : DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET;

  const diffQuery = useGitGetFileDiffQuery({
    hostId: props.node.hostId,
    runningDir: props.node.diff.runningDir,
    filePath: props.file.path,
    previousPath: props.file.previousPath,
    stage: props.file.stage,
    headSha: props.headSha,
    stagedOid: props.file.stagedOid,
    worktreeOid: props.file.worktreeOid,
    ignoreWhitespace: props.diffViewerPreferences.ignoreWhitespace,
    byteBudget,
    enabled: true,
  });

  if (diffQuery.isPending) {
    return (
      <DiffContentLoadingSkeleton
        mode={props.diffViewerPreferences.mode}
        sizing="content"
        density="compact"
        sectionIndex={0}
      />
    );
  }
  if (diffQuery.error !== null)
    return <GitErrorBlock error={diffQuery.error} />;

  if (diffQuery.data.isBinary) {
    return <BundleBinaryPlaceholder file={props.file} />;
  }

  return (
    <FileDiffContent
      diff={diffQuery.data}
      mode={props.diffViewerPreferences.mode}
      wordWrap={props.diffViewerPreferences.wordWrap}
      backgrounds={props.diffViewerPreferences.backgrounds}
      lineNumbers={props.diffViewerPreferences.lineNumbers}
      indicatorStyle={props.diffViewerPreferences.indicatorStyle}
      sizing="content"
      scrollContainerRef={null}
      onScroll={null}
      onLoadFull={() => {
        setFullDiffIdentity(diffIdentity);
      }}
    />
  );
}

function BundleBinaryPlaceholder(props: {
  readonly file: GitChangedFile;
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3 p-4 text-ui-sm text-muted-foreground">
      <span>Binary file</span>
      <Badge variant="outline">
        {Math.round(props.file.sizeBytes / 1024)} KB
      </Badge>
    </div>
  );
}

function fileDiffLoadFullIdentity(args: {
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  readonly stage: GitChangedFile["stage"];
  readonly headSha: string;
  readonly stagedOid: string | null;
  readonly worktreeOid: string | null;
  readonly ignoreWhitespace: boolean;
}): string {
  return JSON.stringify([
    args.runningDir,
    args.filePath,
    args.previousPath,
    args.stage,
    args.headSha,
    args.stagedOid,
    args.worktreeOid,
    args.ignoreWhitespace,
  ]);
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
