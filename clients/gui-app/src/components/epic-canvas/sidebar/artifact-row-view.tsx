import type { MouseEvent, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { LazySidebarTooltipWrapper } from "@/components/epic-canvas/sidebar/lazy-sidebar-hover";
import { TreeChevron, TreeChevronSpacer } from "@/components/ui/tree-chevron";
import { STATUS_DOT_CLASSES, STATUS_LABELS } from "./epic-sidebar-tree-shared";
import { cn } from "@/lib/utils";

export type ArtifactUnreadMarkerVariant = "self" | "descendant";

export interface ArtifactRowViewProps {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly onToggle: (event: MouseEvent<HTMLSpanElement>) => void;
  /** The selection checkbox in bulk-selection mode, between chevron and body. */
  readonly selection: ReactNode;
  readonly Icon: LucideIcon;
  readonly artifactIconColorMode: "byType" | "none";
  readonly iconStyle: { color: string | undefined } | undefined;
  readonly statusValue: number | null;
  readonly showStatusDot: boolean;
  readonly unreadMarkerVariant: ArtifactUnreadMarkerVariant | null;
}

/**
 * What an artifact row draws inside its row element: chevron, unread marker,
 * icon, name and status dot.
 *
 * Presentational on purpose: the artifact tree wraps it in its draggable
 * button (or its selection label) and keeps every data and dnd concern, and
 * the sample workspace's sidebar draws the same row from sample data, so the
 * two pictures of an artifact row cannot drift (F3).
 */
export function ArtifactRowView(props: ArtifactRowViewProps): ReactNode {
  return (
    <>
      {props.hasChildren ? (
        <TreeChevron expanded={props.expanded} onToggle={props.onToggle} />
      ) : (
        <TreeChevronSpacer />
      )}
      {props.selection}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <ArtifactUnreadMarker
          nodeId={props.nodeId}
          variant={props.unreadMarkerVariant}
        />
        <ArtifactNodeIcon
          Icon={props.Icon}
          artifactIconColorMode={props.artifactIconColorMode}
          iconStyle={props.iconStyle}
        />
        <span className="min-w-0 flex-1 truncate">{props.nodeName}</span>
        <ArtifactStatusDot
          nodeId={props.nodeId}
          statusValue={props.statusValue}
          showStatusDot={props.showStatusDot}
        />
      </span>
    </>
  );
}

export function ArtifactNodeIcon(props: {
  readonly Icon: LucideIcon;
  readonly artifactIconColorMode: "byType" | "none";
  readonly iconStyle: { color: string | undefined } | undefined;
}): ReactNode {
  const Icon = props.Icon;
  return (
    <Icon
      className={cn(
        "size-3.5 shrink-0",
        props.artifactIconColorMode === "none" && "text-muted-foreground/70",
      )}
      style={props.iconStyle}
    />
  );
}

export function ArtifactUnreadMarker(props: {
  readonly nodeId: string;
  readonly variant: ArtifactUnreadMarkerVariant | null;
}): ReactNode {
  if (props.variant === null) {
    // Reserve the bar's footprint so the icon column stays aligned and a row
    // never shifts horizontally as it toggles read/unread.
    return <span aria-hidden className="h-4 w-0.5 shrink-0" />;
  }
  const label =
    props.variant === "self" ? "Unread artifact" : "Contains unread artifacts";
  return (
    <LazySidebarTooltipWrapper
      label={label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        aria-label={label}
        data-testid={`epic-sidebar-unread-${props.nodeId}`}
        data-unread-marker={props.variant}
        className={cn(
          "h-4 w-0.5 shrink-0 rounded-full",
          props.variant === "self" ? "bg-info" : "bg-info/50",
        )}
      />
    </LazySidebarTooltipWrapper>
  );
}

function ArtifactStatusDot(props: {
  readonly nodeId: string;
  readonly statusValue: number | null;
  readonly showStatusDot: boolean;
}): ReactNode {
  const { nodeId, statusValue, showStatusDot } = props;
  if (statusValue === null || !showStatusDot) return null;
  return (
    <LazySidebarTooltipWrapper
      label={STATUS_LABELS[statusValue] ?? "Unknown"}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          STATUS_DOT_CLASSES[statusValue] ?? "bg-muted-foreground",
        )}
        data-testid={`epic-sidebar-status-dot-${nodeId}`}
        aria-hidden
      />
    </LazySidebarTooltipWrapper>
  );
}
