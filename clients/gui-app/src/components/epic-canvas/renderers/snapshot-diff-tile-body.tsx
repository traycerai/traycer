import { memo, useCallback, useMemo, type ReactNode } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { buildSnapshotUnifiedPatchBundle } from "@/lib/diff/snapshot-diff-patch";
import { getBasename, getDirname } from "@/lib/path/cross-platform-path";
import type {
  SnapshotDiffTileRef,
  SnapshotDiffTilePayload,
} from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { DiffViewerPreferences } from "@/lib/diff/diff-viewer-preferences";
import {
  resolveHashBackedEndpoints,
  resolveSnapshotDiffContents,
  type ResolvedSnapshotDiff,
  type SnapshotDiffSource,
} from "@/lib/chat/resolve-snapshot-diff-content";
import { useSnapshotDiffQuery } from "@/hooks/snapshots/use-snapshot-diff-query";
import {
  DiffContentFrame,
  DiffContentPrimitive,
} from "@/components/diff/diff-content-primitive";
import { useDiffFindNavigation } from "@/components/diff/diff-find-navigation";
import { useRegisterDiffTileFindAdapter } from "@/components/diff/use-register-diff-tile-find-adapter";
import type { DiffFindMetadataUnitInput } from "@/lib/diff/diff-find";
import { useNativeDivScrollRestoration } from "@/hooks/scroll/use-native-div-scroll-restoration";
import {
  createLoadedDiffTileFindSource,
  createLoadingDiffTileFindSource,
  createMissingDiffTileFindSource,
  type DiffTileFindSource,
} from "@/stores/tile-find";
import { DiffBundleLoadingSkeleton } from "@/components/epic-canvas/git-diff/diff-bundle-loading-skeleton";
import {
  SnapshotBundleDiffTileContent,
  type SnapshotCumulativeBundleDiffTileRef,
} from "./snapshot-bundle-diff-tile-content";
import { snapshotBundleSectionEntries } from "@/lib/chat/snapshot-bundle-section-entries";
import { DiffContentLoadingSkeleton } from "@/components/epic-canvas/git-diff/diff-content-loading-skeleton";
import { DiffTabShell } from "@/components/epic-canvas/git-diff/diff-tab-shell";
import {
  DiffTabToolbar,
  type DiffTabToolbarView,
  type DiffTabToolbarViewPatch,
} from "@/components/epic-canvas/git-diff/diff-tab-toolbar";
import { SnapshotDiffSourceUnavailableBanner } from "./dead-tile-banner";

const SNAPSHOT_DIFF_LOADING_FIND_MESSAGE =
  "Snapshot diff content is still loading.";
const SNAPSHOT_DIFF_MISSING_FIND_MESSAGE =
  "Snapshot source content is unavailable.";

interface SnapshotDiffTileBodyProps {
  readonly node: SnapshotDiffTileRef;
  readonly viewTabId: string;
}

/**
 * Renders a chat file-edit snapshot as a full diff tile. Re-reads the agent's
 * before/after live from the chat session by `chatId` (reference-not-copy),
 * synthesizes a unified patch, and renders it through the shared
 * `DiffContentPrimitive` with the same toolbar/view-state as a Git tile -
 * minus refresh (a snapshot is immutable).
 */
export function SnapshotDiffTileBody(
  props: SnapshotDiffTileBodyProps,
): ReactNode {
  const { node, viewTabId } = props;
  const hostId = useTabHostId();
  const handle = useChatSessionHandle(node.diff.chatId, hostId, true);

  if (handle === null) {
    return (
      <SnapshotDiffTileShell node={node} viewTabId={viewTabId}>
        <SnapshotDiffFindRegistration
          tileInstanceId={node.instanceId}
          source={createLoadingDiffTileFindSource({
            coverageMessage: SNAPSHOT_DIFF_LOADING_FIND_MESSAGE,
          })}
        />
        <SnapshotDiffLoading node={node} />
      </SnapshotDiffTileShell>
    );
  }

  return (
    <SnapshotDiffTileResolved
      node={node}
      handle={handle}
      viewTabId={viewTabId}
    />
  );
}

interface SnapshotDiffTileShellProps {
  readonly node: SnapshotDiffTileRef;
  readonly viewTabId: string;
  readonly children: ReactNode;
}

const SnapshotDiffTileShell = memo(function SnapshotDiffTileShell(
  props: SnapshotDiffTileShellProps,
) {
  const { node, viewTabId, children } = props;
  const diffViewerPreferences = useSettingsStore(
    (s) => s.diffViewerPreferences,
  );
  const patchDiffViewerPreferences = useSettingsStore(
    (s) => s.patchDiffViewerPreferences,
  );
  const updateView = useEpicCanvasStore(
    (s) => s.updateSnapshotDiffTileViewInTab,
  );

  const toolbarView = useMemo(
    () => diffToolbarView(diffViewerPreferences, node.view.collapsedFilePaths),
    [diffViewerPreferences, node.view.collapsedFilePaths],
  );

  const handleViewPatch = useCallback(
    (patch: DiffTabToolbarViewPatch) => {
      if ("collapsedFilePaths" in patch) {
        updateView(viewTabId, node.id, {
          ...node.view,
          collapsedFilePaths: patch.collapsedFilePaths,
        });
        return;
      }
      patchDiffViewerPreferences(patch);
    },
    [patchDiffViewerPreferences, node.id, node.view, updateView, viewTabId],
  );

  const primaryTitle = snapshotDiffPrimaryTitle(node.diff);
  const secondaryLine = snapshotDiffSecondaryLine(node.diff);
  const collapseAll = useMemo(
    () => snapshotDiffCollapseAll(node.diff, node.view.collapsedFilePaths),
    [node.diff, node.view.collapsedFilePaths],
  );
  const toolbar = useMemo(
    () => (
      <DiffTabToolbar
        view={toolbarView}
        onViewPatch={handleViewPatch}
        collapseAll={collapseAll}
        refreshing={false}
        onRefresh={null}
        onOpenFile={null}
        openFileDisabled={false}
        openFileOpening={false}
      />
    ),
    [collapseAll, handleViewPatch, toolbarView],
  );

  return (
    <DiffTabShell
      primaryTitle={primaryTitle}
      secondaryLine={secondaryLine}
      contextLabel={null}
      toolbar={toolbar}
    >
      {children}
    </DiffTabShell>
  );
});

function SnapshotDiffTileResolved(props: {
  readonly node: SnapshotDiffTileRef;
  readonly handle: ChatSessionStoreHandle;
  readonly viewTabId: string;
}): ReactNode {
  const { node, handle, viewTabId } = props;
  const diffViewerPreferences = useSettingsStore(
    (s) => s.diffViewerPreferences,
  );
  const source = useStore(
    handle.store,
    useShallow(
      (s): SnapshotDiffSource & { readonly snapshotLoaded: boolean } => ({
        snapshotLoaded: s.snapshotLoaded,
        messages: s.messages,
        liveAssistantBlocks: s.liveAssistantMessage?.blocks ?? null,
        accumulatedFileChanges: s.accumulatedFileChanges,
      }),
    ),
  );
  const {
    accumulatedFileChanges,
    liveAssistantBlocks,
    messages,
    snapshotLoaded,
  } = source;

  // A hash-backed tile (segment or artifact-hash) resolves only its content-
  // addressed endpoints, then lazy-fetches the before/after content by hash (the
  // chat doc no longer inlines it). A segment reads its hashes from the
  // file_change blocks; an artifact-hash tile carries them on its payload.
  // Cumulative/bundle tiles still read content inline from the host-computed
  // accumulated changes.
  const segmentHashes = useMemo(
    () =>
      resolveHashBackedEndpoints(node.diff, {
        messages,
        liveAssistantBlocks,
        accumulatedFileChanges,
      }),
    [accumulatedFileChanges, liveAssistantBlocks, messages, node.diff],
  );
  const segmentQuery = useSnapshotDiffQuery({
    beforeHash: segmentHashes?.beforeHash ?? null,
    afterHash: segmentHashes?.afterHash ?? null,
    enabled: segmentHashes !== null,
  });

  const resolved = useMemo<ReadonlyArray<ResolvedSnapshotDiff>>(() => {
    if (segmentHashes !== null) {
      const data = segmentQuery.data;
      if (data === undefined || data.reason !== "snapshot") return [];
      return [
        {
          filePath: segmentHashes.filePath,
          beforeContent: data.beforeContent,
          afterContent: data.afterContent,
        },
      ];
    }
    if (
      node.diff.kind === "snapshot-cumulative" ||
      node.diff.kind === "snapshot-cumulative-bundle"
    ) {
      return resolveSnapshotDiffContents(node.diff, {
        messages,
        liveAssistantBlocks,
        accumulatedFileChanges,
      });
    }
    return [];
  }, [
    accumulatedFileChanges,
    liveAssistantBlocks,
    messages,
    node.diff,
    segmentHashes,
    segmentQuery.data,
  ]);

  // A hash-backed tile whose content is actively in-flight shows the skeleton.
  // Use isLoading (isPending && isFetching), NOT isPending: a content-less edit
  // (both hashes null) disables the query, which leaves isPending permanently
  // true but isFetching false - that case must fall through to the
  // source-unavailable banner, not spin forever.
  const segmentPending = segmentHashes !== null && segmentQuery.isLoading;

  const patch = useMemo(() => {
    if (node.diff.kind === "snapshot-cumulative-bundle") return null;
    if (resolved.length === 0) return null;
    return buildSnapshotUnifiedPatchBundle({
      entries: resolved,
      ignoreWhitespace: diffViewerPreferences.ignoreWhitespace,
    });
  }, [diffViewerPreferences.ignoreWhitespace, node.diff.kind, resolved]);
  const bundleEntries = useMemo(
    () => snapshotBundleSectionEntries(resolved, accumulatedFileChanges),
    [accumulatedFileChanges, resolved],
  );

  if (!snapshotLoaded || segmentPending) {
    return (
      <SnapshotDiffTileShell node={node} viewTabId={viewTabId}>
        <SnapshotDiffFindRegistration
          tileInstanceId={node.instanceId}
          source={createLoadingDiffTileFindSource({
            coverageMessage: SNAPSHOT_DIFF_LOADING_FIND_MESSAGE,
          })}
        />
        <SnapshotDiffLoading node={node} />
      </SnapshotDiffTileShell>
    );
  }

  if (resolved.length === 0) {
    return (
      <SnapshotDiffTileShell node={node} viewTabId={viewTabId}>
        <SnapshotDiffFindRegistration
          tileInstanceId={node.instanceId}
          source={createMissingDiffTileFindSource({
            coverageMessage: SNAPSHOT_DIFF_MISSING_FIND_MESSAGE,
          })}
        />
        <SnapshotDiffSourceUnavailableBanner
          testId={`snapshot-diff-unavailable-${node.id}`}
        />
      </SnapshotDiffTileShell>
    );
  }

  if (isSnapshotCumulativeBundleDiffTileRef(node)) {
    return (
      <SnapshotDiffTileShell node={node} viewTabId={viewTabId}>
        <SnapshotBundleDiffTileContent
          node={node}
          viewTabId={viewTabId}
          entries={bundleEntries}
        />
      </SnapshotDiffTileShell>
    );
  }

  if (patch === null) return null;

  return (
    <SnapshotDiffTileShell node={node} viewTabId={viewTabId}>
      <SnapshotFileDiffContent
        node={node}
        patch={patch}
        resolved={resolved}
        diffViewerPreferences={diffViewerPreferences}
      />
    </SnapshotDiffTileShell>
  );
}

/**
 * Single-file snapshot diff body. Scoped to its own component (not inlined in
 * `SnapshotDiffTileResolved`) so the native scroll-restoration hook runs only
 * on the single-file path - the bundle path owns the same `instanceId` via its
 * Virtuoso restoration, and two hooks writing one anchor would conflict. Mounts
 * only once `patch` is resolved, so content is ready.
 */
function SnapshotFileDiffContent(props: {
  readonly node: SnapshotDiffTileRef;
  readonly patch: string;
  readonly resolved: ReadonlyArray<ResolvedSnapshotDiff>;
  readonly diffViewerPreferences: DiffViewerPreferences;
}): ReactNode {
  const { scrollContainerRef, onScroll } = useNativeDivScrollRestoration(
    props.node.instanceId,
    true,
  );
  const findNavigation = useDiffFindNavigation();
  const findSource = useMemo(
    () =>
      createLoadedDiffTileFindSource({
        patch: props.patch,
        metadataUnits: snapshotDiffMetadataUnits({
          node: props.node,
          resolved: props.resolved,
        }),
        cacheKey: `snapshot:${props.node.id}`,
        isPartial: false,
        partialMessage: null,
      }),
    [props.node, props.patch, props.resolved],
  );
  useRegisterDiffTileFindAdapter({
    tileInstanceId: props.node.instanceId,
    tileKind: "snapshot-diff",
    source: findSource,
    renderer: findNavigation,
  });
  const findScrollContainerRef = useCallback(
    (element: HTMLDivElement | null): void => {
      scrollContainerRef(element);
      findNavigation.setScrollContainer(element);
    },
    [findNavigation, scrollContainerRef],
  );

  return (
    <DiffContentFrame
      sizing="fill"
      scrollContainerRef={findScrollContainerRef}
      onScroll={onScroll}
      banner={null}
    >
      <DiffContentPrimitive
        patch={props.patch}
        cacheScope={`snapshot:${props.node.id}`}
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

function SnapshotDiffFindRegistration(props: {
  readonly tileInstanceId: string;
  readonly source: DiffTileFindSource;
}): ReactNode {
  useRegisterDiffTileFindAdapter({
    tileInstanceId: props.tileInstanceId,
    tileKind: "snapshot-diff",
    source: props.source,
    renderer: null,
  });
  return null;
}

function snapshotDiffMetadataUnits(args: {
  readonly node: SnapshotDiffTileRef;
  readonly resolved: ReadonlyArray<ResolvedSnapshotDiff>;
}): ReadonlyArray<DiffFindMetadataUnitInput> {
  return args.resolved.map((entry, index) => {
    const directory = getDirname(entry.filePath);
    return {
      id: `snapshot-file:${args.node.id}:${index}:${entry.filePath}`,
      filePath: entry.filePath,
      scopeId: null,
      text: [
        snapshotDiffFindTitle(args.node.diff, entry.filePath),
        directory.length > 0 ? directory : "Repository root",
        entry.filePath,
        snapshotDiffFindKindLabel(args.node.diff),
      ]
        .filter((part) => part.length > 0)
        .join(" "),
    };
  });
}

function snapshotDiffFindTitle(
  diff: SnapshotDiffTilePayload,
  filePath: string,
): string {
  if (
    diff.kind === "snapshot-hash" &&
    diff.title !== null &&
    diff.title.length > 0
  ) {
    return diff.title;
  }
  return getBasename(filePath);
}

function snapshotDiffFindKindLabel(diff: SnapshotDiffTilePayload): string {
  if (diff.kind === "snapshot-hash") return "Artifact diff";
  if (diff.kind === "snapshot-segment") return "Edit";
  if (diff.kind === "snapshot-cumulative") return "Changes";
  return "Cumulative chat changes";
}

function SnapshotDiffLoading(props: {
  readonly node: SnapshotDiffTileRef;
}): ReactNode {
  const mode = useSettingsStore((s) => s.diffViewerPreferences.mode);
  if (props.node.diff.kind === "snapshot-cumulative-bundle") {
    return <DiffBundleLoadingSkeleton mode={mode} />;
  }
  return (
    <DiffContentLoadingSkeleton
      mode={mode}
      sizing="fill"
      density="full"
      sectionIndex={0}
    />
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

function isSnapshotCumulativeBundleDiffTileRef(
  node: SnapshotDiffTileRef,
): node is SnapshotCumulativeBundleDiffTileRef {
  return node.diff.kind === "snapshot-cumulative-bundle";
}

function snapshotDiffCollapseAll(
  diff: SnapshotDiffTilePayload,
  collapsedFilePaths: ReadonlyArray<string>,
): {
  readonly allCollapsed: boolean;
  readonly filePaths: ReadonlyArray<string>;
} | null {
  if (diff.kind !== "snapshot-cumulative-bundle") return null;
  if (diff.filePaths.length === 0) return null;
  return {
    allCollapsed: diff.filePaths.every((filePath) =>
      collapsedFilePaths.includes(filePath),
    ),
    filePaths: diff.filePaths,
  };
}

function snapshotDiffPrimaryTitle(diff: SnapshotDiffTilePayload): string {
  if (diff.kind === "snapshot-cumulative-bundle") {
    return `${diff.filePaths.length} ${diff.filePaths.length === 1 ? "file" : "files"} changed`;
  }
  if (
    diff.kind === "snapshot-hash" &&
    diff.title !== null &&
    diff.title.length > 0
  ) {
    return diff.title;
  }
  return getBasename(diff.filePath);
}

function snapshotDiffSecondaryLine(diff: SnapshotDiffTilePayload): ReactNode {
  if (diff.kind === "snapshot-cumulative-bundle") {
    return "Cumulative chat changes";
  }
  if (diff.kind === "snapshot-hash") {
    return "Artifact diff";
  }
  const directory = getDirname(diff.filePath);
  return (
    <>
      {directory.length > 0 ? directory : "Repository root"}
      <span className="text-muted-foreground/50"> · </span>
      {diff.kind === "snapshot-segment" ? "Edit" : "Changes"}
    </>
  );
}
