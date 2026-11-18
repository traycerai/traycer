import { useCallback, useMemo, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type {
  GitChangedFile,
  GitGetFileDiffResponse,
} from "@traycer/protocol/host";
import { getBasename, getDirname } from "@/lib/path/cross-platform-path";
import { gitStageLabel } from "@/lib/git/git-diff-tile";
import { BUNDLE_INLINE_LINE_THRESHOLD } from "@/lib/git/bundle-thresholds";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { GitDiffBundleTilePayload } from "@/stores/epics/canvas/types";
import {
  createLoadingDiffTileFindSource,
  createMissingDiffTileFindSource,
  type BundleDiffFindCoverageState,
  type BundleDiffFindFileInput,
  type DiffTileFindSource,
} from "@/stores/tile-find";
import {
  useBundleDiffFindNavigation,
  useRegisterBundleDiffTileFindAdapter,
  type BundleDiffFindFileNavigationInput,
  type BundleDiffFindRegistrationContextValue,
} from "@/components/diff/bundle-diff-find-registration-hooks";
import {
  GIT_BUNDLE_DIFF_LOADING_FIND_MESSAGE,
  GIT_DIFF_ERROR_FIND_MESSAGE,
  type GitBundleDiffTileRef,
} from "./git-diff-tile-shared";

// Stable identity for a bundle file within the find index. Used by both the
// find machinery and the section renderer so coverage/patch registration and
// reveal target the same file id.
export function gitBundleDiffFindFileId(file: GitChangedFile): string {
  return `git:${file.stage}:${file.path}`;
}

// Cache key for a loaded inline patch registered against the bundle find
// session; identifies the exact diff bytes so the find index can keep an
// already-loaded patch searchable after its virtualized row unmounts.
export function gitBundleLoadedPatchCacheKey(args: {
  readonly node: GitBundleDiffTileRef;
  readonly file: GitChangedFile;
  readonly diff: GitGetFileDiffResponse;
}): string {
  return [
    "git-bundle",
    args.node.instanceId,
    args.node.diff.runningDir,
    args.file.path,
    args.file.stage,
    args.diff.stagedOid ?? "none",
    args.diff.worktreeOid ?? "none",
    args.diff.isTruncated ? "truncated" : "full",
  ].join(":");
}

function gitBundleDiffFindCoverageState(args: {
  readonly file: GitChangedFile;
  readonly collapsed: boolean;
}): BundleDiffFindCoverageState {
  if (args.file.isBinary) return "binary";
  if (args.collapsed) return "collapsed";
  if (args.file.insertions + args.file.deletions > BUNDLE_INLINE_LINE_THRESHOLD)
    return "large";
  return "unloaded";
}

function gitBundleDiffFindFileInput(args: {
  readonly runningDir: string;
  readonly file: GitChangedFile;
  readonly collapsed: boolean;
}): BundleDiffFindFileInput {
  const fileId = gitBundleDiffFindFileId(args.file);
  const directory = getDirname(args.file.path);
  const previousPath = args.file.previousPath ?? "";
  return {
    id: fileId,
    filePath: args.file.path,
    coverageState: gitBundleDiffFindCoverageState({
      file: args.file,
      collapsed: args.collapsed,
    }),
    metadataUnits: [
      {
        id: `git-bundle-file:${fileId}`,
        filePath: args.file.path,
        scopeId: fileId,
        text: [
          getBasename(args.file.path),
          directory.length > 0 ? directory : "Repository root",
          args.file.path,
          previousPath,
          args.file.status,
          gitStageLabel(args.file.stage),
          `${args.file.insertions} additions`,
          `${args.file.deletions} deletions`,
          args.file.isBinary ? "binary" : "",
          getBasename(args.runningDir),
        ]
          .filter((part) => part.length > 0)
          .join(" "),
      },
    ],
  };
}

function gitBundleDiffFindContentIdentity(args: {
  readonly runningDir: string;
  readonly bundleGroup: GitDiffBundleTilePayload["bundleGroup"];
  readonly files: ReadonlyArray<GitChangedFile>;
  readonly headSha: string | null;
  readonly ignoreWhitespace: boolean;
}): string {
  return JSON.stringify([
    "git-bundle",
    args.runningDir,
    args.bundleGroup,
    args.headSha,
    args.ignoreWhitespace,
    args.files.map((file) => [
      file.path,
      file.previousPath,
      file.stage,
      file.status,
      file.stagedOid,
      file.worktreeOid,
      file.isBinary,
      file.insertions,
      file.deletions,
      file.sizeBytes,
    ]),
  ]);
}

// Owns the bundle find session: file-input construction, content identity,
// collapsed-file expansion, navigation, and adapter registration. The renderer
// stays responsible only for the changed-file list, scroll restoration, and
// composing the result into the virtualized tree.
export function useGitBundleDiffFind(args: {
  readonly node: GitBundleDiffTileRef;
  readonly viewTabId: string;
  readonly files: ReadonlyArray<GitChangedFile>;
  readonly headSha: string | null;
  readonly ignoreWhitespace: boolean;
  readonly hasSubscriptionError: boolean;
  readonly subscriptionPending: boolean;
  readonly virtuosoRef: RefObject<VirtuosoHandle | null>;
}): {
  readonly registration: BundleDiffFindRegistrationContextValue;
  readonly setRootElement: (element: HTMLDivElement | null) => void;
} {
  const updateView = useEpicCanvasStore((s) => s.updateGitDiffTileViewInTab);
  const { node, viewTabId, files, headSha, ignoreWhitespace, virtuosoRef } =
    args;
  const nodeId = node.id;
  const nodeView = node.view;
  const collapsedFilePaths = nodeView.collapsedFilePaths;
  const runningDir = node.diff.runningDir;
  const bundleGroup = node.diff.bundleGroup;

  const bundleFindFiles = useMemo(
    () =>
      files.map((file) =>
        gitBundleDiffFindFileInput({
          runningDir,
          file,
          collapsed: collapsedFilePaths.includes(file.path),
        }),
      ),
    [collapsedFilePaths, files, runningDir],
  );
  const bundleFindNavigationFiles = useMemo(
    () =>
      bundleFindFiles.map((file): BundleDiffFindFileNavigationInput => ({
        id: file.id,
        filePath: file.filePath,
      })),
    [bundleFindFiles],
  );
  const collapsedBundleFindFileIds = useMemo(
    () =>
      new Set(
        bundleFindFiles.flatMap((file) =>
          collapsedFilePaths.includes(file.filePath) ? [file.id] : [],
        ),
      ),
    [bundleFindFiles, collapsedFilePaths],
  );
  const expandBundleFindFile = useCallback(
    (fileId: string): void => {
      const file = bundleFindFiles.find((candidate) => candidate.id === fileId);
      if (file === undefined) return;
      if (!collapsedFilePaths.includes(file.filePath)) return;
      updateView(viewTabId, nodeId, {
        ...nodeView,
        collapsedFilePaths: collapsedFilePaths.filter(
          (filePath) => filePath !== file.filePath,
        ),
      });
    },
    [
      bundleFindFiles,
      collapsedFilePaths,
      nodeId,
      nodeView,
      updateView,
      viewTabId,
    ],
  );
  const bundleFindNavigation = useBundleDiffFindNavigation({
    files: bundleFindNavigationFiles,
    collapsedFileIds: collapsedBundleFindFileIds,
    expandFile: expandBundleFindFile,
    virtuosoRef,
  });
  const bundleFindContentIdentity = useMemo(
    () =>
      gitBundleDiffFindContentIdentity({
        runningDir,
        bundleGroup,
        files,
        headSha,
        ignoreWhitespace,
      }),
    [bundleGroup, files, headSha, ignoreWhitespace, runningDir],
  );
  const bundleFindSourceOverride = useMemo((): DiffTileFindSource | null => {
    if (args.hasSubscriptionError) {
      return createMissingDiffTileFindSource({
        coverageMessage: GIT_DIFF_ERROR_FIND_MESSAGE,
      });
    }
    if (args.subscriptionPending) {
      return createLoadingDiffTileFindSource({
        coverageMessage: GIT_BUNDLE_DIFF_LOADING_FIND_MESSAGE,
      });
    }
    return null;
  }, [args.hasSubscriptionError, args.subscriptionPending]);
  const registration = useRegisterBundleDiffTileFindAdapter({
    tileInstanceId: node.instanceId,
    tileKind: "git-diff",
    files: bundleFindFiles,
    contentIdentity: bundleFindContentIdentity,
    renderer: bundleFindNavigation,
    sourceOverride: bundleFindSourceOverride,
  });
  const setRootElement = useCallback(
    (element: HTMLDivElement | null): void => {
      bundleFindNavigation.setRootElement(element);
    },
    [bundleFindNavigation],
  );

  return { registration, setRootElement };
}
