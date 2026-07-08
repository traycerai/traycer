import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MouseEvent, PointerEvent } from "react";
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
import type { TaskLight } from "@traycer/protocol/host/epic/unary-schemas";
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
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import {
  useGlobalResourceProjection,
  type GlobalResourceEpicEntry,
} from "@/stores/resources/resources-registry";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";
import { GlobalResourcesStreamMount } from "@/providers/resources-stream-mount";
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
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
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
// The collapsed sub-tree tooltip is a mini-panel mirroring the process tree, so
// it rides the light popover surface rather than the default inverted (dark)
// tooltip chip - matching the popover it extends.
const HIDDEN_SUBPROCESS_TOOLTIP_SURFACE =
  "z-50 w-fit max-w-[min(90vw,22rem)] origin-(--radix-tooltip-content-transform-origin) rounded-lg bg-popover p-1.5 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";
const DESKTOP_RESOURCE_SAMPLE_INTERVAL_MS = 1000;
const desktopAppResourceListeners = new Set<() => void>();
let desktopAppResourceSnapshot: DesktopAppResourceUsage | null = null;
let desktopAppResourceTimer: number | null = null;
let desktopAppResourceInFlight = false;
const MAX_VISIBLE_PROCESS_DEPTH = 2;
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
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly owners: readonly OwnerDisplayRow[];
}

interface DesktopResourceSummary {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
}

interface ProcessDisplayRow {
  readonly process: ResourceProcessSnapshotWire;
  readonly depth: number;
  readonly hiddenDescendants: readonly HiddenProcessRow[];
}

interface HiddenProcessRow {
  readonly process: ResourceProcessSnapshotWire;
  // Depth relative to the capped row (the first hidden level is 1) so the
  // tooltip can indent the collapsed sub-tree the same way the main tree does.
  readonly depth: number;
}

export function ResourceMonitorPopover(props: ResourceMonitorPopoverProps) {
  const [open, setOpen] = useState(false);
  const setTitleBarDragSuppressed = useTitleBarDragStore(
    (state) => state.setSuppressed,
  );
  // While the panel is open, let the header drop its title-bar drag regions so a
  // click on the (otherwise event-swallowing) drag area dismisses the popover.
  useEffect(() => {
    setTitleBarDragSuppressed("resource-monitor", open);
    return () => setTitleBarDragSuppressed("resource-monitor", false);
  }, [open, setTitleBarDragSuppressed]);

  return (
    <>
      <GlobalResourcesStreamMount />
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

        {open ? (
          <ResourceMonitorContent onClose={() => setOpen(false)} />
        ) : null}
      </Popover>
    </>
  );
}

function ResourceMonitorContent(props: { readonly onClose: () => void }) {
  const [sortOption, setSortOption] = useState<ResourceSortOption>("memory");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [collapsedOwners, setCollapsedOwners] = useState<Set<string>>(
    () => new Set(),
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sortTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dismissingSortMenuRef = useRef(false);
  const projection = useGlobalResourceProjection();
  const { tasks } = useCloudEpicTasksQuery(undefined, { enabled: true });
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
  const epicTitleById = useMemo(() => buildEpicTitleById(tasks), [tasks]);
  const taskRows = useMemo(
    () =>
      buildTaskRows({
        entries: projection.entries,
        canvas,
        canvasIndex,
        recordByOwner,
        epicTitleById,
        sortOption,
      }),
    [
      canvas,
      canvasIndex,
      epicTitleById,
      projection.entries,
      recordByOwner,
      sortOption,
    ],
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
      epicTitleById,
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

  const dismissSortMenuFromPanelClick = (
    event: PointerEvent<HTMLDivElement>,
  ): void => {
    if (!sortMenuOpen) return;
    if (!(event.target instanceof Node)) return;
    if (sortTriggerRef.current?.contains(event.target) === true) return;

    dismissingSortMenuRef.current = true;
    setSortMenuOpen(false);
    event.preventDefault();
    event.stopPropagation();
  };

  const swallowDismissedSortMenuClick = (
    event: MouseEvent<HTMLDivElement>,
  ): void => {
    if (!dismissingSortMenuRef.current) return;

    dismissingSortMenuRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <PopoverContent
      align="end"
      sideOffset={8}
      collisionPadding={12}
      role="dialog"
      aria-label="Resources"
      className="w-[min(92vw,34rem)] gap-0 overflow-hidden rounded-xl p-0"
      onOpenAutoFocus={(event) => event.preventDefault()}
      // Keep the panel open when focus moves elsewhere (switching tabs, a task
      // finishing load and autofocusing its content, a terminal grabbing
      // focus). Only a genuine outside pointer click or Escape should dismiss
      // it; those go through onPointerDownOutside / onEscapeKeyDown, not here.
      onFocusOutside={(event) => event.preventDefault()}
      onInteractOutside={(event) => {
        if (!sortMenuOpen) return;
        if (!(event.target instanceof Node)) return;
        if (panelRef.current?.contains(event.target) === true) {
          event.preventDefault();
        }
      }}
    >
      <div
        ref={panelRef}
        className="min-w-0"
        onPointerDownCapture={dismissSortMenuFromPanelClick}
        onClickCapture={swallowDismissedSortMenuClick}
      >
        <div className="border-b border-border/60 px-3.5 pb-3 pt-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="truncate text-ui-sm font-medium text-foreground">
              Resources
            </h4>
            <DropdownMenu
              modal={false}
              open={sortMenuOpen}
              onOpenChange={setSortMenuOpen}
            >
              <DropdownMenuTrigger asChild>
                <button
                  ref={sortTriggerRef}
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
                  <DropdownMenuRadioItem value="name">
                    Name
                  </DropdownMenuRadioItem>
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
      </div>
    </PopoverContent>
  );
}

function useDesktopAppResourceUsage(): DesktopAppResourceUsage | null {
  return useSyncExternalStore(
    subscribeDesktopAppResourceUsage,
    getDesktopAppResourceSnapshot,
    getDesktopAppResourceSnapshot,
  );
}

function subscribeDesktopAppResourceUsage(listener: () => void): () => void {
  desktopAppResourceListeners.add(listener);
  if (desktopAppResourceListeners.size === 1) {
    sampleDesktopAppResourceUsage();
    desktopAppResourceTimer = window.setInterval(
      sampleDesktopAppResourceUsage,
      DESKTOP_RESOURCE_SAMPLE_INTERVAL_MS,
    );
  }
  return () => {
    desktopAppResourceListeners.delete(listener);
    if (
      desktopAppResourceListeners.size === 0 &&
      desktopAppResourceTimer !== null
    ) {
      window.clearInterval(desktopAppResourceTimer);
      desktopAppResourceTimer = null;
    }
  };
}

function getDesktopAppResourceSnapshot(): DesktopAppResourceUsage | null {
  return desktopAppResourceSnapshot;
}

function sampleDesktopAppResourceUsage(): void {
  const bridge = getDesktopDiagnosticsBridge();
  if (bridge === null) {
    setDesktopAppResourceSnapshot(null);
    return;
  }
  if (desktopAppResourceInFlight) return;
  desktopAppResourceInFlight = true;
  void bridge
    .getMetrics()
    .then(
      (snapshot) => {
        setDesktopAppResourceSnapshot(
          desktopAppResourceUsageFromMetrics(snapshot, Date.now()),
        );
      },
      () => {
        setDesktopAppResourceSnapshot(null);
      },
    )
    .finally(() => {
      desktopAppResourceInFlight = false;
    });
}

function setDesktopAppResourceSnapshot(
  next: DesktopAppResourceUsage | null,
): void {
  desktopAppResourceSnapshot = next;
  for (const listener of Array.from(desktopAppResourceListeners)) {
    listener();
  }
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
        <ProcessLeafRow
          processRow={{
            process: props.app.process,
            depth: 1,
            hiddenDescendants: [],
          }}
        />
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

function buildEpicTitleById(
  tasks: readonly TaskLight[],
): ReadonlyMap<string, string> {
  return new Map(
    tasks.flatMap((task): [string, string][] => {
      const light = task.epic?.light ?? null;
      if (light === null) return [];
      const title = light.title.trim();
      if (title.length === 0) return [];
      return [[light.id, title]];
    }),
  );
}

function TaskResourceSection(props: {
  readonly task: TaskDisplayRow;
  readonly collapsedOwners: ReadonlySet<string>;
  readonly onToggleOwner: (key: string) => void;
  readonly onOpenOwner: (row: OwnerDisplayRow) => void;
}) {
  return (
    <div className="border-b border-border/50 py-1 last:border-b-0">
      <div className="flex items-center justify-between px-3.5 py-1.5">
        <span className="min-w-0 truncate text-ui-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {props.task.label}
        </span>
        <MetricPair
          cpuPercent={props.task.cpuPercent}
          rssBytes={props.task.rssBytes}
          className="text-ui-sm text-foreground/90"
        />
      </div>
      {props.task.owners.map((row) => {
        const key = ownerKey(
          row.snapshot.owner.epicId,
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
  const processRows = buildProcessRows(props.row.snapshot.processes);
  const hasProcesses = processRows.length > 0;
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
        : processRows.map((processRow) => (
            <ProcessLeafRow
              key={`${processRow.process.rootPid}:${processRow.process.pid}`}
              processRow={processRow}
            />
          ))}
    </div>
  );
}

function ProcessLeafRow(props: { readonly processRow: ProcessDisplayRow }) {
  const hiddenCount = props.processRow.hiddenDescendants.length;
  const rowClassName =
    "flex w-full items-center justify-between gap-3 px-3.5 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/40";
  const rowStyle = {
    paddingLeft: `calc(1.25rem + ${props.processRow.depth} * 1rem)`,
  };
  const inner = (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="size-1 shrink-0 rounded-full bg-muted-foreground/40" />
        <span className="min-w-0 truncate text-ui-xs">
          {processLeafLabel(props.processRow.process, hiddenCount)}
        </span>
      </div>
      <MetricPair
        cpuPercent={props.processRow.process.cpuPercent}
        rssBytes={props.processRow.process.rssBytes}
        className="text-ui-xs text-muted-foreground/80"
      />
    </>
  );
  // Leaf rows are static; only a capped row reveals more (its hidden sub-tree),
  // so it is the one focusable, keyboard-reachable trigger for that tooltip.
  if (hiddenCount === 0) {
    return (
      <div className={rowClassName} style={rowStyle}>
        {inner}
      </div>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            rowClassName,
            "cursor-default outline-none focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          )}
          style={rowStyle}
        >
          {inner}
        </button>
      </TooltipTrigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="right"
          align="start"
          sideOffset={8}
          className={HIDDEN_SUBPROCESS_TOOLTIP_SURFACE}
        >
          <HiddenSubprocessTooltip rows={props.processRow.hiddenDescendants} />
          <TooltipPrimitive.Arrow className="size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-xs bg-popover fill-popover" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </Tooltip>
  );
}

function HiddenSubprocessTooltip(props: {
  readonly rows: readonly HiddenProcessRow[];
}) {
  return (
    <div className="flex max-h-[min(40vh,18rem)] min-w-0 flex-col overflow-y-auto text-left">
      {props.rows.map((row) => (
        <div
          key={`${row.process.rootPid}:${row.process.pid}`}
          className="flex items-center justify-between gap-3 py-1 text-muted-foreground"
          style={{ paddingLeft: `calc(${row.depth} * 1rem)` }}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="size-1 shrink-0 rounded-full bg-muted-foreground/40" />
            <span className="min-w-0 truncate text-ui-xs">
              {processLabel(row.process)}
            </span>
          </div>
          <MetricPair
            cpuPercent={row.process.cpuPercent}
            rssBytes={row.process.rssBytes}
            className="text-ui-xs text-muted-foreground/80"
          />
        </div>
      ))}
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
  readonly epicTitleById: ReadonlyMap<string, string>;
  readonly sortOption: ResourceSortOption;
}): TaskDisplayRow[] {
  const rows = input.entries.flatMap((entry): TaskDisplayRow[] => {
    if (entry.owners.length === 0) return [];
    const owners = entry.owners
      .filter(shouldShowOwnerRow)
      .map((snapshot): OwnerDisplayRow => {
        const key = ownerKey(
          snapshot.owner.epicId,
          snapshot.owner.kind,
          snapshot.owner.ownerId,
        );
        const location = input.canvasIndex.locationByOwner.get(key) ?? null;
        const record = input.recordByOwner.get(key) ?? null;
        return {
          snapshot,
          label: ownerLabel(snapshot, location, record),
          canOpen: canOpenOwner(snapshot, location, record),
          tabOrder:
            input.canvasIndex.tabOrderByOwner.get(key) ??
            Number.MAX_SAFE_INTEGER,
          location,
        };
      });
    if (owners.length === 0) return [];
    return [
      {
        entry,
        label: taskLabel(entry.epicId, input.canvas, input.epicTitleById),
        tabOrder: taskTabOrder(entry.epicId, input.canvas),
        cpuPercent: entry.owners.reduce(
          (sum, snapshot) => sum + snapshot.cpuPercent,
          0,
        ),
        rssBytes: entry.owners.reduce(
          (sum, snapshot) => sum + snapshot.rssBytes,
          0,
        ),
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
        const key = ownerKey(tab.epicId, ownerKind, ref.id);
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
    Object.entries(canvas.artifactTreeByEpicId).flatMap(
      ([epicId, epicRecords]) =>
        (epicRecords ?? []).flatMap((record): [string, EpicNodeRecord][] => {
          const kind = resourceOwnerKindForNodeType(record.type);
          if (kind === null) return [];
          return [[ownerKey(epicId, kind, record.id), record]];
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
      sorted.sort((a, b) => b.rssBytes - a.rssBytes);
      break;
    case "cpu":
      sorted.sort((a, b) => b.cpuPercent - a.cpuPercent);
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
  readonly epicTitleById: ReadonlyMap<string, string>;
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
      taskLabel(snapshot.owner.epicId, args.canvas, args.epicTitleById),
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

function taskLabel(
  epicId: string,
  canvas: CanvasResourceSnapshot,
  epicTitleById: ReadonlyMap<string, string>,
): string {
  for (const tabId of canvas.openTabOrder) {
    const tab = canvas.tabsById[tabId];
    if (tab?.epicId === epicId && tab.name.length > 0) return tab.name;
  }
  const title = epicTitleById.get(epicId);
  if (title !== undefined && title.length > 0) return title;
  return "Task";
}

function taskTabOrder(epicId: string, canvas: CanvasResourceSnapshot): number {
  const index = canvas.openTabOrder.findIndex(
    (tabId) => canvas.tabsById[tabId]?.epicId === epicId,
  );
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function ownerKey(
  epicId: string,
  kind: ResourceOwnerKindWire,
  ownerId: string,
): string {
  return `${epicId}\x1f${kind}\x1f${ownerId}`;
}

function shouldShowOwnerRow(snapshot: OwnerResourceSnapshotWire): boolean {
  if (snapshot.owner.kind !== "terminal") return true;
  // A terminal always carries its own shell, so "has a process" is always true
  // and never filters anything. Show a terminal only once it has a sub-process
  // worth rendering - an idle shell adds no signal over the aggregate metrics.
  return buildProcessRows(snapshot.processes).length > 0;
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

function processLeafLabel(
  process: ResourceProcessSnapshotWire,
  hiddenCount: number,
): string {
  const label = processLabel(process);
  if (hiddenCount === 0) return label;
  return `${label} (${countLabel(hiddenCount, "sub-process", "sub-processes")})`;
}

function buildProcessRows(
  processes: readonly ResourceProcessSnapshotWire[],
): ProcessDisplayRow[] {
  // A lone process - a terminal shell with nothing running under it, or an owner
  // whose whole tree is a single process - is fully described by its owner row,
  // so it adds no signal as a child row. Render nothing (and no expand chevron)
  // and let the owner row stand alone.
  if (processes.length <= 1) return [];
  const byPid = processByPid(processes);
  return processes.flatMap((process): ProcessDisplayRow[] => {
    const depth = processDepth(process, byPid);
    if (depth > MAX_VISIBLE_PROCESS_DEPTH) return [];
    return [
      {
        process,
        depth,
        hiddenDescendants:
          depth === MAX_VISIBLE_PROCESS_DEPTH
            ? hiddenProcessDescendants(process, processes, byPid)
            : [],
      },
    ];
  });
}

function processDepth(
  process: ResourceProcessSnapshotWire,
  byPid: ReadonlyMap<number, ResourceProcessSnapshotWire>,
): number {
  let depth = process.pid === process.rootPid ? 1 : 2;
  let cursor = process;
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

function processByPid(
  processes: readonly ResourceProcessSnapshotWire[],
): ReadonlyMap<number, ResourceProcessSnapshotWire> {
  return new Map(processes.map((entry) => [entry.pid, entry]));
}

function hiddenProcessDescendants(
  process: ResourceProcessSnapshotWire,
  processes: readonly ResourceProcessSnapshotWire[],
  byPid: ReadonlyMap<number, ResourceProcessSnapshotWire>,
): HiddenProcessRow[] {
  return processes.flatMap((candidate): HiddenProcessRow[] => {
    const depth = processDepth(candidate, byPid);
    if (
      depth <= MAX_VISIBLE_PROCESS_DEPTH ||
      !isProcessDescendantOf(candidate, process.pid, byPid)
    ) {
      return [];
    }
    return [{ process: candidate, depth: depth - MAX_VISIBLE_PROCESS_DEPTH }];
  });
}

function isProcessDescendantOf(
  process: ResourceProcessSnapshotWire,
  ancestorPid: number,
  byPid: ReadonlyMap<number, ResourceProcessSnapshotWire>,
): boolean {
  let cursor = process;
  const visited = new Set<number>([process.pid]);
  while (cursor.parentPid !== null) {
    if (cursor.parentPid === ancestorPid) return true;
    const parent = byPid.get(cursor.parentPid);
    if (parent === undefined || visited.has(parent.pid)) break;
    visited.add(parent.pid);
    cursor = parent;
  }
  return false;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${formatProcessCount(count)} ${count === 1 ? singular : plural}`;
}
