import { useCallback, useMemo, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { PrLocalDiffSummaryFile } from "@traycer/protocol/host/pr-schemas";
import { getBasename, getDirname } from "@/lib/path/cross-platform-path";
import { isPrLocalDiffLargeFile } from "@/lib/pr/pr-local-diff-large-file";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { TILE_KIND_PR_DIFF } from "@/stores/epics/canvas/tile-kinds";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";
import type {
  BundleDiffFindCoverageState,
  BundleDiffFindFileInput,
} from "@/stores/tile-find";
import {
  useBundleDiffFindNavigation,
  useRegisterBundleDiffTileFindAdapter,
  type BundleDiffFindFileNavigationInput,
  type BundleDiffFindRegistrationContextValue,
} from "@/components/diff/bundle-diff-find-registration-hooks";

/**
 * How a PR diff tile's file sections get their patch bytes, as far as the
 * find session cares: `split` sections fetch on mount, `monolith` sections
 * read from a whole-PR response that was fetched once (old-host fallback).
 */
export type PrBundleDiffFindPatchMode = "split" | "monolith";

// Stable identity for a PR range-diff file within the find index. Shared by
// the session (coverage / loaded-patch registration) and the section renderer
// (`data-bundle-diff-file-id`, `notifySectionMounted`) so reveal targets the
// same file id the index was built with. Keyed on `path` alone because that is
// the list's row identity too (`computeItemKey`): a range diff names each
// destination path once, and a rename's `previousPath` is a property of the
// row, not a second row.
export function prBundleDiffFindFileId(file: PrLocalDiffSummaryFile): string {
  return `pr:${file.path}`;
}

/**
 * Cache key for a loaded patch registered against the PR find session:
 * OID-addressed through `comparisonKey` (the summary's `mergeBase..head`, or
 * the monolith's), plus everything else that changes the bytes - the
 * whitespace mode, the path pair, and whether the per-file byte budget cut
 * the patch. Two different patches must never share a key, since the index
 * treats an unchanged key as an unchanged patch. JSON-encoded so a path can
 * never collide with a neighbouring field.
 */
export function prBundleLoadedPatchCacheKey(args: {
  readonly comparisonKey: string;
  readonly file: PrLocalDiffSummaryFile;
  readonly ignoreWhitespace: boolean;
  readonly isTruncated: boolean;
}): string {
  return JSON.stringify([
    "pr-local-diff",
    args.comparisonKey,
    args.ignoreWhitespace,
    args.file.previousPath,
    args.file.path,
    args.isTruncated ? "truncated" : "full",
  ]);
}

/**
 * The coverage a file starts at before its section ever mounts. Terminal
 * states first - a binary file, or a monolith file the whole-PR byte budget
 * never reached, cannot become searchable by expanding or scrolling - then the
 * two states a reveal CAN clear (expand, then mount-and-fetch), then the
 * guarded one: a large file's content stays unsearched until its "Load diff"
 * is pressed, exactly as the Git bundle keeps its large rows out of the index
 * (see `gitBundleDiffFindCoverageState`).
 */
function prBundleDiffFindCoverageState(args: {
  readonly file: PrLocalDiffSummaryFile;
  readonly collapsed: boolean;
  /** Monolith mode: the patch the response carried, `null` past the budget. */
  readonly monolithPatch: string | null | undefined;
}): BundleDiffFindCoverageState {
  if (args.file.isBinary) return "binary";
  if (args.monolithPatch === null) return "truncated";
  if (args.collapsed) return "collapsed";
  if (isPrLocalDiffLargeFile(args.file)) return "large";
  return "unloaded";
}

function prBundleDiffFindFileInput(args: {
  readonly file: PrLocalDiffSummaryFile;
  readonly collapsed: boolean;
  readonly monolithPatch: string | null | undefined;
}): BundleDiffFindFileInput {
  const fileId = prBundleDiffFindFileId(args.file);
  const directory = getDirname(args.file.path);
  const previousPath = args.file.previousPath ?? "";
  return {
    id: fileId,
    filePath: args.file.path,
    coverageState: prBundleDiffFindCoverageState(args),
    metadataUnits: [
      {
        id: `pr-diff-file:${fileId}`,
        filePath: args.file.path,
        scopeId: fileId,
        text: [
          getBasename(args.file.path),
          directory.length > 0 ? directory : "Repository root",
          args.file.path,
          previousPath,
          args.file.status,
          args.file.insertions === null
            ? ""
            : `${args.file.insertions} additions`,
          args.file.deletions === null
            ? ""
            : `${args.file.deletions} deletions`,
          args.file.isBinary ? "binary" : "",
        ]
          .filter((part) => part.length > 0)
          .join(" "),
      },
    ],
  };
}

/**
 * The find session's content identity: a new comparison (the checkout moved,
 * a whitespace flip), a different data plumbing (split ↔ monolith after a
 * mid-session capability change) or a different file list opens a fresh
 * session, dropping the loaded patches and coverage of the old one - they
 * described bytes the tile no longer shows.
 */
function prBundleDiffFindContentIdentity(args: {
  readonly comparisonKey: string;
  readonly patchMode: PrBundleDiffFindPatchMode;
  readonly ignoreWhitespace: boolean;
  readonly files: ReadonlyArray<PrLocalDiffSummaryFile>;
}): string {
  return JSON.stringify([
    "pr-diff",
    args.patchMode,
    args.comparisonKey,
    args.ignoreWhitespace,
    args.files.map((file) => [
      file.path,
      file.previousPath,
      file.status,
      file.isBinary,
      file.insertions,
      file.deletions,
    ]),
  ]);
}

/**
 * Owns the PR diff tile's bundle find session: file-input construction,
 * content identity, collapsed-file expansion, navigation, and adapter
 * registration - `useGitBundleDiffFind` for the PR range diff. The renderer
 * stays responsible only for the file list, scroll restoration, and composing
 * the result into the virtualized tree; sections register their coverage and
 * loaded patches through the returned context value.
 *
 * Both patch modes share this one session, so what "searchable" means is the
 * same in split and fallback mode: file metadata for every file up front,
 * plus every patch a mounted section has rendered - retained after the row
 * virtualizes away. Reveal scrolls the list to the target row (mounting it,
 * which in split mode issues its fetch) and expands a collapsed one; the
 * coverage message names the files that were not searched.
 */
export function usePrBundleDiffFind(args: {
  readonly node: PrDiffTileRef;
  readonly viewTabId: string;
  readonly files: ReadonlyArray<PrLocalDiffSummaryFile>;
  readonly comparisonKey: string;
  readonly patchMode: PrBundleDiffFindPatchMode;
  /** Monolith mode's per-path patches (`null` = past the budget), else null. */
  readonly monolithPatches: ReadonlyMap<string, string | null> | null;
  readonly ignoreWhitespace: boolean;
  readonly virtuosoRef: RefObject<VirtuosoHandle | null>;
}): {
  readonly registration: BundleDiffFindRegistrationContextValue;
  readonly setRootElement: (element: HTMLDivElement | null) => void;
} {
  const updateView = useEpicCanvasStore((s) => s.updatePrDiffTileViewInTab);
  const {
    comparisonKey,
    files,
    ignoreWhitespace,
    monolithPatches,
    node,
    patchMode,
    viewTabId,
    virtuosoRef,
  } = args;
  const nodeId = node.id;
  const nodeView = node.view;
  const collapsedFilePaths = nodeView.collapsedFilePaths;

  const bundleFindFiles = useMemo(
    () =>
      files.map((file) =>
        prBundleDiffFindFileInput({
          file,
          collapsed: collapsedFilePaths.includes(file.path),
          monolithPatch: monolithPatches?.get(file.path),
        }),
      ),
    [collapsedFilePaths, files, monolithPatches],
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
      prBundleDiffFindContentIdentity({
        comparisonKey,
        patchMode,
        ignoreWhitespace,
        files,
      }),
    [comparisonKey, files, ignoreWhitespace, patchMode],
  );
  const registration = useRegisterBundleDiffTileFindAdapter({
    tileInstanceId: node.instanceId,
    tileKind: TILE_KIND_PR_DIFF,
    files: bundleFindFiles,
    contentIdentity: bundleFindContentIdentity,
    renderer: bundleFindNavigation,
    sourceOverride: null,
  });
  const setRootElement = useCallback(
    (element: HTMLDivElement | null): void => {
      bundleFindNavigation.setRootElement(element);
    },
    [bundleFindNavigation],
  );

  return { registration, setRootElement };
}
