import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  computeArtifactNodeStatusDot,
  STATUS_DOT_CLASSES,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import {
  EPIC_NODE_ICONS,
  isEpicArtifactKind,
} from "@/lib/artifacts/node-display";
import { useChildIdsOf, useTreeNodeById } from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";
import {
  isOpenableEpicNodeKind,
  makeOpenableNodeRef,
} from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { appLogger } from "@/lib/logger";

interface ArtifactChildIndexProps {
  readonly parentId: string;
  readonly viewTabId: string;
  readonly hostId: string;
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
          childId={childId}
          viewTabId={props.viewTabId}
          hostId={props.hostId}
        />
      ))}
    </nav>
  );
}

function ChildIndexRow(props: {
  readonly childId: string;
  readonly viewTabId: string;
  readonly hostId: string;
}) {
  const { childId, viewTabId, hostId } = props;
  const treeNode = useTreeNodeById(childId);
  const openTilePreviewInTab = useEpicCanvasStore(
    (s) => s.openTilePreviewInTab,
  );
  const iconColorMode = useSettingsStore((s) => s.artifactIconColorMode);
  const iconColors = useSettingsStore((s) => s.artifactIconColors);
  const type = treeNode?.type ?? null;
  const title = treeNode?.title ?? "";

  const open = useCallback(() => {
    if (type === null || !isOpenableEpicNodeKind(type)) return;
    openTilePreviewInTab(
      viewTabId,
      makeOpenableNodeRef({
        id: childId,
        instanceId: uuidv4(),
        type,
        name: title,
        hostId,
      }),
    );
  }, [type, title, childId, viewTabId, hostId, openTilePreviewInTab]);

  // Children of an artifact are themselves artifacts; the guard keeps the row
  // type-safe and quietly drops any non-artifact node that ever appears here.
  if (treeNode === null || type === null || !isEpicArtifactKind(type)) {
    let reason = "missing tree node";
    if (treeNode !== null && type === null) {
      reason = "missing node type";
    }
    if (treeNode !== null && type !== null) {
      reason = `non-artifact node type=${type}`;
    }
    appLogger.warn("[artifact-child-index] skipping child row", {
      childId,
      viewTabId,
      hostId,
      reason,
    });
    return null;
  }

  const Icon = EPIC_NODE_ICONS[type];
  const iconStyle =
    iconColorMode === "byType" ? { color: iconColors[type] } : undefined;
  const showStatusDot = computeArtifactNodeStatusDot(type, treeNode.status);

  return (
    <button
      type="button"
      onClick={open}
      data-testid={`artifact-child-index-row-${childId}`}
      className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/50"
    >
      <Icon className="size-4 shrink-0" style={iconStyle} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {showStatusDot && treeNode.status !== null ? (
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            STATUS_DOT_CLASSES[treeNode.status] ?? "bg-slate-400",
          )}
        />
      ) : null}
    </button>
  );
}
