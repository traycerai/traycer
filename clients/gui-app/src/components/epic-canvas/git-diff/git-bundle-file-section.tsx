import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  type GitChangedFile,
} from "@traycer/protocol/host";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { useGitGetFileDiffQuery } from "@/hooks/git/use-git-get-file-diff-query";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { DiffViewerPreferences } from "@/lib/diff/diff-viewer-preferences";
import { makeGitFileDiffTileForFile } from "@/lib/git/git-diff-tile";
import { BUNDLE_INLINE_LINE_THRESHOLD } from "@/lib/git/bundle-thresholds";
import { NO_HIGHLIGHT } from "@/lib/git/path-highlight";
import { useBundleDiffFindRegistrationContext } from "@/components/diff/bundle-diff-find-registration-hooks";
import { DiffContentLoadingSkeleton } from "./diff-content-loading-skeleton";
import {
  DiffBundleCollapseChevron,
  DiffBundleFileSectionFrame,
} from "./diff-bundle-file-section";
import { GitChangedFileRow } from "./git-changed-file-row";
import { FileDiffContent } from "./file-diff-content";
import { GitErrorBlock } from "./git-error-block";
import {
  gitBundleDiffFindFileId,
  gitBundleLoadedPatchCacheKey,
} from "./git-bundle-diff-find";
import {
  fileDiffLoadFullIdentity,
  type GitBundleDiffTileRef,
} from "./git-diff-tile-shared";

interface BundleFileSectionProps {
  readonly node: GitBundleDiffTileRef;
  readonly viewTabId: string;
  readonly file: GitChangedFile;
  readonly headSha: string;
  readonly diffViewerPreferences: DiffViewerPreferences;
}

export function BundleFileSection(props: BundleFileSectionProps): ReactNode {
  const bundleFindRegistration = useBundleDiffFindRegistrationContext();
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);
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
}

function BundleFileSectionBody(props: BundleFileSectionBodyProps): ReactNode {
  const bundleFindRegistration = useBundleDiffFindRegistrationContext();
  useEffect(() => {
    if (!props.file.isBinary) return;
    bundleFindRegistration.registerCoverageState(
      props.bundleFindFileId,
      "binary",
    );
  }, [bundleFindRegistration, props.bundleFindFileId, props.file.isBinary]);

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
    />
  );
}

interface BundleInlineDiffProps {
  readonly node: GitBundleDiffTileRef;
  readonly file: GitChangedFile;
  readonly headSha: string;
  readonly bundleFindFileId: string;
  readonly diffViewerPreferences: DiffViewerPreferences;
}

function BundleInlineDiff(props: BundleInlineDiffProps): ReactNode {
  const bundleFindRegistration = useBundleDiffFindRegistrationContext();
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
  useEffect(() => {
    if (diffQuery.error === null) return;
    bundleFindRegistration.registerCoverageState(
      props.bundleFindFileId,
      "failed",
    );
  }, [bundleFindRegistration, diffQuery.error, props.bundleFindFileId]);
  useEffect(() => {
    const diff = diffQuery.data;
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
    diffQuery.data,
    props.bundleFindFileId,
    props.file,
    props.node,
  ]);

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
