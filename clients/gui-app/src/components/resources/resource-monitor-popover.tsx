import { useEffect, useMemo, useState } from "react";
import { useNavigate, type UseNavigateResult } from "@tanstack/react-router";
import { v4 as uuidv4 } from "uuid";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowDownNarrowWide,
  ChevronDown,
  ChevronRight,
  Cpu,
  Monitor,
  Server,
} from "lucide-react";
import type {
  OwnerResourceSnapshotWire,
  ResourceOwnerKindWire,
  ResourceProcessSnapshotWire,
} from "@traycer/protocol/host/resources/subscribe";
import type { EpicNodeRecord } from "@/lib/artifacts/node-display";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  useGlobalResourceProjection,
  type GlobalResourceEpicEntry,
} from "@/stores/resources/resources-registry";
import type {
  AppResourceUsage,
  TaskResourceSummary,
} from "@/stores/resources/resources-store";
import {
  formatCpuPercent,
  formatMemoryBytes,
  formatProcessCount,
} from "@/lib/resources/format-resource-usage";
import {
  desktopAppResourceUsageFromMetrics,
  getDesktopDiagnosticsBridge,
  type DesktopAppProcessGroupUsage,
  type DesktopAppResourceUsage,
} from "@/lib/resources/desktop-app-resource-usage";
import {
  existingEpicTabIntent,
  navigateToTabIntent,
  openOrFocusEpicIntent,
} from "@/lib/tab-navigation";
import { cn } from "@/lib/utils";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicNodeRef,
  EpicViewTab,
} from "@/stores/epics/canvas/types";

type ResourceSortOption = "memory" | "cpu" | "name" | "tab";
type NavigateFn = UseNavigateResult<string>;

const SORT_LABELS: Record<ResourceSortOption, string> = {
  memory: "Memory",
  cpu: "CPU",
  name: "Name",
  tab: "Tab order",
};

const METRIC_COLS = "flex shrink-0 items-center tabular-nums tracking-tight";
const CPU_COL = "w-14 text-right";
const MEM_COL = "w-20 text-right";
const DESKTOP_RESOURCE_SAMPLE_INTERVAL_MS = 1000;
const EMPTY_RESOURCE_SUMMARY: TaskResourceSummary = {
  cpuPercent: 0,
  rssBytes: 0,
  trackedProcessCount: 0,
  openTerminalCount: 0,
  tuiAgentCount: 0,
  guiAgentCount: 0,
};

interface ResourceMonitorPopoverProps {
  readonly className: string | undefined;
}

interface CanvasResourceSnapshot {
  readonly openTabOrder: readonly string[];
  readonly tabsById: Readonly<Record<string, EpicViewTab | undefined>>;
  readonly canvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>;
  readonly artifactTreeByEpicId: Readonly<
    Record<string, readonly EpicNodeRecord[] | undefined>
  >;
}

interface OpenOwnerLocation {
  readonly epicId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly tileTabId: string;
  readonly ref: EpicNodeRef;
}

interface CanvasResourceIndex {
  readonly locationByOwner: ReadonlyMap<string, OpenOwnerLocation>;
  readonly tabOrderByOwner: ReadonlyMap<string, number>;
}

interface CanvasOwnerCandidate {
  readonly key: string;
  readonly location: OpenOwnerLocation | null;
}

interface OwnerDisplayRow {
  readonly snapshot: OwnerResourceSnapshotWire;
  readonly label: string;
  readonly canOpen: boolean;
  readonly tabOrder: number;
  readonly location: OpenOwnerLocation | null;
}

interface TaskDisplayRow {
  readonly entry: GlobalResourceEpicEntry;
  readonly label: string;
  readonly tabOrder: number;
  readonly owners: readonly OwnerDisplayRow[];
}

interface DesktopResourceSummary {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
}

export function ResourceMonitorPopover(props: ResourceMonitorPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label="Resources"
        side="top"
        sideOffset={6}
        align={undefined}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Resources"
            data-testid="resource-monitor-header-button"
            className={cn(
              "text-muted-foreground hover:text-foreground",
              props.className,
            )}
          >
            <Cpu className="size-3.5" />
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>

      {open ? <ResourceMonitorContent onClose={() => setOpen(false)} /> : null}
    </Popover>
  );
}

function ResourceMonitorContent(props: { readonly onClose: () => void }) {
  const [sortOption, setSortOption] = useState<ResourceSortOption>("memory");
  const [collapsedOwners, setCollapsedOwners] = useState<Set<string>>(
    () => new Set(),
  );
  const projection = useGlobalResourceProjection();
  const canvas = useResourceCanvasSnapshot();
  const navigate = useNavigate();
  const openTileInTab = useEpicCanvasStore((state) => state.openTileInTab);
  const setActiveTilePane = useEpicCanvasStore(
    (state) => state.setActiveTilePane,
  );
  const setActiveTileTab = useEpicCanvasStore(
    (state) => state.setActiveTileTab,
  );
  const desktopApp = useDesktopAppResourceUsage();
  const summary = useMemo(
    () => combineResourceSummary(projection.summary, desktopApp),
    [desktopApp, projection.summary],
  );

  const canvasIndex = useMemo(() => buildCanvasResourceIndex(canvas), [canvas]);
  const recordByOwner = useMemo(() => buildRecordByOwner(canvas), [canvas]);
  const taskRows = useMemo(
    () =>
      buildTaskRows({
        entries: projection.entries,
        canvas,
        canvasIndex,
        recordByOwner,
        sortOption,
      }),
    [canvas, canvasIndex, projection.entries, recordByOwner, sortOption],
  );

  const toggleOwner = (key: string): void => {
    setCollapsedOwners((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const openOwner = (row: OwnerDisplayRow): void => {
    const opened = openResourceOwner({
      row,
      canvas,
      openTileInTab,
      setActiveTilePane,
      setActiveTileTab,
      navigate,
    });
    if (opened) props.onClose();
  };

  const memorySharePercent =
    projection.app !== null &&
    projection.app.hostTotalMemoryBytes > 0 &&
    summary !== null
      ? (summary.rssBytes / projection.app.hostTotalMemoryBytes) * 100
      : 0;

  return (
    <PopoverContent
      align="end"
      sideOffset={8}
      collisionPadding={12}
      role="dialog"
      aria-label="Resources"
      className="w-[min(92vw,34rem)] gap-0 overflow-hidden rounded-xl p-0"
      onOpenAutoFocus={(event) => event.preventDefault()}
    >
      <div className="border-b border-border/60 px-3.5 pb-3 pt-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="truncate text-ui-sm font-medium text-foreground">
            Resources
          </h4>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-6 items-center gap-1 rounded-sm px-1.5 text-ui-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Sort resource rows"
              >
                <ArrowDownNarrowWide className="size-3.5" />
                <span>{SORT_LABELS[sortOption]}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuRadioGroup
                value={sortOption}
                onValueChange={(value) => {
                  if (isResourceSortOption(value)) setSortOption(value);
                }}
              >
                <DropdownMenuRadioItem value="memory">
                  Memory
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="cpu">CPU</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="tab">
                  Tab order
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {summary === null ? (
          <div className="mt-4 text-ui-xs text-muted-foreground">
            Waiting for resource data.
          </div>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-3 divide-x divide-border/50">
              <MetricBlock
                label="CPU"
                value={formatCpuPercent(summary.cpuPercent)}
              />
              <MetricBlock
                label="Memory"
                value={formatMemoryBytes(summary.rssBytes)}
              />
              <MetricBlock
                label="RAM share"
                value={formatCpuPercent(memorySharePercent)}
              />
            </div>
            <div
              className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-label="Tracked RAM share"
              aria-valuenow={Math.round(memorySharePercent)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-300",
                  memoryShareBarClass(memorySharePercent),
                )}
                style={{
                  width: `${Math.min(100, Math.max(0, memorySharePercent))}%`,
                }}
              />
            </div>
            <ResourceCounts summary={summary} />
          </>
        )}
      </div>

      <div className="max-h-[min(58vh,36rem)] overflow-y-auto">
        {desktopApp === null ? null : (
          <DesktopAppResourceSection app={desktopApp} />
        )}
        {projection.app === null ? null : (
          <HostAppResourceSection app={projection.app} />
        )}
        {summary === null ? null : (
          <div className="py-1">
            {taskRows.length === 0 ? (
              <div className="px-3.5 py-4 text-center text-ui-xs text-muted-foreground">
                No active task process trees.
              </div>
            ) : (
              taskRows.map((task) => (
                <TaskResourceSection
                  key={task.entry.epicId}
                  task={task}
                  collapsedOwners={collapsedOwners}
                  onToggleOwner={toggleOwner}
                  onOpenOwner={openOwner}
                />
              ))
            )}
          </div>
        )}
      </div>
    </PopoverContent>
  );
}

function useDesktopAppResourceUsage(): DesktopAppResourceUsage | null {
  const [usage, setUsage] = useState<DesktopAppResourceUsage | null>(null);

  useEffect(() => {
    const bridge = getDesktopDiagnosticsBridge();
    if (bridge === null) {
      return;
    }

    let disposed = false;
    let inFlight = false;

    const sample = (): void => {
      if (inFlight) return;
      inFlight = true;
      void bridge
        .getMetrics()
        .then(
          (snapshot) => {
            if (disposed) return;
            setUsage(desktopAppResourceUsageFromMetrics(snapshot, Date.now()));
          },
          () => {
            if (disposed) return;
            setUsage(null);
          },
        )
        .finally(() => {
          inFlight = false;
        });
    };

    sample();
    const timer = window.setInterval(
      sample,
      DESKTOP_RESOURCE_SAMPLE_INTERVAL_MS,
    );
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  return usage;
}

function useResourceCanvasSnapshot(): CanvasResourceSnapshot {
  return useEpicCanvasStore(
    useShallow((state) => ({
      openTabOrder: state.openTabOrder,
      tabsById: state.tabsById,
      canvasByTabId: state.canvasByTabId,
      artifactTreeByEpicId: state.artifactTreeByEpicId,
    })),
  );
}

function MetricBlock(props: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="min-w-0 px-3 first:pl-0 last:pr-0">
      <div className="text-ui-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </div>
      <div className="mt-1 truncate text-lg tabular-nums text-foreground">
        {props.value}
      </div>
    </div>
  );
}

function ResourceCounts(props: { readonly summary: TaskResourceSummary }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-muted-foreground">
      <span>
        {countLabel(
          props.summary.openTerminalCount,
          "open terminal",
          "open terminals",
        )}
      </span>
      <span>
        {countLabel(props.summary.tuiAgentCount, "TUI agent", "TUI agents")}
      </span>
      <span>
        {countLabel(props.summary.guiAgentCount, "GUI agent", "GUI agents")}
      </span>
    </div>
  );
}

function DesktopAppResourceSection(props: {
  readonly app: DesktopAppResourceUsage;
}) {
  const showOther =
    props.app.other.cpuPercent > 0 ||
    props.app.other.rssBytes > 0 ||
    props.app.other.processCount > 0;

  return (
    <div className="border-b border-border/60 py-1">
      <div className="flex items-center justify-between px-3.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Monitor className="size-3.5 shrink-0 text-muted-foreground/80" />
          <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
            Traycer Desktop
          </span>
        </div>
        <MetricPair
          cpuPercent={props.app.cpuPercent}
          rssBytes={props.app.rssBytes}
          className="text-ui-sm text-foreground"
        />
      </div>
      <DesktopAppProcessGroupRow label="Main" usage={props.app.main} />
      <DesktopAppProcessGroupRow label="Renderer" usage={props.app.renderer} />
      {showOther ? (
        <DesktopAppProcessGroupRow label="Other" usage={props.app.other} />
      ) : null}
    </div>
  );
}

function DesktopAppProcessGroupRow(props: {
  readonly label: string;
  readonly usage: DesktopAppProcessGroupUsage;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-1 pl-7 text-muted-foreground transition-colors hover:bg-muted/40">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-ui-xs">{props.label}</span>
      </div>
      <MetricPair
        cpuPercent={props.usage.cpuPercent}
        rssBytes={props.usage.rssBytes}
        className="text-ui-xs text-muted-foreground/80"
      />
    </div>
  );
}

function HostAppResourceSection(props: { readonly app: AppResourceUsage }) {
  return (
    <div className="border-b border-border/60 py-1">
      <div className="flex items-center justify-between px-3.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Server className="size-3.5 shrink-0 text-muted-foreground/80" />
          <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
            Traycer Host
          </span>
        </div>
        <MetricPair
          cpuPercent={props.app.cpuPercent}
          rssBytes={props.app.rssBytes}
          className="text-ui-sm text-foreground"
        />
      </div>
      {props.app.process === null ? null : (
        <ProcessLeafRow process={props.app.process} depth={1} />
      )}
    </div>
  );
}

function combineResourceSummary(
  summary: TaskResourceSummary | null,
  desktopApp: DesktopAppResourceUsage | null,
): TaskResourceSummary | null {
  if (summary === null && desktopApp === null) return null;
  const base = summary ?? EMPTY_RESOURCE_SUMMARY;
  const desktop = desktopResourceSummary(desktopApp);

  return {
    cpuPercent: base.cpuPercent + desktop.cpuPercent,
    rssBytes: base.rssBytes + desktop.rssBytes,
    trackedProcessCount: base.trackedProcessCount + desktop.processCount,
    openTerminalCount: base.openTerminalCount,
    tuiAgentCount: base.tuiAgentCount,
    guiAgentCount: base.guiAgentCount,
  };
}

function desktopResourceSummary(
  desktopApp: DesktopAppResourceUsage | null,
): DesktopResourceSummary {
  if (desktopApp === null) {
    return { cpuPercent: 0, rssBytes: 0, processCount: 0 };
  }
  return {
    cpuPercent: desktopApp.cpuPercent,
    rssBytes: desktopApp.rssBytes,
    processCount: desktopApp.processCount,
  };
}

function TaskResourceSection(props: {
  readonly task: TaskDisplayRow;
  readonly collapsedOwners: ReadonlySet<string>;
  readonly onToggleOwner: (key: string) => void;
  readonly onOpenOwner: (row: OwnerDisplayRow) => void;
}) {
  const ownerCpu = props.task.owners.reduce(
    (sum, row) => sum + row.snapshot.cpuPercent,
    0,
  );
  const ownerRss = props.task.owners.reduce(
    (sum, row) => sum + row.snapshot.rssBytes,
    0,
  );
  return (
    <div className="border-b border-border/50 py-1 last:border-b-0">
      <div className="flex items-center justify-between px-3.5 py-1.5">
        <span className="min-w-0 truncate text-ui-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {props.task.label}
        </span>
        <MetricPair
          cpuPercent={ownerCpu}
          rssBytes={ownerRss}
          className="text-ui-sm text-foreground/90"
        />
      </div>
      {props.task.owners.map((row) => {
        const key = ownerKey(
          row.snapshot.owner.kind,
          row.snapshot.owner.ownerId,
        );
        return (
          <OwnerTreeRow
            key={key}
            row={row}
            collapsed={props.collapsedOwners.has(key)}
            onToggle={() => props.onToggleOwner(key)}
            onOpen={() => props.onOpenOwner(row)}
          />
        );
      })}
    </div>
  );
}

function OwnerTreeRow(props: {
  readonly row: OwnerDisplayRow;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onOpen: () => void;
}) {
  const hasProcesses = props.row.snapshot.processes.length > 0;
  return (
    <div>
      <div className="group flex items-center transition-colors hover:bg-muted/50">
        {hasProcesses ? (
          <button
            type="button"
            onClick={props.onToggle}
            className="ml-3 flex size-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            aria-label={
              props.collapsed ? "Expand process tree" : "Collapse process tree"
            }
          >
            {props.collapsed ? (
              <ChevronRight className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="ml-3 size-6 shrink-0" />
        )}
        <button
          type="button"
          onClick={props.onOpen}
          disabled={!props.row.canOpen}
          className={cn(
            "flex min-w-0 flex-1 items-center justify-between gap-3 py-1.5 pl-1 pr-3.5 text-left transition-colors",
            props.row.canOpen
              ? "text-foreground hover:text-foreground"
              : "cursor-default text-foreground",
          )}
        >
          <div className="min-w-0">
            <div className="truncate text-ui-sm">{props.row.label}</div>
            <div className="truncate text-ui-xs text-muted-foreground">
              {ownerKindLabel(props.row.snapshot.owner.kind)}
              {props.row.snapshot.activeProcessName === null
                ? ""
                : ` · ${props.row.snapshot.activeProcessName}`}
            </div>
          </div>
          <MetricPair
            cpuPercent={props.row.snapshot.cpuPercent}
            rssBytes={props.row.snapshot.rssBytes}
            className="text-ui-sm text-foreground/90"
          />
        </button>
      </div>
      {props.collapsed
        ? null
        : props.row.snapshot.processes.map((process) => (
            <ProcessLeafRow
              key={`${process.rootPid}:${process.pid}`}
              process={process}
              depth={processDepth(process, props.row.snapshot.processes)}
            />
          ))}
    </div>
  );
}

function ProcessLeafRow(props: {
  readonly process: ResourceProcessSnapshotWire;
  readonly depth: number;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 px-3.5 py-1 text-muted-foreground transition-colors hover:bg-muted/40"
      style={{ paddingLeft: `calc(1.25rem + ${props.depth} * 1rem)` }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="size-1 shrink-0 rounded-full bg-muted-foreground/40" />
        <span className="min-w-0 truncate text-ui-xs">
          {processLabel(props.process)}
        </span>
      </div>
      <MetricPair
        cpuPercent={props.process.cpuPercent}
        rssBytes={props.process.rssBytes}
        className="text-ui-xs text-muted-foreground/80"
      />
    </div>
  );
}

function MetricPair(props: {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly className: string;
}) {
  return (
    <div className={cn(METRIC_COLS, props.className)}>
      <span className={CPU_COL}>{formatCpuPercent(props.cpuPercent)}</span>
      <span className={MEM_COL}>{formatMemoryBytes(props.rssBytes)}</span>
    </div>
  );
}

function buildTaskRows(input: {
  readonly entries: readonly GlobalResourceEpicEntry[];
  readonly canvas: CanvasResourceSnapshot;
  readonly canvasIndex: CanvasResourceIndex;
  readonly recordByOwner: ReadonlyMap<string, EpicNodeRecord>;
  readonly sortOption: ResourceSortOption;
}): TaskDisplayRow[] {
  const rows = input.entries.flatMap((entry): TaskDisplayRow[] => {
    if (entry.owners.length === 0) return [];
    const owners = entry.owners.map((snapshot): OwnerDisplayRow => {
      const key = ownerKey(snapshot.owner.kind, snapshot.owner.ownerId);
      const location = input.canvasIndex.locationByOwner.get(key) ?? null;
      const record = input.recordByOwner.get(key) ?? null;
      return {
        snapshot,
        label: ownerLabel(snapshot, location, record),
        canOpen: canOpenOwner(snapshot, location, record),
        tabOrder:
          input.canvasIndex.tabOrderByOwner.get(key) ?? Number.MAX_SAFE_INTEGER,
        location,
      };
    });
    return [
      {
        entry,
        label: taskLabel(entry.epicId, input.canvas),
        tabOrder: taskTabOrder(entry.epicId, input.canvas),
        owners: sortOwnerRows(owners, input.sortOption),
      },
    ];
  });
  return sortTaskRows(rows, input.sortOption);
}

function buildCanvasResourceIndex(
  canvas: CanvasResourceSnapshot,
): CanvasResourceIndex {
  const locationByOwner = new Map<string, OpenOwnerLocation>();
  const tabOrderByOwner = new Map<string, number>();
  const candidates = canvas.openTabOrder.flatMap((tabId) => {
    const tab = canvas.tabsById[tabId];
    const state = canvas.canvasByTabId[tabId];
    if (tab === undefined || state === undefined || state.root === null) {
      return [];
    }
    return collectPanes(state.root).flatMap((pane) =>
      pane.tabInstanceIds.flatMap((tileTabId): CanvasOwnerCandidate[] => {
        const ref = state.tilesByInstanceId[tileTabId];
        const ownerKind =
          ref === undefined ? null : resourceOwnerKindForRef(ref);
        if (ref === undefined || ownerKind === null) return [];
        const key = ownerKey(ownerKind, ref.id);
        return [
          {
            key,
            location: isOwnerNodeRef(ref)
              ? {
                  epicId: tab.epicId,
                  tabId,
                  paneId: pane.id,
                  tileTabId,
                  ref,
                }
              : null,
          },
        ];
      }),
    );
  });

  candidates.forEach((candidate, order) => {
    if (!tabOrderByOwner.has(candidate.key)) {
      tabOrderByOwner.set(candidate.key, order);
    }
    if (candidate.location !== null && !locationByOwner.has(candidate.key)) {
      locationByOwner.set(candidate.key, candidate.location);
    }
  });

  return { locationByOwner, tabOrderByOwner };
}

function buildRecordByOwner(
  canvas: CanvasResourceSnapshot,
): ReadonlyMap<string, EpicNodeRecord> {
  return new Map(
    Object.values(canvas.artifactTreeByEpicId).flatMap((epicRecords) =>
      (epicRecords ?? []).flatMap((record): [string, EpicNodeRecord][] => {
        const kind = resourceOwnerKindForNodeType(record.type);
        if (kind === null) return [];
        return [[ownerKey(kind, record.id), record]];
      }),
    ),
  );
}

function sortTaskRows(
  rows: readonly TaskDisplayRow[],
  sortOption: ResourceSortOption,
): TaskDisplayRow[] {
  const sorted = [...rows];
  switch (sortOption) {
    case "memory":
      sorted.sort((a, b) => ownerRss(b.owners) - ownerRss(a.owners));
      break;
    case "cpu":
      sorted.sort((a, b) => ownerCpu(b.owners) - ownerCpu(a.owners));
      break;
    case "name":
      sorted.sort((a, b) => a.label.localeCompare(b.label));
      break;
    case "tab":
      sorted.sort((a, b) => a.tabOrder - b.tabOrder);
      break;
  }
  return sorted;
}

function sortOwnerRows(
  rows: readonly OwnerDisplayRow[],
  sortOption: ResourceSortOption,
): OwnerDisplayRow[] {
  const sorted = [...rows];
  switch (sortOption) {
    case "memory":
      sorted.sort((a, b) => b.snapshot.rssBytes - a.snapshot.rssBytes);
      break;
    case "cpu":
      sorted.sort((a, b) => b.snapshot.cpuPercent - a.snapshot.cpuPercent);
      break;
    case "name":
      sorted.sort((a, b) => a.label.localeCompare(b.label));
      break;
    case "tab":
      sorted.sort((a, b) => a.tabOrder - b.tabOrder);
      break;
  }
  return sorted;
}

function openResourceOwner(args: {
  readonly row: OwnerDisplayRow;
  readonly canvas: CanvasResourceSnapshot;
  readonly openTileInTab: (tabId: string, node: EpicCanvasTileRef) => void;
  readonly setActiveTilePane: (tabId: string, paneId: string) => void;
  readonly setActiveTileTab: (
    tabId: string,
    paneId: string,
    tileTabId: string,
  ) => void;
  readonly navigate: NavigateFn;
}): boolean {
  const location = args.row.location;
  if (location !== null) {
    args.setActiveTilePane(location.tabId, location.paneId);
    args.setActiveTileTab(location.tabId, location.paneId, location.tileTabId);
    navigateToTabIntent(
      args.navigate,
      existingEpicTabIntent({
        epicId: location.epicId,
        tabId: location.tabId,
        focus: focusForOwner(args.row.snapshot),
      }),
    );
    return true;
  }

  const snapshot = args.row.snapshot;
  if (
    snapshot.owner.kind !== "chat" &&
    snapshot.owner.kind !== "terminal-agent"
  ) {
    return false;
  }
  const record = findOwnerRecord(args.canvas, snapshot);
  if (record === null) return false;
  if (record.type !== "chat" && record.type !== "terminal-agent") return false;
  const targetTabId = useEpicCanvasStore
    .getState()
    .resolveTargetTabForEpic(
      snapshot.owner.epicId,
      taskLabel(snapshot.owner.epicId, args.canvas),
    );
  args.openTileInTab(targetTabId, {
    id: record.id,
    instanceId: uuidv4(),
    type: record.type,
    name: record.name,
    hostId: record.hostId,
  });
  navigateToTabIntent(
    args.navigate,
    openOrFocusEpicIntent({
      epicId: snapshot.owner.epicId,
      focus: focusForOwner(snapshot),
    }),
  );
  return true;
}

function focusForOwner(snapshot: OwnerResourceSnapshotWire) {
  return {
    focusedAt: Date.now(),
    focusArtifactId:
      snapshot.owner.kind === "terminal" ? undefined : snapshot.owner.ownerId,
    focusThreadId: undefined,
    migrationSource: undefined,
  };
}

function findOwnerRecord(
  canvas: CanvasResourceSnapshot,
  snapshot: OwnerResourceSnapshotWire,
): EpicNodeRecord | null {
  const records = canvas.artifactTreeByEpicId[snapshot.owner.epicId] ?? [];
  return records.find((record) => record.id === snapshot.owner.ownerId) ?? null;
}

function taskLabel(epicId: string, canvas: CanvasResourceSnapshot): string {
  for (const tabId of canvas.openTabOrder) {
    const tab = canvas.tabsById[tabId];
    if (tab?.epicId === epicId && tab.name.length > 0) return tab.name;
  }
  return "Task";
}

function taskTabOrder(epicId: string, canvas: CanvasResourceSnapshot): number {
  const index = canvas.openTabOrder.findIndex(
    (tabId) => canvas.tabsById[tabId]?.epicId === epicId,
  );
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function ownerKey(kind: ResourceOwnerKindWire, ownerId: string): string {
  return `${kind}\x1f${ownerId}`;
}

function resourceOwnerKindForNodeType(
  type: string,
): ResourceOwnerKindWire | null {
  if (type === "terminal-agent") return "terminal-agent";
  if (type === "chat") return "chat";
  return null;
}

function resourceOwnerKindForRef(
  ref: EpicCanvasTileRef,
): ResourceOwnerKindWire | null {
  if (ref.type === "terminal") return "terminal";
  return resourceOwnerKindForNodeType(ref.type);
}

function isOwnerNodeRef(ref: EpicCanvasTileRef): ref is EpicNodeRef {
  return (
    ref.type === "terminal" ||
    ref.type === "chat" ||
    ref.type === "terminal-agent"
  );
}

function isResourceSortOption(value: string): value is ResourceSortOption {
  return (
    value === "memory" || value === "cpu" || value === "name" || value === "tab"
  );
}

function ownerKindLabel(kind: ResourceOwnerKindWire): string {
  if (kind === "terminal") return "Terminal";
  if (kind === "terminal-agent") return "TUI agent";
  return "GUI agent";
}

function ownerLabel(
  snapshot: OwnerResourceSnapshotWire,
  location: OpenOwnerLocation | null,
  record: EpicNodeRecord | null,
): string {
  if (location !== null) return location.ref.name;
  if (record !== null) return record.name;
  if (snapshot.owner.kind === "terminal") {
    return snapshot.activeProcessName ?? "Terminal";
  }
  return ownerKindLabel(snapshot.owner.kind);
}

function canOpenOwner(
  snapshot: OwnerResourceSnapshotWire,
  location: OpenOwnerLocation | null,
  record: EpicNodeRecord | null,
): boolean {
  if (location !== null) return true;
  if (snapshot.owner.kind === "terminal") return false;
  return record !== null;
}

function memoryShareBarClass(memorySharePercent: number): string {
  if (memorySharePercent >= 35) return "bg-destructive/80";
  if (memorySharePercent >= 20) return "bg-amber-500/80";
  return "bg-foreground/40";
}

function processLabel(process: ResourceProcessSnapshotWire): string {
  if (process.command !== null && process.command.trim().length > 0) {
    return process.command;
  }
  return `${process.name} (${process.pid})`;
}

function processDepth(
  process: ResourceProcessSnapshotWire,
  processes: readonly ResourceProcessSnapshotWire[],
): number {
  let depth = process.pid === process.rootPid ? 1 : 2;
  let cursor = process;
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const visited = new Set<number>([process.pid]);
  while (cursor.parentPid !== null && cursor.parentPid !== process.rootPid) {
    const parent = byPid.get(cursor.parentPid);
    if (parent === undefined || visited.has(parent.pid)) break;
    visited.add(parent.pid);
    cursor = parent;
    depth += 1;
  }
  return depth;
}

function ownerCpu(rows: readonly OwnerDisplayRow[]): number {
  return rows.reduce((sum, row) => sum + row.snapshot.cpuPercent, 0);
}

function ownerRss(rows: readonly OwnerDisplayRow[]): number {
  return rows.reduce((sum, row) => sum + row.snapshot.rssBytes, 0);
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${formatProcessCount(count)} ${count === 1 ? singular : plural}`;
}
