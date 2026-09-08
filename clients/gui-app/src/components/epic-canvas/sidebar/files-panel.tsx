/**
 * The `Files` left panel: the epic-files manifest (D02) as a grouped list.
 *
 * Reads the projector's `files` slice - the SECOND observation root, a sibling
 * map on the epic root doc - so a remote manifest change re-renders these rows
 * without a full epic re-projection.
 *
 * A row opens the ticket-14 `epic-file` tile through
 * `useEpicTileNavigation().openTile`, the ESLint-enforced opening seam. Every
 * secondary action (download, delete, restore, open in browser) lives on that
 * tile, not here: the panel is a list, and duplicating the actions would give
 * the same operation two homes that have to agree.
 */
import {
  useCallback,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { FolderOpen, TriangleAlert, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@/components/ui/sidebar";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useEpicFileRefusals } from "@/hooks/epic/use-epic-file-refusals";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { makeEpicFileTileRef } from "@/stores/epics/canvas/tile-schema/epic-file-tile";
import { formatByteSize } from "@/lib/format-byte-size";
import {
  epicFileBadgedStatus,
  epicFileIcon,
  epicFileName,
  epicFileProducerIcon,
  epicFileProducerLabel,
  groupEpicFiles,
  totalEpicFileBytes,
  type EpicFileGroup,
} from "@/lib/epic-files/file-rows";
import { cn } from "@/lib/utils";
import type { EpicFileRecord } from "@/stores/epics/open-epic/types";

/**
 * D06, stated where the files are: epic permission is the only gate, so a
 * capture taken in a primary-profile browser tab is visible to every
 * collaborator. Said up front rather than at capture time - by then the bytes
 * are already on the plane.
 */
const SHARING_NOTE =
  "Everyone who can open this epic can read these files, including captures taken in your primary browser profile.";

/**
 * A runtime-chosen icon has to be rendered OUTSIDE the component that picked
 * it: `react(static-components)` reads a capitalized local used as a JSX tag
 * inside a component as a component minted during render. Same shape as
 * `epicNodeIcon` in the mention display.
 */
function renderIcon(Icon: LucideIcon, className: string): ReactElement {
  return <Icon className={className} aria-hidden />;
}

interface FileRowProps {
  readonly record: EpicFileRecord;
  readonly isDeleted: boolean;
  readonly onOpen: (path: string) => void;
}

function FileRow(props: FileRowProps) {
  const { record, isDeleted, onOpen } = props;
  const name = epicFileName(record.path);
  const icon = epicFileIcon(record.entry.current.mediaType);
  const producerIcon = epicFileProducerIcon(record);
  const status = epicFileBadgedStatus(record);
  const size = formatByteSize(record.entry.current.byteLength);
  // One accessible name carrying everything the row shows in glyphs, so the
  // producer and the status are readable without a tooltip per icon.
  const label = [
    name,
    epicFileProducerLabel(record),
    size,
    status === null ? null : status,
    isDeleted ? "deleted" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  return (
    <li>
      <button
        type="button"
        aria-label={label}
        data-testid={`epic-files-row-${record.path}`}
        onClick={() => onOpen(record.path)}
        className={cn(
          "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-ui-sm outline-none",
          "text-foreground/75 transition-colors duration-100 hover:bg-accent/70 hover:text-accent-foreground",
          "focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          isDeleted && "text-muted-foreground line-through",
        )}
      >
        {renderIcon(icon, "size-4 shrink-0 text-muted-foreground")}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {renderIcon(producerIcon, "size-3.5 shrink-0 text-muted-foreground/70")}
        <span className="shrink-0 text-ui-xs text-muted-foreground tabular-nums">
          {size}
        </span>
        {status === null ? null : (
          <Badge variant="outline" className="shrink-0">
            {status}
          </Badge>
        )}
      </button>
    </li>
  );
}

interface FileGroupProps {
  readonly group: EpicFileGroup;
  readonly isDeleted: boolean;
  readonly onOpen: (path: string) => void;
}

function FileGroup(props: FileGroupProps) {
  const { group, isDeleted, onOpen } = props;
  return (
    <li>
      <SidebarGroupLabel className="h-6 px-2">{group.label}</SidebarGroupLabel>
      <ul className="space-y-0.5">
        {group.records.map((record) => (
          <FileRow
            key={record.path}
            record={record}
            isDeleted={isDeleted}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </li>
  );
}

export function FilesPanelBody(props: LeftPanelSlotProps) {
  const { epicId, tabId } = props;
  const files = useEpicStore((state) => state.files);
  const refusals = useEpicFileRefusals(epicId);
  // System-produced folders and tombstones are both off by default: the first
  // would bury the user's own files under capture output, the second is a
  // restore affordance rather than a listing (D25).
  const [showSystem, setShowSystem] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const { openTile } = useEpicTileNavigation();
  // The sidebar sits outside every per-tile `<TabHostProvider>`, so the tile's
  // host is the EPIC SESSION's host - the same machine `epic.readFile` will be
  // asked for the bytes on. `null` only while no host serves this epic at all,
  // which is also when there is nothing to read.
  const hostId = useCanvasHostId();

  const openFile = useCallback(
    (path: string): void => {
      if (hostId === null) return;
      openTile(
        tileIntent(
          makeEpicFileTileRef({ hostId, epicId, path }),
          { tabId },
          "single",
          "direct_ui",
        ),
      );
    },
    [epicId, hostId, openTile, tabId],
  );

  const groups = useMemo(
    () => groupEpicFiles(files.records, showSystem),
    [files.records, showSystem],
  );
  const deletedGroups = useMemo(
    () => (showDeleted ? groupEpicFiles(files.deleted, true) : []),
    [files.deleted, showDeleted],
  );
  const storageUsed = useMemo(() => totalEpicFileBytes(files), [files]);

  const hasAnything = files.records.length > 0 || files.deleted.length > 0;
  const hasVisibleRows = groups.length > 0 || deletedGroups.length > 0;

  let listContent: ReactNode;
  if (!hasAnything) {
    listContent = (
      <SidebarPanelEmptyState
        icon={FolderOpen}
        title="No files yet."
        description="Drop a file into the epic's files/ folder, or capture one from a browser tab."
        testId="epic-files-empty"
      />
    );
  } else if (!hasVisibleRows) {
    listContent = (
      <SidebarPanelEmptyState
        icon={FolderOpen}
        title="Nothing to show."
        description="Every file here is a recording, an artifact image or deleted. Use the toggles above to reveal them."
        testId="epic-files-filter-empty"
      />
    );
  } else {
    listContent = (
      <ul aria-label="Epic files" className="space-y-1">
        {groups.map((group) => (
          <FileGroup
            key={group.id}
            group={group}
            isDeleted={false}
            onOpen={openFile}
          />
        ))}
        {deletedGroups.map((group) => (
          <FileGroup
            key={`deleted:${group.id}`}
            group={group}
            isDeleted
            onOpen={openFile}
          />
        ))}
      </ul>
    );
  }

  return (
    <SidebarGroup className="min-h-0 flex-1 gap-2 px-2 py-1">
      <p className="px-2 text-ui-xs text-muted-foreground/70">
        {/* "used", never "live": deleted bytes keep counting until the epic
            itself is deleted (D25), and calling it live would read as a bug. */}
        {formatByteSize(storageUsed)} used. {SHARING_NOTE}
      </p>
      <div className="flex flex-wrap gap-1 px-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={showSystem}
          onClick={() => setShowSystem((shown) => !shown)}
        >
          Recordings and artifact images
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={showDeleted}
          onClick={() => setShowDeleted((shown) => !shown)}
        >
          Deleted
        </Button>
      </div>
      {refusals.length === 0 ? null : (
        <ul aria-label="Refused files" className="space-y-1 px-1">
          {refusals.map((refusal) => (
            <li
              key={refusal.id}
              className="flex items-start gap-1.5 text-ui-xs text-muted-foreground"
            >
              <TriangleAlert
                className="mt-0.5 size-3.5 shrink-0 text-destructive"
                aria-hidden
              />
              <span className="min-w-0">
                <span className="font-medium text-foreground/80">
                  {refusal.name}
                </span>{" "}
                {refusal.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {listContent}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
