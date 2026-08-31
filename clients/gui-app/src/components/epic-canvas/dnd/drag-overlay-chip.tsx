/**
 * Drag-overlay chips for the root DndContext. Content is derived purely
 * from the drag payload (tile ref resolved once at drag start, rail panel
 * definition, header tab) - the overlay mounts at the app shell, outside
 * any epic session provider, so chips must not read live epic projections.
 * Titles therefore show the payload's snapshot `name`, not the live title. The
 * one exception is a shell's output window, whose tile carries no name worth
 * showing at all - see `ManagedCommandOutputTileDragOverlay`.
 */
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import {
  FileDiff,
  FilePlus,
  Folder,
  GitPullRequest,
  Globe,
  Lock,
} from "lucide-react";
import { LEFT_PANEL_DEFINITIONS } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { EpicNodeTabIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import { CommGraphTileIcon } from "@/components/epic-canvas/comm-graph/comm-graph-tile-icon";
import { ManagedCommandMonitorIcon } from "@/components/managed-commands/managed-command-monitor-icon";
import { managedCommandTitle } from "@/lib/managed-commands/managed-command-copy";
import { useManagedCommandOnHost } from "@/stores/managed-commands/managed-commands-for-chat";
import { HeaderTabDragOverlay } from "@/components/layout/tabs/tab-strip-drag-overlay";
import { useHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import {
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  WORKSPACE_FOLDER_DND_TYPE,
  type EpicCanvasDragSourceData,
  type EpicCanvasLeftPanelRailDragData,
} from "@/components/epic-canvas/dnd/dnd";
import type { HeaderTabDragData } from "@/components/layout/tabs/header-tab-dnd";
import {
  isBlankTileRef,
  isBrowserSessionTileRef,
  isCommGraphTileRef,
  isPublishedChatTileRef,
  isDiffTileRef,
  isGitDiffTileRef,
  isManagedCommandOutputTileRef,
  isPrDetailTileRef,
  isPrDiffTileRef,
  type BlankTileRef,
  type BrowserSessionTileRef,
  type ManagedCommandOutputTileRef,
  type EpicCanvasTileRef,
  type EpicNodeRef,
  type GitDiffTileRef,
  type PrDetailTileRef,
  type PrDiffTileRef,
  type SnapshotDiffTileRef,
} from "@/stores/epics/canvas/types";
import { cn } from "@/lib/utils";
import {
  gitBundleGroupLabel,
  gitDiffRepositoryContextLabel,
  gitStageLabel,
} from "@/lib/git/git-diff-tile";
import { getBasename } from "@/lib/path/cross-platform-path";

const CHIP_CLASS =
  "pointer-events-none flex h-9 w-max max-w-[min(80vw,24rem)] cursor-grabbing select-none items-center gap-1.5 rounded-md border border-canvas-border/80 bg-canvas px-3 text-ui-sm text-canvas-foreground shadow-lg";

const CHIP_MOTION = {
  initial: { opacity: 0, scale: 0.96, y: 2 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96, y: 2 },
  transition: { duration: 0.16, ease: "easeOut" },
} as const;

type CanvasOpenableDragSource = Exclude<
  EpicCanvasDragSourceData,
  EpicCanvasLeftPanelRailDragData
>;

/**
 * Rail drags never resolve an overlay tile (`resolveOverlayTileForSource`
 * returns null for them), so a non-null tile always pairs with a
 * canvas-openable source that carries an `epicId`. Narrowing once here lets
 * the node chip render from the narrowed type instead of an empty-string
 * epic sentinel.
 */
function canvasOpenableDragSource(
  source: EpicCanvasDragSourceData | null,
): CanvasOpenableDragSource | null {
  if (source === null || source.kind === LEFT_PANEL_RAIL_ITEM_DND_TYPE) {
    return null;
  }
  return source;
}

/**
 * Overlay content host: renders the chip matching the active drag payload.
 * Mounted inside the root `DragOverlay`. Subscribes to the drag store's
 * active fields only - preview ticks never re-render it.
 */
export function EpicRootDragOverlayContent() {
  const overlayTile = useEpicDndStore((s) => s.activeOverlayTile);
  // A dragged TILE is the tab itself, so its overlay takes the tile's measured
  // width instead of sizing to its own content.
  const tileSourceWidth = useEpicDndStore((s) => s.tileSourceWidth);
  const activeSource = useEpicDndStore((s) => s.activeSource);
  const activeHeaderTab = useEpicDndStore((s) => s.activeHeaderTab);
  const headerTabWidth = useEpicDndStore((s) => s.headerStripSourceWidth);
  const openableSource = canvasOpenableDragSource(activeSource);
  const railSource =
    activeSource?.kind === LEFT_PANEL_RAIL_ITEM_DND_TYPE ? activeSource : null;
  const folderSource =
    activeSource?.kind === WORKSPACE_FOLDER_DND_TYPE ? activeSource : null;

  return (
    // One native-view occlusion marker for every chip. The coordinator scans
    // `[data-browser-overlay]` elements and takes each one's own bounding rect
    // (`collectBrowserOverlaySurfaces`), so an ancestor is read exactly like a
    // chip root as long as it hugs the chip - hence `w-max`. Marking here
    // rather than per chip is what stops the next chip variant from being born
    // invisible over a live browser tile, the way the published-chat one was.
    // dnd-kit's `<DragOverlay>` takes no data attributes, so this is the
    // outermost element we own; it exists only while a drag is active.
    <div
      className="pointer-events-none w-max"
      data-browser-overlay="drag-overlay"
    >
      <AnimatePresence initial={false}>
        {overlayTile === null || openableSource === null ? null : (
          <div
            style={
              tileSourceWidth === null ? undefined : { width: tileSourceWidth }
            }
            // The chip itself is `w-max max-w-[min(80vw,24rem)]`, so a width on
            // this wrapper alone does nothing - a 192px tile rendered a 360px
            // chip. The child variants override both, which makes the dragged
            // object the tile at its own measured width.
            className={cn(
              tileSourceWidth === null
                ? undefined
                : "[&>*]:w-full [&>*]:max-w-none",
            )}
          >
            <EpicCanvasNodeDragOverlay
              key={overlayTile.instanceId}
              node={overlayTile}
              epicId={openableSource.epicId}
            />
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {folderSource === null ? null : (
          <WorkspaceFolderDragOverlay
            key={folderSource.folderPath}
            name={folderSource.name}
          />
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {railSource === null ? null : (
          <LeftPanelRailDragOverlay
            key={railSource.panelId}
            source={railSource}
          />
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {activeHeaderTab === null ? null : (
          <HeaderTabOverlayChip
            key={`${activeHeaderTab.tabKind}:${activeHeaderTab.tabId}`}
            tab={activeHeaderTab}
            width={headerTabWidth}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function WorkspaceFolderDragOverlay(props: { readonly name: string }) {
  return (
    <m.div {...CHIP_MOTION} className={cn(CHIP_CLASS)}>
      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{props.name}</span>
    </m.div>
  );
}

function HeaderTabOverlayChip(props: {
  readonly tab: HeaderTabDragData;
  readonly width: number | null;
}) {
  const allTabs = useHeaderTabs();
  const tab =
    allTabs.find(
      (candidate) =>
        candidate.kind === props.tab.tabKind &&
        candidate.id === props.tab.tabId,
    ) ?? null;
  if (tab === null) return null;
  return <HeaderTabDragOverlay tab={tab} width={props.width} />;
}

function EpicCanvasNodeDragOverlay(props: {
  readonly node: EpicCanvasTileRef;
  readonly epicId: string;
}) {
  if (isDiffTileRef(props.node)) {
    return <DiffTileDragOverlay node={props.node} />;
  }
  if (isPrDetailTileRef(props.node)) {
    return <PrDetailTileDragOverlay node={props.node} />;
  }
  if (isPrDiffTileRef(props.node)) {
    return <PrDiffTileDragOverlay node={props.node} />;
  }
  if (isBlankTileRef(props.node)) {
    return <BlankTileDragOverlay node={props.node} />;
  }
  if (isBrowserSessionTileRef(props.node)) {
    return <BrowserSessionTileDragOverlay node={props.node} />;
  }
  if (isManagedCommandOutputTileRef(props.node)) {
    return (
      <ManagedCommandOutputTileDragOverlay
        node={props.node}
        epicId={props.epicId}
      />
    );
  }
  if (isCommGraphTileRef(props.node)) {
    return (
      <m.div {...CHIP_MOTION} className={cn(CHIP_CLASS)}>
        <CommGraphTileIcon className="size-3.5" />
        <span className="min-w-0 truncate font-medium">{props.node.name}</span>
      </m.div>
    );
  }
  if (isPublishedChatTileRef(props.node)) {
    return (
      <m.div {...CHIP_MOTION} className={cn(CHIP_CLASS)}>
        <Lock className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">{props.node.name}</span>
      </m.div>
    );
  }
  return <ArtifactNodeDragOverlay node={props.node} epicId={props.epicId} />;
}

/**
 * The dragged output window has no label of its own (its tile is just the
 * command pointer), so the chip reads the shell's live title the way the tab it
 * came from does - dragging "Output" out of a strip that says "Monitor · deploy
 * watcher" is the chip disagreeing with the thing under the cursor.
 *
 * The exception to this module's no-live-projections rule (see the header): the
 * chat-session registry is a module singleton, not an epic-scoped provider, so
 * it is readable from the app shell. Falls back to the payload's snapshot name
 * when the owning chat has no live session, exactly as the tab does.
 */
function ManagedCommandOutputTileDragOverlay(props: {
  readonly node: ManagedCommandOutputTileRef;
  readonly epicId: string;
}) {
  const command = useManagedCommandOnHost({
    epicId: props.epicId,
    hostId: props.node.hostId,
    commandId: props.node.id,
  });
  return (
    <m.div {...CHIP_MOTION} className={cn(CHIP_CLASS)}>
      <ManagedCommandMonitorIcon
        monitoring={command !== null && command.monitoring}
        decorative
        className="size-3.5"
      />
      <span className="min-w-0 truncate font-medium">
        {command === null ? props.node.name : managedCommandTitle(command)}
      </span>
    </m.div>
  );
}

function BlankTileDragOverlay(props: { readonly node: BlankTileRef }) {
  return (
    <m.div {...CHIP_MOTION} className={cn(CHIP_CLASS)}>
      <FilePlus className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{props.node.name}</span>
    </m.div>
  );
}

function PrDetailTileDragOverlay(props: { readonly node: PrDetailTileRef }) {
  return (
    <m.div {...CHIP_MOTION} className={cn(CHIP_CLASS)}>
      <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{props.node.name}</span>
    </m.div>
  );
}

function BrowserSessionTileDragOverlay(props: {
  readonly node: BrowserSessionTileRef;
}) {
  return (
    <m.div
      {...CHIP_MOTION}
      className={cn(CHIP_CLASS)}
      data-browser-tab-id={props.node.tabId}
    >
      <Globe className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">Browser</span>
    </m.div>
  );
}

function PrDiffTileDragOverlay(props: { readonly node: PrDiffTileRef }) {
  return (
    <m.div {...CHIP_MOTION} className={cn(CHIP_CLASS)}>
      <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{props.node.name}</span>
    </m.div>
  );
}

function ArtifactNodeDragOverlay(props: {
  readonly node: EpicNodeRef;
  readonly epicId: string;
}) {
  return (
    <m.div {...CHIP_MOTION} className={cn(CHIP_CLASS)}>
      <EpicNodeTabIcon
        node={props.node}
        epicId={props.epicId}
        variant="static"
        className="size-3.5 shrink-0"
        defaultIcon={undefined}
      />
      <span className="min-w-0 truncate font-medium">{props.node.name}</span>
    </m.div>
  );
}

function DiffTileDragOverlay(props: {
  readonly node: GitDiffTileRef | SnapshotDiffTileRef;
}) {
  if (isGitDiffTileRef(props.node)) {
    return <GitDiffTileDragOverlay node={props.node} />;
  }
  return (
    <m.div {...CHIP_MOTION} className={cn(CHIP_CLASS)}>
      <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{props.node.name}</span>
    </m.div>
  );
}

function GitDiffTileDragOverlay(props: { readonly node: GitDiffTileRef }) {
  const scopeLabel =
    props.node.diff.kind === "bundle"
      ? gitBundleGroupLabel(props.node.diff.bundleGroup)
      : gitStageLabel(props.node.diff.stage);
  let subjectLabel = getBasename(props.node.diff.runningDir);
  if (props.node.diff.kind === "file") {
    subjectLabel = getBasename(props.node.diff.filePath);
  } else if (props.node.repositoryContext !== null) {
    subjectLabel = gitDiffRepositoryContextLabel(props.node.repositoryContext);
  }

  return (
    <m.div
      {...CHIP_MOTION}
      aria-label={`${scopeLabel}: ${subjectLabel}`}
      className={cn(CHIP_CLASS)}
      data-testid="git-diff-drag-overlay"
    >
      <FileDiff className="size-3.5 shrink-0 text-primary" />
      <span
        className="shrink-0 font-medium"
        data-testid="git-diff-drag-overlay-scope"
      >
        {scopeLabel}
      </span>
      <span aria-hidden="true" className="text-muted-foreground/70">
        ·
      </span>
      <span
        className="min-w-0 truncate text-muted-foreground"
        data-testid="git-diff-drag-overlay-subject"
      >
        {subjectLabel}
      </span>
    </m.div>
  );
}

function LeftPanelRailDragOverlay(props: {
  readonly source: EpicCanvasLeftPanelRailDragData;
}) {
  const panel =
    LEFT_PANEL_DEFINITIONS.find(
      (definition) => definition.id === props.source.panelId,
    ) ?? null;
  if (panel === null) return null;
  const Icon = panel.icon;
  return (
    <m.div
      {...CHIP_MOTION}
      className={cn(
        "pointer-events-none flex h-9 cursor-grabbing select-none items-center gap-2 rounded-md border border-canvas-border/80 bg-canvas px-3 text-ui-sm font-medium text-canvas-foreground shadow-lg",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span>{panel.title}</span>
    </m.div>
  );
}
