import { useMemo, type ReactNode } from "react";
import { CloudDownload, Info } from "lucide-react";
import {
  SwitcherListEmpty,
  SwitcherListRow,
} from "@/components/epic-canvas/mobile/switcher-list-row";
import { useSwitcherActivate } from "@/components/epic-canvas/mobile/use-switcher-activate";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicFiles } from "@/lib/epic-selectors";
import {
  buildEpicFilesGroups,
  epicFileDownloadsOnOpen,
  epicFileFolder,
  type EpicFileItem,
  type EpicFilesGroup,
} from "@/lib/files/epic-files-model";
import { formatByteSize } from "@/lib/format-byte-size";
import { formatCount } from "@/lib/format-count";
import { formatCompactRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { makeEpicFileTileRef } from "@/stores/epics/canvas/tile-schema/epic-file-tile";
import { useIsActiveTile } from "@/stores/epics/canvas/canvas-selectors";

interface SwitcherFilesListProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/** The phone's note is the desktop's without the private-chat clause (MobileFiles). */
export const SWITCHER_FILES_NOTE = "Everyone in this task can see these files.";

/**
 * Pages and MCP apps keep their groups; every drop-zone folder collapses into
 * one "Other files" group, whose rows say which folder they came from. A phone
 * list has no room for a folder tree, and the row's second line carries what
 * the tree's nesting did.
 */
function phoneGroups(
  groups: readonly EpicFilesGroup[],
): readonly EpicFilesGroup[] {
  const kept = groups.filter(
    (group) => group.kind === "pages" || group.kind === "mcp-apps",
  );
  const others = groups
    .filter((group) => group.kind === "folder" || group.kind === "root")
    .flatMap((group) => group.items);
  if (others.length === 0) return kept;
  return [
    ...kept,
    { kind: "root", id: "other", label: "Other files", items: others },
  ];
}

function secondaryLabel(item: EpicFileItem, group: EpicFilesGroup): string {
  const entry = item.record.entry;
  const age = formatCompactRelativeTime(entry.createdAt, Date.now());
  if (group.kind === "pages") {
    const versions = item.earlier.length + 1;
    return versions > 1 ? `${versions} versions · ${age}` : age;
  }
  if (group.kind === "mcp-apps") return age;
  const parts: string[] = [];
  const folder = epicFileFolder(item.path);
  if (folder !== "") parts.push(folder);
  parts.push(formatByteSize(entry.byteLength));
  if (epicFileDownloadsOnOpen(item.record)) parts.push("downloads on open");
  return parts.join(" · ");
}

/**
 * Files category of the Switch-tab sheet (MobileFiles): the desktop panel's
 * model, drawn as flat rows with a second line instead of a tree.
 */
export function SwitcherFilesList(props: SwitcherFilesListProps): ReactNode {
  const files = useEpicFiles();
  const groups = useMemo(
    () => phoneGroups(buildEpicFilesGroups(files.records)),
    [files.records],
  );
  if (!files.served) {
    return (
      <SwitcherListEmpty
        message="Files aren't available on this host."
        description="Update the host to see this task's files."
      />
    );
  }
  if (groups.length === 0) {
    return (
      <SwitcherListEmpty
        message="No files yet."
        description="Pages an agent shows and files in the task's files folder appear here."
      />
    );
  }
  return (
    <div
      data-testid="switcher-files-list"
      className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain p-1 pb-safe-bottom"
    >
      <p className="flex gap-2 px-3 pt-2 pb-1 text-ui-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {SWITCHER_FILES_NOTE}
      </p>
      {groups.map((group, index) => (
        <section
          key={group.id}
          aria-label={group.label}
          className={cn(index > 0 && "mt-1.5")}
        >
          <h3 className="sticky top-0 z-10 flex items-center justify-between bg-popover px-3 pt-2 pb-1 text-overline text-muted-foreground">
            <span>{group.label}</span>
            <span>{formatCount(group.items.length)}</span>
          </h3>
          {group.items.map((item) => (
            <SwitcherFileRow
              key={item.path}
              epicId={props.epicId}
              tabId={props.tabId}
              group={group}
              item={item}
              onClose={props.onClose}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function SwitcherFileRow(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly group: EpicFilesGroup;
  readonly item: EpicFileItem;
  readonly onClose: () => void;
}): ReactNode {
  const { item } = props;
  const hostId = useCanvasHostId();
  const activate = useSwitcherActivate(props.tabId, props.onClose);
  const active = useIsActiveTile(props.tabId, item.path, hostId);
  const Icon = item.viewer.Icon;
  return (
    <SwitcherListRow
      icon={<Icon className={cn("size-4", item.viewer.iconClassName)} />}
      label={item.name}
      secondaryLabel={secondaryLabel(item, props.group)}
      badge={
        epicFileDownloadsOnOpen(item.record) ? (
          <CloudDownload
            className="size-4 shrink-0 text-muted-foreground"
            aria-label="Downloads on first open"
          />
        ) : null
      }
      active={active}
      onSelect={() => {
        if (hostId === null) return;
        activate(() =>
          makeEpicFileTileRef({
            path: item.path,
            sha256: item.record.entry.sha256,
            name: item.name,
            hostId,
            via: null,
          }),
        );
      }}
      actions={null}
      selectTestId={`switcher-file-${item.path}`}
    />
  );
}
