import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { Virtuoso } from "react-virtuoso";
import type {
  SnapshotCumulativeBundleDiffTilePayload,
  SnapshotDiffTileRef,
} from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { DiffViewerPreferences } from "@/lib/diff/diff-viewer-preferences";
import { makeSnapshotCumulativeDiffTile } from "@/lib/chat/snapshot-diff-tile";
import { FILE_EDIT_REASON_COPY } from "@/lib/chat/file-edit-reason-copy";
import { buildSnapshotUnifiedPatch } from "@/lib/diff/snapshot-diff-patch";
import type { SnapshotBundleSectionEntry } from "@/lib/chat/snapshot-bundle-section-entries";
import type { DiffFindMetadataUnitInput } from "@/lib/diff/diff-find";
import { diffLineCountsFromContents } from "@/lib/file-change-diff-hunks";
import {
  DiffContentFrame,
  DiffContentPrimitive,
} from "@/components/diff/diff-content-primitive";
import { BundleDiffFindRegistrationProvider } from "@/components/diff/bundle-diff-find-registration";
import {
  useBundleDiffFindNavigation,
  useBundleDiffFindRegistrationContext,
  useRegisterBundleDiffTileFindAdapter,
  type BundleDiffFindFileNavigationInput,
} from "@/components/diff/bundle-diff-find-registration-hooks";
import { useBundleDiffScrollRestoration } from "@/hooks/scroll/use-bundle-diff-scroll-restoration";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  DiffBundleCollapseChevron,
  DiffBundleFileSectionFrame,
} from "@/components/epic-canvas/git-diff/diff-bundle-file-section";
import { FileChangeHeader } from "@/components/chat/segments/file-change-segment";
import { useOpenEpicId } from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";
import { getBasename, getDirname } from "@/lib/path/cross-platform-path";
import type { BundleDiffFindFileInput } from "@/stores/tile-find";

export type SnapshotCumulativeBundleDiffTileRef = Omit<
  SnapshotDiffTileRef,
  "diff"
> & {
  readonly diff: SnapshotCumulativeBundleDiffTilePayload;
};

export function SnapshotBundleDiffTileContent(props: {
  readonly node: SnapshotCumulativeBundleDiffTileRef;
  readonly viewTabId: string;
  readonly entries: ReadonlyArray<SnapshotBundleSectionEntry>;
}): ReactNode {
  const diffViewerPreferences = useSettingsStore(
    (s) => s.diffViewerPreferences,
  );
  const updateView = useEpicCanvasStore(
    (s) => s.updateSnapshotDiffTileViewInTab,
  );
  const nodeId = props.node.id;
  const nodeView = props.node.view;
  const collapsedFilePaths = nodeView.collapsedFilePaths;
  const ignoreWhitespace = diffViewerPreferences.ignoreWhitespace;
  const { virtuosoRef, restoreStateFrom, isScrolling } =
    useBundleDiffScrollRestoration(
      props.node.instanceId,
      props.entries.length > 0,
    );
  const bundleFindFiles = useMemo(
    () =>
      props.entries.map((entry) =>
        snapshotBundleDiffFindFileInput({
          entry,
          collapsed: collapsedFilePaths.includes(entry.filePath),
        }),
      ),
    [collapsedFilePaths, props.entries],
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
      updateView(props.viewTabId, nodeId, {
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
      props.viewTabId,
      updateView,
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
      snapshotBundleDiffFindContentIdentity({
        entries: props.entries,
        ignoreWhitespace,
      }),
    [ignoreWhitespace, props.entries],
  );
  const bundleFindRegistration = useRegisterBundleDiffTileFindAdapter({
    tileInstanceId: props.node.instanceId,
    tileKind: "snapshot-diff",
    files: bundleFindFiles,
    contentIdentity: bundleFindContentIdentity,
    renderer: bundleFindNavigation,
    sourceOverride: null,
  });
  const setBundleFindRootElement = useCallback(
    (element: HTMLDivElement | null): void => {
      bundleFindNavigation.setRootElement(element);
    },
    [bundleFindNavigation],
  );

  return (
    <BundleDiffFindRegistrationProvider value={bundleFindRegistration}>
      <div ref={setBundleFindRootElement} className="h-full min-h-0">
        <Virtuoso
          ref={virtuosoRef}
          restoreStateFrom={restoreStateFrom}
          isScrolling={isScrolling}
          data={props.entries}
          className="h-full min-h-0"
          overscan={6}
          computeItemKey={(_index, entry) => entry.filePath}
          // eslint-disable-next-line react/no-unstable-nested-components -- Virtuoso row renderer, not a component definition.
          itemContent={(_index, entry) => (
            <SnapshotBundleFileSection
              node={props.node}
              viewTabId={props.viewTabId}
              entry={entry}
            />
          )}
        />
      </div>
    </BundleDiffFindRegistrationProvider>
  );
}

function SnapshotBundleFileSection(props: {
  readonly node: SnapshotCumulativeBundleDiffTileRef;
  readonly viewTabId: string;
  readonly entry: SnapshotBundleSectionEntry;
}): ReactNode {
  const bundleFindRegistration = useBundleDiffFindRegistrationContext();
  const diffViewerPreferences = useSettingsStore(
    (s) => s.diffViewerPreferences,
  );
  const epicId = useOpenEpicId();
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const toggleCollapsed = useEpicCanvasStore(
    (s) => s.toggleSnapshotDiffBundleFileCollapsedInTab,
  );
  const collapsed = props.node.view.collapsedFilePaths.includes(
    props.entry.filePath,
  );
  const bundleFindFileId = snapshotBundleDiffFindFileId(props.entry.filePath);
  const counts = useMemo(
    () =>
      diffLineCountsFromContents(
        props.entry.beforeContent,
        props.entry.afterContent,
        diffViewerPreferences.ignoreWhitespace,
      ),
    [
      diffViewerPreferences.ignoreWhitespace,
      props.entry.afterContent,
      props.entry.beforeContent,
    ],
  );
  const leading = useMemo(
    () => <DiffBundleCollapseChevron collapsed={collapsed} />,
    [collapsed],
  );

  const handleOpenFileTile = useCallback(() => {
    const tile = makeSnapshotCumulativeDiffTile({
      hostId: props.node.hostId,
      chatId: props.node.diff.chatId,
      filePath: props.entry.filePath,
    });
    navigateNested(epicId, props.viewTabId, () =>
      prepareOpenTileInTabFocusTarget(props.viewTabId, tile),
    );
  }, [
    epicId,
    navigateNested,
    prepareOpenTileInTabFocusTarget,
    props.entry.filePath,
    props.node.hostId,
    props.node.diff.chatId,
    props.viewTabId,
  ]);

  const handleToggleCollapsed = useCallback(() => {
    toggleCollapsed(props.viewTabId, props.node.id, props.entry.filePath);
  }, [props.entry.filePath, props.node.id, props.viewTabId, toggleCollapsed]);
  useEffect(() => {
    // Re-notify when a collapsed section expands (find-driven or manual): the
    // diff body only mounts while expanded, so a mount-only effect would leave
    // a freshly-revealed match stuck pending.
    if (collapsed) return;
    bundleFindRegistration.notifySectionMounted(bundleFindFileId);
  }, [bundleFindFileId, bundleFindRegistration, collapsed]);
  const headerRow = useMemo(
    () => (
      <SnapshotBundleFileRow
        entry={props.entry}
        leading={leading}
        additions={counts.additions}
        deletions={counts.deletions}
        collapsed={collapsed}
        onToggleCollapsed={handleToggleCollapsed}
      />
    ),
    [
      collapsed,
      counts.additions,
      counts.deletions,
      handleToggleCollapsed,
      leading,
      props.entry,
    ],
  );

  return (
    <DiffBundleFileSectionFrame
      collapsed={collapsed}
      headerRow={headerRow}
      onOpenFileTile={handleOpenFileTile}
      findFilePath={props.entry.filePath}
      bundleFindFileId={bundleFindFileId}
    >
      <SnapshotBundleFileSectionBody
        node={props.node}
        entry={props.entry}
        bundleFindFileId={bundleFindFileId}
        diffViewerPreferences={diffViewerPreferences}
      />
    </DiffBundleFileSectionFrame>
  );
}

function SnapshotBundleFileRow(props: {
  readonly entry: SnapshotBundleSectionEntry;
  readonly leading: ReactNode;
  readonly additions: number;
  readonly deletions: number;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onToggleCollapsed}
      className={cn(
        "flex min-h-7 w-full items-center gap-2 px-2 py-1 text-left text-ui-sm",
        "transition-colors hover:bg-accent/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
      title={props.entry.filePath}
      aria-label={`${snapshotOperationLabel(props.entry.operation)} ${props.entry.filePath}`}
      aria-expanded={!props.collapsed}
    >
      {props.leading}
      <FileChangeHeader
        filePath={props.entry.filePath}
        operation={props.entry.operation}
        additions={props.additions}
        deletions={props.deletions}
        isStreaming={false}
        endState={null}
        reason={props.entry.reason}
        clickHandlers={null}
      />
    </button>
  );
}

function SnapshotBundleFileSectionBody(props: {
  readonly node: SnapshotCumulativeBundleDiffTileRef;
  readonly entry: SnapshotBundleSectionEntry;
  readonly bundleFindFileId: string;
  readonly diffViewerPreferences: DiffViewerPreferences;
}): ReactNode {
  const bundleFindRegistration = useBundleDiffFindRegistrationContext();
  const patch = useMemo(
    () =>
      buildSnapshotUnifiedPatch({
        filePath: props.entry.filePath,
        beforeContent: props.entry.beforeContent,
        afterContent: props.entry.afterContent,
        ignoreWhitespace: props.diffViewerPreferences.ignoreWhitespace,
      }),
    [
      props.diffViewerPreferences.ignoreWhitespace,
      props.entry.afterContent,
      props.entry.beforeContent,
      props.entry.filePath,
    ],
  );
  useEffect(() => {
    if (props.entry.reason !== "snapshot") return;
    bundleFindRegistration.registerLoadedPatch({
      fileId: props.bundleFindFileId,
      patch,
      cacheKey: `snapshot-bundle:${props.node.id}:${props.entry.filePath}`,
      isTruncated: false,
    });
  }, [
    bundleFindRegistration,
    patch,
    props.bundleFindFileId,
    props.entry.filePath,
    props.entry.reason,
    props.node.id,
  ]);

  if (props.entry.reason !== "snapshot") {
    return (
      <div className="p-4 text-ui-sm text-muted-foreground">
        {FILE_EDIT_REASON_COPY[props.entry.reason]}
      </div>
    );
  }

  return (
    <DiffContentFrame
      sizing="content"
      banner={null}
      scrollContainerRef={null}
      onScroll={null}
    >
      <DiffContentPrimitive
        patch={patch}
        cacheScope={`snapshot-bundle:${props.node.id}:${props.entry.filePath}`}
        mode={props.diffViewerPreferences.mode}
        wordWrap={props.diffViewerPreferences.wordWrap}
        backgrounds={props.diffViewerPreferences.backgrounds}
        lineNumbers={props.diffViewerPreferences.lineNumbers}
        indicatorStyle={props.diffViewerPreferences.indicatorStyle}
        fileHeaders={false}
      />
    </DiffContentFrame>
  );
}

function snapshotOperationLabel(operation: string): string {
  switch (operation) {
    case "delete":
      return "Delete";
    case "create":
      return "Create";
    case "ambiguous":
      return "Write";
    default:
      return "Edit";
  }
}

function snapshotBundleDiffFindFileInput(args: {
  readonly entry: SnapshotBundleSectionEntry;
  readonly collapsed: boolean;
}): BundleDiffFindFileInput {
  const fileId = snapshotBundleDiffFindFileId(args.entry.filePath);
  return {
    id: fileId,
    filePath: args.entry.filePath,
    coverageState: snapshotBundleFileCoverageState(args),
    metadataUnits: snapshotBundleDiffMetadataUnits({
      entry: args.entry,
      fileId,
    }),
  };
}

// Only snapshot-reason entries ever load a diff patch; every other reason
// renders a terminal "unavailable" body, so account for it as a final (failed)
// coverage state instead of a pending "unloaded" one.
function snapshotBundleFileCoverageState(args: {
  readonly entry: SnapshotBundleSectionEntry;
  readonly collapsed: boolean;
}): "failed" | "collapsed" | "unloaded" {
  if (args.entry.reason !== "snapshot") return "failed";
  if (args.collapsed) return "collapsed";
  return "unloaded";
}

function snapshotBundleDiffMetadataUnits(args: {
  readonly entry: SnapshotBundleSectionEntry;
  readonly fileId: string;
}): ReadonlyArray<DiffFindMetadataUnitInput> {
  const directory = getDirname(args.entry.filePath);
  return [
    {
      id: `snapshot-bundle-file:${args.fileId}`,
      filePath: args.entry.filePath,
      scopeId: args.fileId,
      text: [
        snapshotOperationLabel(args.entry.operation),
        args.entry.filePath,
        getBasename(args.entry.filePath),
        directory.length > 0 ? directory : "Repository root",
        FILE_EDIT_REASON_COPY[args.entry.reason],
      ]
        .filter((part) => part.length > 0)
        .join(" "),
    },
  ];
}

function snapshotBundleDiffFindFileId(filePath: string): string {
  return `snapshot:${filePath}`;
}

function snapshotBundleDiffFindContentIdentity(args: {
  readonly entries: ReadonlyArray<SnapshotBundleSectionEntry>;
  readonly ignoreWhitespace: boolean;
}): string {
  return JSON.stringify([
    "snapshot-bundle",
    args.ignoreWhitespace,
    args.entries.map((entry) => [
      entry.filePath,
      entry.operation,
      entry.reason,
      entry.beforeContent,
      entry.afterContent,
    ]),
  ]);
}
