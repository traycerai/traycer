import { useMemo, useState, type ReactNode } from "react";
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
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { TreeChevron, TreeChevronSpacer } from "@/components/ui/tree-chevron";
import { useOpenEpicFileTile } from "@/hooks/files/use-open-epic-file-tile";
import { useEpicFiles } from "@/lib/epic-selectors";
import {
  buildEpicFilesGroups,
  epicFileDownloadsOnOpen,
  type EpicFileItem,
  type EpicFilesGroup,
} from "@/lib/files/epic-files-model";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { useIsActiveTile } from "@/stores/epics/canvas/canvas-selectors";

/** The note under the header: pages from private chats are visible too (D21). */
export const FILES_SHARED_NOTE =
  "Everyone in this task can see these files, also pages from private chats.";

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

/**
 * The Files panel (Main): the epic's files, shared with the whole task, grouped
 * as Pages, MCP apps and the drop-zone folders, with an edited page's earlier
 * versions as child rows. Rows are the artifact tree's rows - same height,
 * indent, chevron and active fill - so the two panels read as one family.
 *
 * Reads the files lane only. A host that predates it never serves the set
 * (`served` stays false), and the panel says so rather than claiming the task
 * has no files.
 */
export function FilesPanelBody(props: LeftPanelSlotProps): ReactNode {
  const { epicId, tabId } = props;
  const files = useEpicFiles();
  const groups = useMemo(
    () => buildEpicFilesGroups(files.records),
    [files.records],
  );
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
  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
        <p className="flex items-start gap-1.5 px-2 pt-1 pb-2 text-ui-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 opacity-70" aria-hidden />
          <span>{FILES_SHARED_NOTE}</span>
        </p>
        <ul
          role="tree"
          aria-label="Epic files tree"
          className="space-y-0.5 overflow-y-auto"
        >
          {groups.map((group) => (
            <FilesGroupNode
              key={group.id}
              epicId={epicId}
              tabId={tabId}
              group={group}
            />
          ))}
        </ul>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function FilesGroupNode(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly group: EpicFilesGroup;
}): ReactNode {
  const { group } = props;
  const display = groupDisplay(group);
  const [expanded, setExpanded] = useState(display.startsExpanded);
  const Icon = display.Icon;
  return (
    <li role="treeitem" aria-selected={false} aria-expanded={expanded}>
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
        onClick={() => setExpanded((value) => !value)}
      >
        <TreeChevron expanded={expanded} onToggle={undefined} />
        <Icon
          className={cn("size-3.5 shrink-0", display.iconClassName)}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        {display.showCount ? (
          <span className="shrink-0 text-ui-xs text-muted-foreground">
            {group.items.length}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <ul role="group" className="space-y-0.5">
          {group.items.map((item) => (
            <FileNode
              key={item.path}
              epicId={props.epicId}
              tabId={props.tabId}
              item={item}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FileNode(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly item: EpicFileItem;
}): ReactNode {
  const { item } = props;
  return (
    <li role="treeitem" aria-selected={false}>
      <FileRow
        epicId={props.epicId}
        tabId={props.tabId}
        item={item}
        depth={1}
        label={item.name}
        earlier={false}
      />
      {item.earlier.length > 0 ? (
        <ul role="group" className="space-y-0.5">
          {item.earlier.map((version) => (
            <li key={version.path} role="treeitem" aria-selected={false}>
              <FileRow
                epicId={props.epicId}
                tabId={props.tabId}
                item={version}
                depth={2}
                label="Earlier version"
                earlier
              />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FileRow(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly item: EpicFileItem;
  readonly depth: number;
  readonly label: string;
  readonly earlier: boolean;
}): ReactNode {
  const { item } = props;
  const hostId = useCanvasHostId();
  const openFile = useOpenEpicFileTile(props.epicId, hostId ?? "");
  const isActive = useIsActiveTile(props.tabId, item.path, hostId);
  const Icon = props.earlier ? FileCode : item.viewer.Icon;
  return (
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
        openFile({ path: item.path, sha256: item.record.entry.sha256 })
      }
    >
      <TreeChevronSpacer />
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          props.earlier
            ? "text-muted-foreground/70"
            : item.viewer.iconClassName,
        )}
        aria-hidden
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          props.earlier && "text-muted-foreground",
        )}
      >
        {props.label}
      </span>
      {epicFileDownloadsOnOpen(item.record) ? (
        <CloudDownload
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-label="Downloads on first open"
        />
      ) : (
        <FileAge timestamp={item.record.entry.createdAt} muted={!isActive} />
      )}
    </button>
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
