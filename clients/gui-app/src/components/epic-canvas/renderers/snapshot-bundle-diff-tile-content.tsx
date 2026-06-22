import { useCallback, useMemo, type ReactNode } from "react";
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
import { diffLineCountsFromContents } from "@/lib/file-change-diff-hunks";
import {
  DiffContentFrame,
  DiffContentPrimitive,
} from "@/components/diff/diff-content-primitive";
import { useBundleDiffScrollRestoration } from "@/hooks/scroll/use-bundle-diff-scroll-restoration";
import {
  DiffBundleCollapseChevron,
  DiffBundleFileSectionFrame,
} from "@/components/epic-canvas/git-diff/diff-bundle-file-section";
import { FileChangeHeader } from "@/components/chat/segments/file-change-segment";
import { cn } from "@/lib/utils";

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
  const { virtuosoRef, restoreStateFrom, isScrolling } =
    useBundleDiffScrollRestoration(
      props.node.instanceId,
      props.entries.length > 0,
    );
  return (
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
  );
}

function SnapshotBundleFileSection(props: {
  readonly node: SnapshotCumulativeBundleDiffTileRef;
  readonly viewTabId: string;
  readonly entry: SnapshotBundleSectionEntry;
}): ReactNode {
  const diffViewerPreferences = useSettingsStore(
    (s) => s.diffViewerPreferences,
  );
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);
  const toggleCollapsed = useEpicCanvasStore(
    (s) => s.toggleSnapshotDiffBundleFileCollapsedInTab,
  );
  const collapsed = props.node.view.collapsedFilePaths.includes(
    props.entry.filePath,
  );
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
    openTileInTab(
      props.viewTabId,
      makeSnapshotCumulativeDiffTile({
        hostId: props.node.hostId,
        chatId: props.node.diff.chatId,
        filePath: props.entry.filePath,
      }),
    );
  }, [
    openTileInTab,
    props.entry.filePath,
    props.node.hostId,
    props.node.diff.chatId,
    props.viewTabId,
  ]);

  const handleToggleCollapsed = useCallback(() => {
    toggleCollapsed(props.viewTabId, props.node.id, props.entry.filePath);
  }, [props.entry.filePath, props.node.id, props.viewTabId, toggleCollapsed]);
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
    >
      <SnapshotBundleFileSectionBody
        node={props.node}
        entry={props.entry}
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
  readonly diffViewerPreferences: DiffViewerPreferences;
}): ReactNode {
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
