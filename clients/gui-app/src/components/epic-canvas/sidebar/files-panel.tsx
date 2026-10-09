import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AppWindow,
  CloudDownload,
  FileCode,
  Folder,
  FolderOpen,
  Info,
  Layers,
  type LucideIcon,
} from "lucide-react";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import {
  artifactRowClassName,
  BASE_PAD_LEFT,
  INDENT_PX,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { MiddleTruncatedText } from "@/components/files/middle-truncated-text";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { TreeChevron, TreeChevronSpacer } from "@/components/ui/tree-chevron";
import { useOpenEpicFileTile } from "@/hooks/files/use-open-epic-file-tile";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useEpicFiles } from "@/lib/epic-selectors";
import {
  buildEpicFilesGroups,
  epicFileDownloadsOnOpen,
  epicFileTitle,
  type EpicFileItem,
  type EpicFilesGroup,
} from "@/lib/files/epic-files-model";
import { formatCount } from "@/lib/format-count";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { useIsActiveTile } from "@/stores/epics/canvas/canvas-selectors";

/** The note under the header: pages from private chats are visible too (D21). */
export const FILES_SHARED_NOTE =
  "Everyone in this task can see these files, also pages from private chats.";

/** Rows past this many render only what is on screen. */
export const FILES_VIRTUALIZE_AFTER_ROWS = 150;
/** A row's `h-7` plus the `space-y-0.5` gap the plain list draws. */
const ROW_PITCH_PX = 30;
const VIRTUAL_OVERSCAN = 12;
/** The window drawn before the list is first measured: a sidebar's worth. */
const VIRTUAL_INITIAL_RECT = { width: 0, height: 20 * ROW_PITCH_PX };
/** File names differ at the end: this many trailing characters never truncate. */
const NAME_TAIL_CHARS = 12;

interface GroupDisplay {
  readonly Icon: LucideIcon;
  /** The group icon's colour: the same chart tokens the file kinds use. */
  readonly iconClassName: string;
  /** Pages and MCP apps show how many they hold; folders do not (Main). */
  readonly showCount: boolean;
  readonly startsExpanded: boolean;
}

function groupDisplay(group: EpicFilesGroup): GroupDisplay {
  switch (group.kind) {
    case "pages":
      return {
        Icon: Layers,
        iconClassName: "text-[var(--term-ansi-cyan)]",
        showCount: true,
        startsExpanded: true,
      };
    case "mcp-apps":
      return {
        Icon: AppWindow,
        iconClassName: "text-[var(--term-ansi-magenta)]",
        showCount: true,
        startsExpanded: false,
      };
    case "folder":
    case "root":
      return {
        Icon: Folder,
        iconClassName: "text-muted-foreground/70",
        showCount: false,
        startsExpanded: true,
      };
  }
}

/** One line of the tree, flattened so a long list can render only its window. */
type FilesRow =
  | {
      readonly kind: "group";
      readonly key: string;
      readonly group: EpicFilesGroup;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "file";
      readonly key: string;
      readonly item: EpicFileItem;
      /** 1 for a file, 2 for one of its earlier versions. */
      readonly depth: number;
    };

function flattenRows(
  groups: readonly EpicFilesGroup[],
  toggled: ReadonlySet<string>,
): readonly FilesRow[] {
  const rows: FilesRow[] = [];
  for (const group of groups) {
    const expanded =
      groupDisplay(group).startsExpanded !== toggled.has(group.id);
    rows.push({ kind: "group", key: `group:${group.id}`, group, expanded });
    if (!expanded) continue;
    for (const item of group.items) {
      rows.push({ kind: "file", key: item.path, item, depth: 1 });
      for (const version of item.earlier) {
        rows.push({ kind: "file", key: version.path, item: version, depth: 2 });
      }
    }
  }
  return rows;
}

/**
 * The Files panel (Main): the epic's files, shared with the whole task, grouped
 * as Pages, MCP apps and the drop-zone folders, with an edited page's earlier
 * versions as child rows. Rows are the artifact tree's rows - same height,
 * indent, chevron and active fill - so the two panels read as one family.
 * A row names a file by its manifest title, falling back to the file name.
 *
 * Reads the files lane only. A host that predates it never serves the set
 * (`served` stays false), and the panel says so rather than claiming the task
 * has no files.
 */
export function FilesPanelBody(props: LeftPanelSlotProps): ReactNode {
  const { epicId, tabId } = props;
  const files = useEpicFiles();
  // The body mounts when the panel is shown and expanded: that is an open.
  useEffect(() => {
    Analytics.getInstance().track(AnalyticsEvent.FilesPanelOpened, null);
  }, []);
  const groups = useMemo(
    () => buildEpicFilesGroups(files.records),
    [files.records],
  );
  /** Groups the reader flipped away from their starting state. */
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => flattenRows(groups, toggled), [groups, toggled]);
  if (!files.served) {
    return (
      <SidebarPanelEmptyState
        icon={FolderOpen}
        title="Files aren't available on this host."
        description="Update the host to see this task's files."
        testId="epic-files-unserved"
      />
    );
  }
  if (groups.length === 0) {
    return (
      <SidebarPanelEmptyState
        icon={FolderOpen}
        title="No files yet."
        description="Pages an agent shows and files in the task's files folder appear here."
        testId="epic-files-empty"
      />
    );
  }
  const toggle = (groupId: string): void => {
    setToggled((current) => {
      const next = new Set(current);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });
  };
  const renderRow = (row: FilesRow): ReactNode =>
    row.kind === "group" ? (
      <FilesGroupRow
        group={row.group}
        expanded={row.expanded}
        onToggle={() => toggle(row.group.id)}
      />
    ) : (
      <FileRow
        epicId={epicId}
        tabId={tabId}
        item={row.item}
        depth={row.depth}
      />
    );
  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
        <p className="flex items-start gap-1.5 px-2 pt-1 pb-2 text-ui-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 opacity-70" aria-hidden />
          <span>{FILES_SHARED_NOTE}</span>
        </p>
        {rows.length > FILES_VIRTUALIZE_AFTER_ROWS ? (
          <VirtualFilesTree rows={rows} renderRow={renderRow} />
        ) : (
          <div
            role="tree"
            aria-label="Epic files tree"
            className="space-y-0.5 overflow-y-auto"
          >
            {rows.map((row) => (
              <FilesTreeItem key={row.key} row={row}>
                {renderRow(row)}
              </FilesTreeItem>
            ))}
          </div>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** A flat tree's item: its level says where it sits (WAI-ARIA tree). */
function FilesTreeItem(props: {
  readonly row: FilesRow;
  readonly children: ReactNode;
}): ReactNode {
  const { row } = props;
  return (
    <div
      role="treeitem"
      aria-selected={false}
      aria-level={row.kind === "group" ? 1 : row.depth + 1}
      aria-expanded={row.kind === "group" ? row.expanded : undefined}
    >
      {props.children}
    </div>
  );
}

/**
 * The same rows, only those on screen mounted: a task can hold thousands of
 * pages. Tab still walks the mounted rows in order, and the browser scrolls a
 * focused row into view, which brings the next window in with it.
 */
function VirtualFilesTree(props: {
  readonly rows: readonly FilesRow[];
  readonly renderRow: (row: FilesRow) => ReactNode;
}): ReactNode {
  const { rows } = props;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // `useVirtualizer` returns fresh function identities each render, so the
  // React Compiler skips this component; nothing it returns is passed to a
  // memoized child, so the compat warning is noise (as in the worktrees list).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_PITCH_PX,
    getItemKey: (index) => rows[index].key,
    overscan: VIRTUAL_OVERSCAN,
    initialRect: VIRTUAL_INITIAL_RECT,
  });
  return (
    <div
      ref={setScroller}
      role="tree"
      aria-label="Epic files tree"
      data-testid="epic-files-virtual-tree"
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div
        role="presentation"
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtual) => {
          const row = rows[virtual.index];
          return (
            <div
              key={virtual.key}
              role="presentation"
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtual.start}px)` }}
            >
              <FilesTreeItem row={row}>{props.renderRow(row)}</FilesTreeItem>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilesGroupRow(props: {
  readonly group: EpicFilesGroup;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const { group } = props;
  const display = groupDisplay(group);
  const Icon = display.Icon;
  return (
    // A folder's path can outrun the row; the kinds' own labels cannot.
    <TooltipWrapper
      label={group.kind === "folder" ? group.label : null}
      side="right"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        data-testid={`epic-files-group-${group.id}`}
        className={cn(
          artifactRowClassName({
            isDragging: false,
            padRightClass: "pr-2",
            selectionMode: false,
            isActive: false,
          }),
          "w-full",
        )}
        style={{ paddingLeft: `${BASE_PAD_LEFT}px` }}
        onClick={props.onToggle}
      >
        <TreeChevron expanded={props.expanded} onToggle={undefined} />
        <Icon
          className={cn("size-3.5 shrink-0", display.iconClassName)}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        {display.showCount ? (
          <span className="shrink-0 text-ui-xs text-muted-foreground tabular-nums">
            {formatCount(group.items.length)}
          </span>
        ) : null}
      </button>
    </TooltipWrapper>
  );
}

function FileRow(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly item: EpicFileItem;
  /** 1 for a file, 2 for one of its earlier versions. */
  readonly depth: number;
}): ReactNode {
  const { item } = props;
  const earlier = props.depth > 1;
  const hostId = useCanvasHostId();
  const openFile = useOpenEpicFileTile(props.epicId, hostId ?? "");
  const isActive = useIsActiveTile(props.tabId, item.path, hostId);
  const Icon = earlier ? FileCode : item.viewer.Icon;
  return (
    // The full path: the label is a title, or truncated, or both.
    <TooltipWrapper
      label={item.path}
      side="right"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        disabled={hostId === null}
        data-testid={`epic-files-item-${item.path}`}
        data-sidebar-node-id={item.path}
        aria-current={isActive ? "true" : undefined}
        className={cn(
          artifactRowClassName({
            isDragging: false,
            padRightClass: "pr-2",
            selectionMode: false,
            isActive,
          }),
          "w-full",
        )}
        style={{
          paddingLeft: `${props.depth * INDENT_PX + BASE_PAD_LEFT}px`,
        }}
        onClick={() =>
          openFile({
            path: item.path,
            sha256: item.record.entry.sha256,
            name: item.name,
          })
        }
      >
        <TreeChevronSpacer />
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            earlier ? "text-muted-foreground/70" : item.viewer.iconClassName,
          )}
          aria-hidden
        />
        <FileLabel item={item} earlier={earlier} />
        {epicFileDownloadsOnOpen(item.record) ? (
          <CloudDownload
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label="Downloads on first open"
          />
        ) : (
          <FileAge timestamp={item.record.entry.createdAt} muted={!isActive} />
        )}
      </button>
    </TooltipWrapper>
  );
}

/**
 * A row's name. A title reads from its start, so it truncates at the end; a
 * bare file name differs at its end, so it loses its middle instead.
 */
function FileLabel(props: {
  readonly item: EpicFileItem;
  readonly earlier: boolean;
}): ReactNode {
  if (props.earlier) {
    return (
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        Earlier version
      </span>
    );
  }
  if (epicFileTitle(props.item.record) !== null) {
    return <span className="min-w-0 flex-1 truncate">{props.item.name}</span>;
  }
  return (
    <MiddleTruncatedText
      text={props.item.name}
      tailLength={NAME_TAIL_CHARS}
      className="flex-1"
    />
  );
}

/** A leaf so the shared minute tick repaints the label, not the whole row. */
function FileAge(props: {
  readonly timestamp: number;
  readonly muted: boolean;
}): ReactNode {
  const label = useCompactRelativeTime(props.timestamp);
  return (
    <span
      className={cn(
        "shrink-0 text-ui-xs",
        props.muted ? "text-muted-foreground" : "opacity-75",
      )}
    >
      {label}
    </span>
  );
}
