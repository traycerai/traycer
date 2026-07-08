import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  computeArtifactNodeStatusDot,
  STATUS_DOT_CLASSES,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import {
  useArtifactDragSource,
  type ArtifactDragIdentity,
} from "@/components/epic-canvas/dnd/use-artifact-drag-source";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  EPIC_NODE_ICONS,
  isEpicArtifactKind,
  type EpicNodeKind,
} from "@/lib/artifacts/node-display";
import { useChildIdsOf, useTreeNodeById } from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";
import {
  isOpenableEpicNodeKind,
  makeOpenableNodeRef,
} from "@/stores/epics/canvas/types";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { appLogger } from "@/lib/logger";

interface ArtifactChildIndexProps {
  readonly epicId: string;
  readonly parentId: string;
  readonly viewTabId: string;
  readonly hostId: string;
}

interface MakeArtifactDragIdentityArgs {
  readonly childId: string;
  readonly hostId: string;
  readonly title: string;
  readonly treeNodeExists: boolean;
  readonly type: string | null;
}

/**
 * Presentation-only index of an artifact's immediate children, rendered below
 * its body. The list is derived live from the tree projection - it is never
 * written into the artifact's markdown - so it stays correct as children are
 * added, renamed, reordered, or removed. An empty-bodied container (e.g. a
 * grouping `spec` materialized from an index.md-less folder) therefore reads as
 * "the children are the page". Renders nothing when the artifact has no
 * children. Each row mirrors the sidebar's node identity (canonical kind icon +
 * color, status dot for status-bearing kinds) and is navigation-only: clicking
 * opens the child as a preview tile in the same tab.
 */
export function ArtifactChildIndex(props: ArtifactChildIndexProps) {
  const childIds = useChildIdsOf(props.parentId);
  if (childIds.length === 0) return null;
  return (
    <nav
      data-testid="artifact-child-index"
      className="flex flex-col border-t border-border/40 pt-2"
    >
      {childIds.map((childId) => (
        <ChildIndexRow
          key={childId}
          epicId={props.epicId}
          childId={childId}
          viewTabId={props.viewTabId}
          hostId={props.hostId}
        />
      ))}
    </nav>
  );
}

function ChildIndexRow(props: {
  readonly epicId: string;
  readonly childId: string;
  readonly viewTabId: string;
  readonly hostId: string;
}) {
  const { epicId, childId, viewTabId, hostId } = props;
  const treeNode = useTreeNodeById(childId);
  const tileNavigation = useEpicTileNavigation();
  const iconColorMode = useSettingsStore((s) => s.artifactIconColorMode);
  const iconColors = useSettingsStore((s) => s.artifactIconColors);
  const type = treeNode?.type ?? null;
  const title = treeNode?.title ?? "";
  const treeNodeExists = treeNode !== null;
  const dragIdentity = makeArtifactDragIdentity({
    childId,
    hostId,
    title,
    treeNodeExists,
    type,
  });
  const {
    isDraggable,
    setNodeRef: dragRef,
    listeners: dragListeners,
    attributes: dragAttributes,
    isDragging,
  } = useArtifactDragSource({
    epicId,
    viewTabId,
    identity: dragIdentity,
    enabled: dragIdentity !== null,
  });

  const open = useCallback(() => {
    if (type === null || !isOpenableEpicNodeKind(type)) return;
    tileNavigation.openTilePreviewInTab(
      viewTabId,
      makeOpenableNodeRef({
        id: childId,
        instanceId: uuidv4(),
        type,
        name: title,
        hostId,
      }),
    );
  }, [type, title, childId, viewTabId, hostId, tileNavigation]);

  // Children of an artifact are themselves artifacts; the guard keeps the row
  // type-safe and quietly drops any non-artifact node that ever appears here.
  if (treeNode === null || type === null || !isEpicArtifactKind(type)) {
    appLogger.warn("[artifact-child-index] skipping child row", {
      childId,
      viewTabId,
      hostId,
      reason: getSkippedChildRowReason(treeNodeExists, type),
    });
    return null;
  }

  const Icon = EPIC_NODE_ICONS[type];
  const iconStyle =
    iconColorMode === "byType" ? { color: iconColors[type] } : undefined;

  return (
    <button
      ref={isDraggable ? dragRef : undefined}
      {...(isDraggable ? dragAttributes : undefined)}
      {...(isDraggable ? dragListeners : undefined)}
      type="button"
      onClick={open}
      data-testid={`artifact-child-index-row-${childId}`}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/50",
        isDraggable && "cursor-grab",
        isDragging && "cursor-grabbing opacity-60",
      )}
    >
      <Icon className="size-4 shrink-0" style={iconStyle} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <ArtifactStatusDot type={type} status={treeNode.status} />
    </button>
  );
}

function makeArtifactDragIdentity(
  args: MakeArtifactDragIdentityArgs,
): ArtifactDragIdentity | null {
  if (
    !args.treeNodeExists ||
    args.type === null ||
    !isEpicArtifactKind(args.type) ||
    args.title.length === 0
  ) {
    return null;
  }

  return {
    id: args.childId,
    type: args.type,
    name: args.title,
    hostId: args.hostId,
  };
}

function getSkippedChildRowReason(
  treeNodeExists: boolean,
  type: string | null,
): string {
  if (!treeNodeExists) return "missing tree node";
  if (type === null) return "missing node type";
  return `non-artifact node type=${type}`;
}

function ArtifactStatusDot(props: {
  readonly type: EpicNodeKind;
  readonly status: number | null;
}) {
  const showStatusDot = computeArtifactNodeStatusDot(props.type, props.status);
  if (!showStatusDot || props.status === null) return null;
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        STATUS_DOT_CLASSES[props.status] ?? "bg-slate-400",
      )}
    />
  );
}
