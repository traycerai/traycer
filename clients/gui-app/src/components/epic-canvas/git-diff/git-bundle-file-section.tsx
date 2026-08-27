import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import type { GitChangedFile } from "@traycer/protocol/host";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { DiffViewerPreferences } from "@/lib/diff/diff-viewer-preferences";
import { useOpenEpicId } from "@/lib/epic-selectors";
import { getBasename } from "@/lib/path/cross-platform-path";
import { workspaceFileRefFromTreePath } from "@/components/epic-canvas/workspace-file/workspace-file-ref";
import { BUNDLE_INLINE_LINE_THRESHOLD } from "@/lib/git/bundle-thresholds";
import { NO_HIGHLIGHT } from "@/lib/git/path-highlight";
import { useBundleDiffFindRegistrationContext } from "@/components/diff/bundle-diff-find-registration-hooks";
import {
  gitImageDiffRevisionKey,
  gitImageDiffRouting,
  gitImageDiffSides,
} from "@/lib/git/git-diff-tile";
import { ImageDiffView } from "@/components/epic-canvas/image-preview/image-diff-view";
import { DiffContentLoadingSkeleton } from "./diff-content-loading-skeleton";
import {
  DiffBundleCollapseChevron,
  DiffBundleFileHeaderPortal,
  DiffBundleFileSectionFrame,
} from "./diff-bundle-file-section";
import { GitChangedFileRow, GitChangedFileStats } from "./git-changed-file-row";
import { FileDiffContent } from "./file-diff-content";
import { GitErrorBlock } from "./git-error-block";
import {
  gitBundleDiffFindFileId,
  gitBundleLoadedPatchCacheKey,
} from "./git-bundle-diff-find";
import { type GitBundleDiffTileRef } from "./git-diff-tile-shared";
import { useEditableGitDiffSurface } from "./git-diff-editing";
import { GitDiffEditStatusContent } from "./git-diff-edit-status";

interface BundleFileSectionProps {
  readonly node: GitBundleDiffTileRef;
  readonly viewTabId: string;
  readonly file: GitChangedFile;
  readonly headSha: string;
  readonly diffViewerPreferences: DiffViewerPreferences;
  readonly isActive: boolean;
}

export function BundleFileSection(props: BundleFileSectionProps): ReactNode {
  const bundleFindRegistration = useBundleDiffFindRegistrationContext();
  const epicId = useOpenEpicId();
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const toggleCollapsed = useEpicCanvasStore(
    (s) => s.toggleGitDiffBundleFileCollapsedInTab,
  );
  const bundleFindFileId = gitBundleDiffFindFileId(props.file);
  const collapsed = props.node.view.collapsedFilePaths.includes(
    props.file.path,
  );
  const totalChangedLines = props.file.insertions + props.file.deletions;
  const isLarge = totalChangedLines > BUNDLE_INLINE_LINE_THRESHOLD;

  const handleOpenFileTile = useCallback(() => {
    const tile = workspaceFileRefFromTreePath(
      props.node.hostId,
      props.node.diff.runningDir,
      props.file.path,
      getBasename(props.file.path),
    );
    if (tile === null) return;
    navigateNested(epicId, props.viewTabId, () =>
      prepareOpenTileInTabFocusTarget(props.viewTabId, tile),
    );
  }, [
    epicId,
    navigateNested,
    prepareOpenTileInTabFocusTarget,
    props.file.path,
    props.node.hostId,
    props.node.diff.runningDir,
    props.viewTabId,
  ]);

  const handleToggleCollapsed = useCallback(() => {
    toggleCollapsed(props.viewTabId, props.node.id, props.file.path);
  }, [props.file.path, props.node.id, props.viewTabId, toggleCollapsed]);
  useEffect(() => {
    bundleFindRegistration.notifySectionMounted(bundleFindFileId);
  }, [bundleFindFileId, bundleFindRegistration]);
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
        showStats={false}
        pathRanges={NO_HIGHLIGHT}
        onClick={handleToggleCollapsed}
        onDoubleClick={undefined}
        ariaExpanded={!collapsed}
        nested={false}
        className={undefined}
      />
    ),
    [collapsed, handleToggleCollapsed, leading, props.file],
  );

  return (
    <DiffBundleFileSectionFrame
      collapsed={collapsed}
      headerRow={headerRow}
      headerStats={<GitChangedFileStats file={props.file} className="flex" />}
      onOpenFileTile={handleOpenFileTile}
      findFilePath={props.file.path}
      bundleFindFileId={bundleFindFileId}
    >
      <BundleFileSectionBody
        node={props.node}
        file={props.file}
        headSha={props.headSha}
        isLarge={isLarge}
        bundleFindFileId={bundleFindFileId}
        onOpenFileTile={handleOpenFileTile}
        diffViewerPreferences={props.diffViewerPreferences}
        isActive={props.isActive}
      />
    </DiffBundleFileSectionFrame>
  );
}

interface BundleFileSectionBodyProps {
  readonly node: GitBundleDiffTileRef;
  readonly file: GitChangedFile;
  readonly headSha: string;
  readonly isLarge: boolean;
  readonly bundleFindFileId: string;
  readonly onOpenFileTile: () => void;
  readonly diffViewerPreferences: DiffViewerPreferences;
  readonly isActive: boolean;
}

function BundleFileSectionBody(props: BundleFileSectionBodyProps): ReactNode {
  const bundleFindRegistration = useBundleDiffFindRegistrationContext();
  // `.svg` is never `isBinary` to git (image-preview decision log, decision
  // #5) but still has no searchable diff text once it routes to the image
  // view, so it shares the same "binary" find-coverage state as a true
  // binary image - see `gitImageDiffRouting` for the routing decision
  // itself, shared with the single-file diff tile.
  const { routeToImageDiff } = gitImageDiffRouting(props.file);
  useEffect(() => {
    if (!props.file.isBinary && !routeToImageDiff) return;
    bundleFindRegistration.registerCoverageState(
      props.bundleFindFileId,
      "binary",
    );
  }, [
    bundleFindRegistration,
    props.bundleFindFileId,
    props.file.isBinary,
    routeToImageDiff,
  ]);

  if (routeToImageDiff) {
    const sides = gitImageDiffSides(props.file);
    const revisionKey = gitImageDiffRevisionKey(props.file, props.headSha);
    // `ImageDiffView` owns its own bounded height in `compact` mode (Codex
    // re-review, #3773048701 / #3773298843) - it needs both sides' decoded
    // dimensions to size itself snugly, which only it has access to (this
    // bundle row never fetches the asset itself), so there is no wrapper
    // height to apply here.
    return (
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
        compact
        onOpenExternally={null}
        openExternallyOpening={false}
      />
    );
  }
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
      bundleFindFileId={props.bundleFindFileId}
      diffViewerPreferences={props.diffViewerPreferences}
      isActive={props.isActive}
    />
  );
}

interface BundleInlineDiffProps {
  readonly node: GitBundleDiffTileRef;
  readonly file: GitChangedFile;
  readonly headSha: string;
  readonly bundleFindFileId: string;
  readonly diffViewerPreferences: DiffViewerPreferences;
  readonly isActive: boolean;
}

function BundleInlineDiff(props: BundleInlineDiffProps): ReactNode {
  const tabHostClient = useTabHostClient();
  const bundleFindRegistration = useBundleDiffFindRegistrationContext();
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
    surfaceId: bundleEditSurfaceId(props.node, props.file),
    isActive: props.isActive,
    queryEnabled: true,
    resumeDetachedDraft: true,
  });
  // A mounted section showing NO content - pending for a key with no data
  // yet (a "Load Full" re-ask), or an error - drops the patch it registered
  // before: past "Load Full" the truncated bytes will never render again, so
  // leaving them indexed would have find match text that is not in the DOM
  // and park navigation on a skeleton or the error block. Retention is for
  // UNMOUNTED rows only (see `unregisterLoadedPatch`).
  useEffect(() => {
    if (!displayedDiffPending) return;
    bundleFindRegistration.unregisterLoadedPatch(props.bundleFindFileId);
  }, [bundleFindRegistration, displayedDiffPending, props.bundleFindFileId]);
  useEffect(() => {
    if (displayedDiffError === null) return;
    bundleFindRegistration.unregisterLoadedPatch(props.bundleFindFileId);
    bundleFindRegistration.registerCoverageState(
      props.bundleFindFileId,
      "failed",
    );
  }, [bundleFindRegistration, displayedDiffError, props.bundleFindFileId]);
  useEffect(() => {
    const diff = displayedDiff;
    if (diff === undefined) return;
    if (diff.isBinary) {
      bundleFindRegistration.registerCoverageState(
        props.bundleFindFileId,
        "binary",
      );
      return;
    }
    bundleFindRegistration.registerLoadedPatch({
      fileId: props.bundleFindFileId,
      patch: diff.patch,
      cacheKey: gitBundleLoadedPatchCacheKey({
        node: props.node,
        file: props.file,
        diff,
      }),
      isTruncated: diff.isTruncated,
    });
  }, [
    bundleFindRegistration,
    displayedDiff,
    props.bundleFindFileId,
    props.file,
    props.node,
  ]);

  if (displayedDiffPending) {
    return (
      <DiffContentLoadingSkeleton
        mode={props.diffViewerPreferences.mode}
        sizing="content"
        density="compact"
        sectionIndex={0}
      />
    );
  }
  if (displayedDiffError !== null) {
    return <GitErrorBlock error={displayedDiffError} />;
  }

  if (displayedDiff === undefined) return null;

  if (displayedDiff.isBinary) {
    return <BundleBinaryPlaceholder file={props.file} />;
  }

  return (
    <FileDiffContent
      diff={displayedDiff}
      mode={props.diffViewerPreferences.mode}
      wordWrap={props.diffViewerPreferences.wordWrap}
      backgrounds={props.diffViewerPreferences.backgrounds}
      lineNumbers={props.diffViewerPreferences.lineNumbers}
      indicatorStyle={props.diffViewerPreferences.indicatorStyle}
      loadDiffFiles={editing.loadDiffFiles}
      sizing="content"
      scrollContainerRef={null}
      onScroll={null}
      onLoadFull={loadFull}
      fileIdentity={{
        findFilePath: props.file.path,
        bundleFindFileId: props.bundleFindFileId,
      }}
      isEmptyFile={editing.canOfferEdit ? props.file.sizeBytes === 0 : false}
      editStatus={
        <DiffBundleFileHeaderPortal>
          <GitDiffEditStatusContent editing={editing} appearance="quiet" />
        </DiffBundleFileHeaderPortal>
      }
      editAdapter={editing.editAdapter}
      editSession={editing.editSession}
    />
  );
}

function bundleEditSurfaceId(
  node: GitBundleDiffTileRef,
  file: GitChangedFile,
): string {
  return `git-diff:${node.instanceId}:bundle:${encodeURIComponent(file.path)}:${file.stage}`;
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
