import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MouseEvent, PointerEvent } from "react";
import {
  useNavigate,
  useRouterState,
  type UseNavigateResult,
} from "@tanstack/react-router";
import { v4 as uuidv4 } from "uuid";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowDownNarrowWide,
  ChevronDown,
  ChevronRight,
  Cpu,
  ListChecks,
  Monitor,
  Server,
  X,
} from "lucide-react";
import type {
  OwnerResourceSnapshotWireV13,
  HostTreeResourceSnapshotWire,
  OtherResourceSnapshotWire,
  ResourceOwnerKindWire,
  ResourceProcessSnapshotWire,
} from "@traycer/protocol/host/resources/subscribe";
import type { TaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import type { EpicNodeRecord } from "@/lib/artifacts/node-display";
import { displayTitle } from "@/lib/display-title";
import { useRegisteredEpicLiveArtifactTitle } from "@/lib/epic-selectors";
import { terminalSessionTitle } from "@/lib/terminals/terminal-title";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { normalizeProviderId } from "@/components/home/data/landing-options";
import { useResourcesKill } from "@/hooks/resources/use-resources-kill-mutation";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { agentProviderLabel } from "@/lib/chat/sender-display";
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
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { GlobalResourcesStreamMount } from "@/providers/resources-stream-mount";
import { useStreamMethodSchemaVersion } from "@/lib/host/stream-runtime-context";
import type {
  AppResourceUsage,
  OtherResourceUsage,
  OwnerResourceUsage,
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
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { useHistoryNavAvailable } from "@/lib/history-navigation/use-history-nav-available";
import {
  readActiveEpicIdFromPath,
  readActiveEpicTabIdFromPath,
} from "@/lib/routes";
import {
  existingEpicTabIntentWithNestedFocus,
  navigateToTabIntent,
  type EpicRouteFocus,
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
// The current root section pins to the top of the scroll region and swaps to the
// next section as it scrolls into view (a single sticky header, not a stack).
// Opaque background so scrolled rows slide cleanly underneath it.
const STICKY_SECTION_HEADER =
  "sticky top-0 z-20 border-b border-border/50 bg-popover";
/**
 * Trailing gutter every row reserves for its kill affordance. Section headers
 * (which have no action) reserve the same width as an empty spacer, so the
 * cpu/memory columns share one right edge across headers, owner rows, and
 * process rows. Icon-button sized, so hardcoding the track width is correct.
 */
const ROW_ACTION_SLOT = "flex w-10 shrink-0 items-center justify-center";
const DESKTOP_RESOURCE_SAMPLE_INTERVAL_MS = 1000;
const desktopAppResourceListeners = new Set<() => void>();
let desktopAppResourceSnapshot: DesktopAppResourceUsage | null = null;
let desktopAppResourceTimer: number | null = null;
let desktopAppResourceInFlight = false;

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
  readonly snapshot: OwnerResourceSnapshotWireV13;
  readonly label: string;
  readonly canOpen: boolean;
  readonly tabOrder: number;
  readonly location: OpenOwnerLocation | null;
  readonly record: EpicNodeRecord | null;
  readonly treeCpuPercent: number;
  readonly treeRssBytes: number;
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

interface DesktopProcessGroupEntry {
  readonly label: string;
  readonly usage: DesktopAppProcessGroupUsage;
}

interface ProcessDisplayRow {
  readonly process: ResourceProcessSnapshotWire;
  readonly depth: number;
  readonly canExpand: boolean;
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly treeCpuPercent: number;
  readonly treeRssBytes: number;
  readonly children: readonly ProcessDisplayRow[];
}

interface OwnerProcessRows {
  readonly rows: readonly ProcessDisplayRow[];
  readonly rootRows: readonly ProcessDisplayRow[];
  readonly canExpand: boolean;
  readonly selfCpuPercent: number;
  readonly selfRssBytes: number;
  readonly treeCpuPercent: number;
  readonly treeRssBytes: number;
}

const NO_EXPANDED_PROCESSES: ReadonlySet<string> = new Set();

// For process rows that can never expand (e.g. the host's single root process).
function noProcessToggle(): void {}

export function ResourceMonitorPopover(props: ResourceMonitorPopoverProps) {
  const [open, setOpen] = useState(false);
  // While the panel is open, let the header drop its title-bar drag regions so a
  // click on the (otherwise event-swallowing) drag area dismisses the popover.
  useTitleBarDragSuppression("resource-monitor", open);

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

/**
 * Owns the resource monitor's kill + multi-select state. Groups selected
 * targets by host and merges their pids into one `resources.kill` per host, so
 * a bulk kill is one RPC per host rather than one per row. The host validates
 * every pid against its live tracked set, so an already-dead pid is harmless.
 */
function useResourceKillSelection(
  // Keys of every row currently rendered as killable. Selection is pruned
  // against this LIVE set at read time (never via an effect), so a selected
  // process that exits on its own stops counting the moment its row drops
  // out of the projection.
  liveKeys: ReadonlySet<string>,
  // Top-level kill targets (owner rows + Other roots) for "Select all".
  // Deliberately excludes descendant process rows: selecting an owner already
  // kills its whole tree, and counting children would double-count.
  topLevelTargets: ReadonlyMap<string, KillTarget>,
): {
  readonly api: ResourceKillApi;
  readonly selectionMode: boolean;
  readonly selectedCount: number;
  readonly allVisibleSelected: boolean;
  readonly enterSelection: () => void;
  readonly cancelSelection: () => void;
  readonly selectAllVisible: () => void;
  readonly deselectAllVisible: () => void;
  readonly killSelected: () => void;
  readonly isKilling: boolean;
} {
  const killMutation = useResourcesKill();
  const { mutate } = killMutation;
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlyMap<string, KillTarget>>(
    () => new Map(),
  );
  const liveSelected = new Map(
    [...selected].filter(([key]) => liveKeys.has(key)),
  );
  const killTargets = (targets: readonly KillTarget[]): void => {
    const pidsByHost = new Map<string, number[]>();
    for (const target of targets) {
      const existing = pidsByHost.get(target.hostId) ?? [];
      existing.push(...target.pids);
      pidsByHost.set(target.hostId, existing);
    }
    for (const [hostId, pids] of pidsByHost) {
      if (pids.length > 0) mutate({ hostId, pids });
    }
  };
  const api: ResourceKillApi = {
    selectionMode,
    isSelected: (key) => liveSelected.has(key),
    toggleSelection: (target) =>
      setSelected((prev) => {
        const next = new Map(prev);
        if (next.has(target.key)) next.delete(target.key);
        else next.set(target.key, target);
        return next;
      }),
    killOne: (target) => killTargets([target]),
    isKilling: killMutation.isPending,
  };
  return {
    api,
    selectionMode,
    selectedCount: liveSelected.size,
    allVisibleSelected:
      topLevelTargets.size > 0 &&
      [...topLevelTargets.keys()].every((key) => liveSelected.has(key)),
    enterSelection: () => setSelectionMode(true),
    cancelSelection: () => {
      setSelectionMode(false);
      setSelected(new Map());
    },
    selectAllVisible: () => setSelected(new Map(topLevelTargets)),
    deselectAllVisible: () => setSelected(new Map()),
    killSelected: () => {
      killTargets([...liveSelected.values()]);
      setSelectionMode(false);
      setSelected(new Map());
    },
    isKilling: killMutation.isPending,
  };
}

function ResourceMonitorContent(props: { readonly onClose: () => void }) {
  const [sortOption, setSortOption] = useState<ResourceSortOption>("tab");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [expandedOwners, setExpandedOwners] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedProcesses, setExpandedProcesses] = useState<Set<string>>(
    () => new Set(),
  );
  // The global projection streams a single host (the default host's transport),
  // so every owner/Other pid in it belongs to this host - the kill route for
  // the harness-less "Other" roots, which carry no owner hostId of their own.
  const defaultHostId = useReactiveActiveHostId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sortTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dismissingSortMenuRef = useRef(false);
  const projection = useGlobalResourceProjection();
  const killTargetIndex = useMemo(
    () =>
      buildKillTargetIndex(projection.owners, projection.other, defaultHostId),
    [projection.owners, projection.other, defaultHostId],
  );
  const killSelection = useResourceKillSelection(
    killTargetIndex.live,
    killTargetIndex.topLevel,
  );
  const resourcesVersion = useStreamMethodSchemaVersion("resources.subscribe");
  const { tasks } = useCloudEpicTasksQuery(undefined, { enabled: true });
  const canvas = useResourceCanvasSnapshot();
  const navigate = useNavigate();
  const navigateNested = useEpicNestedFocusNavigation();
  const desktopNestedFocusEnabled = useHistoryNavAvailable();
  const activePathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const activeEpicId = readActiveEpicIdFromPath(activePathname);
  const activeTabId = readActiveEpicTabIdFromPath(activePathname);
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (state) => state.prepareOpenTileInTabFocusTarget,
  );
  const prepareSetActiveTileTabFocusTarget = useEpicCanvasStore(
    (state) => state.prepareSetActiveTileTabFocusTarget,
  );
  const resolveTargetTabForEpic = useEpicCanvasStore(
    (state) => state.resolveTargetTabForEpic,
  );
  const desktopApp = useDesktopAppResourceUsage();
  const supportsHostTree = resourcesSubscribeV12Supported(resourcesVersion);
  const summary = useMemo(
    () =>
      combineHeadlineResourceSummary(
        supportsHostTree ? projection.hostTree : null,
        projection.app,
        projection.owners,
        desktopApp,
      ),
    [
      desktopApp,
      projection.app,
      projection.hostTree,
      projection.owners,
      supportsHostTree,
    ],
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
    setExpandedOwners((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleProcess = (key: string): void => {
    setExpandedProcesses((previous) => {
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
      prepareOpenTileInTabFocusTarget,
      prepareSetActiveTileTabFocusTarget,
      resolveTargetTabForEpic,
      navigate,
      navigateNested,
      activeEpicId,
      activeTabId,
      desktopNestedFocusEnabled,
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
            <h4 className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground">
              Resources
            </h4>
            <div className="flex shrink-0 items-center gap-1">
              {killSelection.selectionMode ? (
                // Selection mode replaces the header controls wholesale (the
                // sort dropdown included), mirroring the chat navigator's
                // Select all / Cancel / destructive-action toolbar.
                <div className="flex items-center gap-0.5">
                  <SelectAllToggle
                    allSelected={killSelection.allVisibleSelected}
                    onSelectAll={killSelection.selectAllVisible}
                    onDeselectAll={killSelection.deselectAllVisible}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-6 px-1.5 text-muted-foreground hover:text-foreground"
                    aria-label="Cancel selection"
                    onClick={killSelection.cancelSelection}
                  >
                    <X className="mr-1 size-3.5" />
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-6 px-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={
                      killSelection.selectedCount === 0 ||
                      killSelection.isKilling
                    }
                    aria-label={`Kill ${killSelection.selectedCount} selected`}
                    onClick={killSelection.killSelected}
                  >
                    Kill{" "}
                    {killSelection.selectedCount > 0
                      ? killSelection.selectedCount
                      : ""}
                    {killSelection.isKilling ? (
                      <AgentSpinningDots
                        className="ml-1"
                        testId={undefined}
                        variant={undefined}
                      />
                    ) : null}
                  </Button>
                </div>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Select processes to kill"
                    onClick={killSelection.enterSelection}
                  >
                    <ListChecks className="size-3.5" />
                  </Button>
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
                        <DropdownMenuRadioItem value="cpu">
                          CPU
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="name">
                          Name
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="tab">
                          Tab order
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
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
            </>
          )}
        </div>

        <div className="max-h-[min(58vh,36rem)] overflow-y-auto">
          {desktopApp === null ? null : (
            <DesktopAppResourceSection
              app={desktopApp}
              sortOption={sortOption}
            />
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
                    expandedOwners={expandedOwners}
                    expandedProcesses={expandedProcesses}
                    sortOption={sortOption}
                    onToggleOwner={toggleOwner}
                    onToggleProcess={toggleProcess}
                    onOpenOwner={openOwner}
                    kill={killSelection.api}
                  />
                ))
              )}
              {!supportsHostTree || projection.other === null ? null : (
                <OtherResourceSection
                  other={projection.other}
                  expandedProcesses={expandedProcesses}
                  sortOption={sortOption}
                  onToggleProcess={toggleProcess}
                  kill={killSelection.api}
                  killHostId={defaultHostId}
                />
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

function DesktopAppResourceSection(props: {
  readonly app: DesktopAppResourceUsage;
  readonly sortOption: ResourceSortOption;
}) {
  const showOther =
    props.app.other.cpuPercent > 0 ||
    props.app.other.rssBytes > 0 ||
    props.app.other.processCount > 0;
  const groups = sortDesktopProcessGroups(
    [
      { label: "Main", usage: props.app.main },
      { label: "Renderer", usage: props.app.renderer },
      ...(showOther ? [{ label: "Other", usage: props.app.other }] : []),
    ],
    props.sortOption,
  );

  return (
    <div className="border-b border-border/60 py-1">
      <div
        className={cn(
          "flex items-center justify-between px-3.5 py-1.5",
          STICKY_SECTION_HEADER,
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Monitor className="size-3.5 shrink-0 text-muted-foreground/80" />
          <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
            Traycer Desktop
          </span>
        </div>
        <div className="flex items-center">
          <MetricPair
            cpuPercent={props.app.cpuPercent}
            rssBytes={props.app.rssBytes}
            className="text-ui-sm text-foreground"
          />
          <span className={ROW_ACTION_SLOT} />
        </div>
      </div>
      {groups.map((group) => (
        <DesktopAppProcessGroupRow
          key={group.label}
          label={group.label}
          usage={group.usage}
        />
      ))}
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
      <div
        className={cn(
          "flex items-center justify-between px-3.5 py-1.5",
          STICKY_SECTION_HEADER,
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Server className="size-3.5 shrink-0 text-muted-foreground/80" />
          <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
            Traycer Host
          </span>
        </div>
        <div className="flex items-center">
          <MetricPair
            cpuPercent={props.app.cpuPercent}
            rssBytes={props.app.rssBytes}
            className="text-ui-sm text-foreground"
          />
          <span className={ROW_ACTION_SLOT} />
        </div>
      </div>
      {props.app.process === null ? null : (
        <ProcessTreeRow
          processRow={{
            process: props.app.process,
            depth: 1,
            canExpand: false,
            expanded: false,
            hiddenCount: 0,
            treeCpuPercent: props.app.process.cpuPercent,
            treeRssBytes: props.app.process.rssBytes,
            children: [],
          }}
          stickyTop={0}
          labelMode="full"
          onToggleExpand={noProcessToggle}
          kill={null}
          killHostId={null}
        />
      )}
    </div>
  );
}

function resourcesSubscribeV12Supported(
  version: { readonly major: number; readonly minor: number } | null,
): boolean {
  return version === null || (version.major === 1 && version.minor >= 2);
}

function combineHeadlineResourceSummary(
  hostTree: HostTreeResourceSnapshotWire | null,
  app: AppResourceUsage | null,
  owners: readonly OwnerResourceSnapshotWireV13[],
  desktopApp: DesktopAppResourceUsage | null,
): TaskResourceSummary | null {
  if (
    hostTree === null &&
    app === null &&
    desktopApp === null &&
    owners.length === 0
  ) {
    return null;
  }
  // Pre-v1.2 hosts don't send the whole-host-tree aggregate, so fall back to
  // the host app process plus the tracked owner trees.
  const base =
    hostTree === null
      ? legacyHeadlineSummary(app, owners)
      : {
          cpuPercent: hostTree.cpuPercent,
          rssBytes: hostTree.rssBytes,
          trackedProcessCount: hostTree.processCount,
        };
  const desktop = desktopResourceSummary(desktopApp);

  return {
    cpuPercent: base.cpuPercent + desktop.cpuPercent,
    rssBytes: base.rssBytes + desktop.rssBytes,
    trackedProcessCount: base.trackedProcessCount + desktop.processCount,
  };
}

function legacyHeadlineSummary(
  app: AppResourceUsage | null,
  owners: readonly OwnerResourceSnapshotWireV13[],
): TaskResourceSummary {
  return owners.reduce(
    (summary, owner) => ({
      cpuPercent: summary.cpuPercent + owner.cpuPercent,
      rssBytes: summary.rssBytes + owner.rssBytes,
      trackedProcessCount: summary.trackedProcessCount + owner.processCount,
    }),
    {
      cpuPercent: app?.cpuPercent ?? 0,
      rssBytes: app?.rssBytes ?? 0,
      trackedProcessCount: app?.processCount ?? 0,
    },
  );
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
  readonly expandedOwners: ReadonlySet<string>;
  readonly expandedProcesses: ReadonlySet<string>;
  readonly sortOption: ResourceSortOption;
  readonly onToggleOwner: (key: string) => void;
  readonly onToggleProcess: (key: string) => void;
  readonly onOpenOwner: (row: OwnerDisplayRow) => void;
  readonly kill: ResourceKillApi;
}) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (header === null) return;
    const updateHeight = () => setHeaderHeight(header.offsetHeight);
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="border-b border-border/50 py-1 last:border-b-0">
      <div
        ref={headerRef}
        className={cn(
          "flex items-center justify-between px-3.5 py-1.5",
          STICKY_SECTION_HEADER,
        )}
      >
        <span className="min-w-0 truncate text-ui-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {props.task.label}
        </span>
        <div className="flex items-center">
          <MetricPair
            cpuPercent={props.task.cpuPercent}
            rssBytes={props.task.rssBytes}
            className="text-ui-sm text-foreground/90"
          />
          <span className={ROW_ACTION_SLOT} />
        </div>
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
            expanded={props.expandedOwners.has(key)}
            expandedProcesses={props.expandedProcesses}
            sortOption={props.sortOption}
            stickyTop={headerHeight}
            onToggle={() => props.onToggleOwner(key)}
            onToggleProcess={props.onToggleProcess}
            onOpen={() => props.onOpenOwner(row)}
            kill={props.kill}
          />
        );
      })}
    </div>
  );
}

function OtherResourceSection(props: {
  readonly other: OtherResourceSnapshotWire;
  readonly expandedProcesses: ReadonlySet<string>;
  readonly sortOption: ResourceSortOption;
  readonly onToggleProcess: (key: string) => void;
  readonly kill: ResourceKillApi;
  readonly killHostId: string | null;
}) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  // Collapsed by default: the header aggregate says everything most users
  // need; the per-root breakdown (provider servers, probes, misc children)
  // is inspect-on-demand, matching collapsed-by-default owner trees.
  const [expanded, setExpanded] = useState(false);
  const processRows = buildProcessRows(
    props.other.processes,
    props.expandedProcesses,
    props.other,
    props.sortOption,
  );

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (header === null) return;
    const updateHeight = () => setHeaderHeight(header.offsetHeight);
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="border-b border-border/50 py-1 last:border-b-0">
      <div
        ref={headerRef}
        className={cn(
          "flex items-center justify-between px-3.5 py-1.5",
          STICKY_SECTION_HEADER,
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={
            expanded ? "Collapse other processes" : "Expand other processes"
          }
          onClick={() => setExpanded((previous) => !previous)}
          className="flex min-w-0 items-center gap-1 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 truncate text-ui-xs font-semibold uppercase tracking-wide">
            Other
          </span>
        </button>
        <div className="flex items-center">
          <MetricPair
            cpuPercent={processRows.treeCpuPercent}
            rssBytes={processRows.treeRssBytes}
            className="text-ui-sm text-foreground/90"
          />
          <span className={ROW_ACTION_SLOT} />
        </div>
      </div>
      {!expanded
        ? null
        : processRows.rootRows.map((processRow) => (
            <ProcessTreeRow
              key={processRowKey(processRow.process)}
              processRow={processRow}
              stickyTop={headerHeight}
              labelMode="compact-root"
              onToggleExpand={props.onToggleProcess}
              kill={props.kill}
              killHostId={props.killHostId}
            />
          ))}
    </div>
  );
}

/** A concrete kill target: a host and the root pids whose trees to terminate. */
interface KillTarget {
  readonly key: string;
  readonly hostId: string;
  readonly pids: readonly number[];
}

/**
 * Kill controls threaded down to killable rows. `selectionMode` toggles the
 * multi-select affordance; the rest drive per-row and bulk kills. `null` for
 * rows that are not killable (the app/host sections never receive it).
 */
interface ResourceKillApi {
  readonly selectionMode: boolean;
  readonly isSelected: (key: string) => boolean;
  readonly toggleSelection: (target: KillTarget) => void;
  readonly killOne: (target: KillTarget) => void;
  readonly isKilling: boolean;
}

/**
 * Per-row kill affordance: hidden until the row is hovered/focused, then a
 * two-step INLINE confirm (no modal) - the trash icon arms, swapping to a
 * "Kill / cancel" pair. Escaping hover disarms it. Mirrors the chat-nav
 * `StopAffordance` reveal + the sidebar destructive-ghost styling.
 */
function KillRowButton(props: {
  readonly target: KillTarget;
  readonly label: string;
  readonly onKill: (target: KillTarget) => void;
  readonly isKilling: boolean;
}) {
  const [armed, setArmed] = useState(false);
  if (armed) {
    // Armed confirm floats over the row's right edge as a small panel (the
    // row wrapper is `relative`), instead of squeezing beside the metrics -
    // nothing shifts or clips while confirming.
    return (
      <>
        <span className={ROW_ACTION_SLOT} />
        <span className="absolute inset-y-0 right-2 z-30 my-auto flex h-7 items-center gap-0.5 rounded-md border border-border/60 bg-popover px-1 shadow-sm">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-5 px-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={props.isKilling}
            aria-label={`Confirm kill ${props.label}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onKill(props.target);
              setArmed(false);
            }}
          >
            Confirm
            {props.isKilling ? (
              <AgentSpinningDots
                className="ml-1"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-5 px-1.5 text-muted-foreground hover:text-foreground"
            aria-label={`Keep ${props.label} running`}
            onClick={(event) => {
              event.stopPropagation();
              setArmed(false);
            }}
          >
            Cancel
          </Button>
        </span>
      </>
    );
  }
  // Text label, not an icon: a bin reads as "delete this agent's state" and a
  // stop glyph reads as "stop the turn", but this only terminates the process
  // tree. The word carries the meaning unambiguously.
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="h-6 shrink-0 px-1.5 text-destructive opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
      aria-label={`Kill ${props.label}`}
      onClick={(event) => {
        event.stopPropagation();
        setArmed(true);
      }}
    >
      Kill
    </Button>
  );
}

/**
 * The owner row's leading cell: a select checkbox when the row is killable and
 * selection mode is on, otherwise the expand chevron (or a spacer when the tree
 * has no descendants). Owns the selection branching so `OwnerTreeRow` stays flat.
 */
function OwnerRowLeadingCell(props: {
  readonly kill: ResourceKillApi | null;
  readonly canKill: boolean;
  readonly target: KillTarget;
  readonly label: string;
  readonly canExpand: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const kill = props.kill ?? null;
  if (kill !== null && props.canKill && kill.selectionMode) {
    return (
      <span className="ml-3 flex size-6 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          className="size-3.5 accent-destructive"
          checked={kill.isSelected(props.target.key)}
          aria-label={`Select ${props.label}`}
          onChange={() => kill.toggleSelection(props.target)}
        />
      </span>
    );
  }
  if (!props.canExpand) {
    return <span className="ml-3 size-6 shrink-0" />;
  }
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      onClick={props.onToggle}
      className="ml-3 flex size-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
      aria-label={
        props.expanded ? "Collapse process tree" : "Expand process tree"
      }
    >
      {props.expanded ? (
        <ChevronDown className="size-3.5" />
      ) : (
        <ChevronRight className="size-3.5" />
      )}
    </button>
  );
}

/** Trailing kill affordance for an owner row (hidden in selection mode). */
function OwnerRowKillCell(props: {
  readonly kill: ResourceKillApi | null;
  readonly canKill: boolean;
  readonly target: KillTarget;
  readonly label: string;
}) {
  const kill = props.kill ?? null;
  if (kill === null || !props.canKill || kill.selectionMode) {
    return <span className={ROW_ACTION_SLOT} />;
  }
  return (
    <span className={ROW_ACTION_SLOT}>
      <KillRowButton
        target={props.target}
        label={props.label}
        onKill={kill.killOne}
        isKilling={kill.isKilling}
      />
    </span>
  );
}

/**
 * Index of currently-killable rows. `live` holds every selectable key so a
 * selection whose process exited on its own is pruned at read time; `topLevel`
 * holds the owner-row / Other-root targets "Select all" operates on
 * (descendant process rows are excluded - killing an owner already takes its
 * whole tree, and counting children would double-count).
 */
function buildKillTargetIndex(
  owners: readonly OwnerResourceUsage[],
  other: OtherResourceUsage | null,
  defaultHostId: string | null,
): {
  readonly live: ReadonlySet<string>;
  readonly topLevel: ReadonlyMap<string, KillTarget>;
} {
  const live = new Set<string>();
  const topLevel = new Map<string, KillTarget>();
  for (const owner of owners) {
    const key = ownerKey(
      owner.owner.epicId,
      owner.owner.kind,
      owner.owner.ownerId,
    );
    live.add(key);
    if (owner.rootPids.length > 0) {
      topLevel.set(key, {
        key,
        hostId: owner.owner.hostId,
        pids: owner.rootPids,
      });
    }
    for (const process of owner.processes) live.add(processRowKey(process));
  }
  if (other !== null && defaultHostId !== null) {
    for (const process of other.processes) {
      const key = processRowKey(process);
      live.add(key);
      if (process.rootPid === process.pid) {
        topLevel.set(key, { key, hostId: defaultHostId, pids: [process.pid] });
      }
    }
  }
  return { live, topLevel };
}

function SelectAllToggle(props: {
  readonly allSelected: boolean;
  readonly onSelectAll: () => void;
  readonly onDeselectAll: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="h-6 px-1.5 text-muted-foreground hover:text-foreground"
      onClick={props.allSelected ? props.onDeselectAll : props.onSelectAll}
    >
      {props.allSelected ? "Deselect all" : "Select all"}
    </Button>
  );
}

/**
 * In selection mode the whole owner row is a selection toggle - it must NOT
 * navigate to the owner's tile. Outside selection mode it opens the tile.
 */
function ownerRowClickHandler(
  selecting: boolean,
  kill: ResourceKillApi | null,
  target: KillTarget,
  onOpen: () => void,
): () => void {
  if (!selecting || kill === null) return onOpen;
  return () => kill.toggleSelection(target);
}

/**
 * Provider icon for an owner row's subtitle, or a neutral glyph for a
 * harness-less owner. Subscript-scale (`size-3`) so it reads as part of the
 * secondary text line, not a second row element.
 */
function OwnerProviderIcon(props: { readonly harnessId: string | null }) {
  const providerId =
    props.harnessId === null ? null : normalizeProviderId(props.harnessId);
  if (providerId === null) {
    return <Server className="size-3 shrink-0 text-muted-foreground/70" />;
  }
  return <HarnessIcon harnessId={providerId} className="size-3" />;
}

function OwnerTreeRow(props: {
  readonly row: OwnerDisplayRow;
  readonly expanded: boolean;
  readonly expandedProcesses: ReadonlySet<string>;
  readonly sortOption: ResourceSortOption;
  readonly stickyTop: number;
  readonly onToggle: () => void;
  readonly onToggleProcess: (key: string) => void;
  readonly onOpen: () => void;
  readonly kill: ResourceKillApi | null;
}) {
  const owner = props.row.snapshot.owner;
  const liveArtifactTitle = useRegisteredEpicLiveArtifactTitle(
    owner.epicId,
    owner.kind === "terminal" ? null : owner.ownerId,
  );
  const label = ownerLabel(
    props.row.snapshot,
    props.row.location,
    props.row.record,
    liveArtifactTitle,
  );
  const processRows = buildProcessRows(
    props.row.snapshot.processes,
    props.expandedProcesses,
    props.row.snapshot,
    props.sortOption,
  );
  const visibleCpuPercent = props.expanded
    ? processRows.selfCpuPercent
    : processRows.treeCpuPercent;
  const visibleRssBytes = props.expanded
    ? processRows.selfRssBytes
    : processRows.treeRssBytes;
  const harnessId = props.row.snapshot.harnessId;
  const killTarget: KillTarget = {
    key: ownerKey(owner.epicId, owner.kind, owner.ownerId),
    hostId: owner.hostId,
    pids: props.row.snapshot.rootPids,
  };
  const kill = props.kill ?? null;
  const canKill = kill !== null && killTarget.pids.length > 0;
  const selecting = kill !== null && canKill && kill.selectionMode;
  const selected = selecting && kill.isSelected(killTarget.key);
  const rowClick = ownerRowClickHandler(
    selecting,
    kill,
    killTarget,
    props.onOpen,
  );
  return (
    <div>
      <div
        className={cn(
          "group relative flex items-center pr-3.5 transition-colors hover:bg-muted/50",
          selected && "bg-muted/40",
          props.expanded && "sticky z-10 bg-popover",
        )}
        style={props.expanded ? { top: props.stickyTop } : undefined}
      >
        <OwnerRowLeadingCell
          kill={kill}
          canKill={canKill}
          target={killTarget}
          label={label}
          canExpand={processRows.canExpand}
          expanded={props.expanded}
          onToggle={props.onToggle}
        />
        <button
          type="button"
          onClick={rowClick}
          disabled={!selecting && !props.row.canOpen}
          className={cn(
            "flex min-w-0 flex-1 items-center justify-between gap-3 py-1.5 pl-1 text-left transition-colors",
            props.row.canOpen
              ? "text-foreground hover:text-foreground"
              : "cursor-default text-foreground",
          )}
        >
          <div className="min-w-0">
            <div className="truncate text-ui-sm">{label}</div>
            <div className="flex min-w-0 items-center gap-1 text-ui-xs text-muted-foreground">
              <OwnerProviderIcon harnessId={harnessId} />
              <span className="min-w-0 truncate">
                {harnessProviderSubtitle(
                  harnessId,
                  props.row.snapshot.owner.kind,
                  props.row.snapshot.activeProcessName,
                )}
              </span>
            </div>
          </div>
          <ProcessMetricPair
            cpuPercent={visibleCpuPercent}
            rssBytes={visibleRssBytes}
            selfCpuPercent={processRows.selfCpuPercent}
            selfRssBytes={processRows.selfRssBytes}
            treeCpuPercent={processRows.treeCpuPercent}
            treeRssBytes={processRows.treeRssBytes}
            hasDescendants={processRows.canExpand}
            className="text-ui-sm text-foreground/90"
          />
        </button>
        <OwnerRowKillCell
          kill={kill}
          canKill={canKill}
          target={killTarget}
          label={label}
        />
      </div>
      {!props.expanded
        ? null
        : processRows.rows.map((processRow) => (
            <ProcessTreeRow
              key={processRowKey(processRow.process)}
              processRow={processRow}
              stickyTop={props.stickyTop}
              labelMode="full"
              onToggleExpand={props.onToggleProcess}
              kill={props.kill}
              killHostId={owner.hostId}
            />
          ))}
    </div>
  );
}

function ProcessRowMarker(props: {
  readonly canExpand: boolean;
  readonly expanded: boolean;
}) {
  if (!props.canExpand) {
    return (
      <span className="size-1 shrink-0 rounded-full bg-muted-foreground/40" />
    );
  }
  return props.expanded ? (
    <ChevronDown className="size-3 shrink-0 text-muted-foreground/70" />
  ) : (
    <ChevronRight className="size-3 shrink-0 text-muted-foreground/70" />
  );
}

/**
 * Trailing kill cell for a process row: a select checkbox in selection mode,
 * otherwise the hover-revealed kill button. Killing a process pid terminates
 * its whole subtree (the host enumerates descendants). `null` host or kill api
 * renders nothing (a spacer), keeping the row width stable.
 */
function ProcessRowKillCell(props: {
  readonly kill: ResourceKillApi | null;
  readonly killHostId: string | null;
  readonly process: ResourceProcessSnapshotWire;
  readonly label: string;
}) {
  // `?? null` collapses undefined to null: a partial HMR update can transiently
  // render this row before a parent passes `kill`, and a hover affordance must
  // never crash the whole popover.
  const kill = props.kill ?? null;
  const killHostId = props.killHostId ?? null;
  if (kill === null || killHostId === null) {
    return <span className={ROW_ACTION_SLOT} />;
  }
  const target: KillTarget = {
    key: processRowKey(props.process),
    hostId: killHostId,
    pids: [props.process.pid],
  };
  if (kill.selectionMode) {
    // The selection checkbox lives on the row's LEFT (matching the chat /
    // artifact selection convention); keep the trailing gutter as a spacer.
    return <span className={ROW_ACTION_SLOT} />;
  }
  return (
    <KillRowButton
      target={target}
      label={props.label}
      onKill={kill.killOne}
      isKilling={kill.isKilling}
    />
  );
}

function processCollapsedLabel(
  labelMode: "full" | "compact-root",
  process: ResourceProcessSnapshotWire,
  hiddenCount: number,
): string {
  return labelMode === "compact-root"
    ? processCompactLeafLabel(process, hiddenCount)
    : processLeafLabel(process, hiddenCount);
}

/**
 * Leading selection checkbox for a process row (left side, matching the
 * chat / artifact selection convention). Renders nothing outside select mode.
 */
function ProcessRowSelectCheckbox(props: {
  readonly visible: boolean;
  readonly selected: boolean;
  readonly label: string;
  readonly onToggle: (() => void) | null;
}) {
  const onToggle = props.onToggle;
  if (!props.visible || onToggle === null) return null;
  return (
    <span className="ml-3 flex size-6 shrink-0 items-center justify-center">
      <input
        type="checkbox"
        className="size-3.5 accent-destructive"
        checked={props.selected}
        aria-label={`Select ${props.label}`}
        onChange={() => onToggle()}
      />
    </span>
  );
}

function ProcessTreeRow(props: {
  readonly processRow: ProcessDisplayRow;
  readonly stickyTop: number;
  readonly labelMode: "full" | "compact-root";
  readonly onToggleExpand: (key: string) => void;
  readonly kill: ResourceKillApi | null;
  readonly killHostId: string | null;
}) {
  const {
    process,
    depth,
    canExpand,
    expanded,
    hiddenCount,
    treeCpuPercent,
    treeRssBytes,
  } = props.processRow;
  const kill = props.kill ?? null;
  const killHostId = props.killHostId ?? null;
  const selecting = kill !== null && killHostId !== null && kill.selectionMode;
  const rowKey = processRowKey(process);
  const selected = selecting && kill.isSelected(rowKey);
  const rowClassName =
    "flex min-w-0 flex-1 items-center justify-between gap-3 py-1 pl-3.5 text-left text-muted-foreground transition-colors hover:bg-muted/40";
  const rowStyle = { paddingLeft: `calc(1.25rem + ${depth} * 1rem)` };
  const collapsedLabel = processCollapsedLabel(
    props.labelMode,
    process,
    hiddenCount,
  );
  const shownMetrics = expanded
    ? { cpu: process.cpuPercent, rss: process.rssBytes }
    : { cpu: treeCpuPercent, rss: treeRssBytes };
  const inner = (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <ProcessRowMarker canExpand={canExpand} expanded={expanded} />
        <span className="min-w-0 truncate text-ui-xs">
          {expanded ? processLabel(process) : collapsedLabel}
        </span>
      </div>
      <ProcessMetricPair
        cpuPercent={shownMetrics.cpu}
        rssBytes={shownMetrics.rss}
        selfCpuPercent={process.cpuPercent}
        selfRssBytes={process.rssBytes}
        treeCpuPercent={treeCpuPercent}
        treeRssBytes={treeRssBytes}
        hasDescendants={canExpand}
        className="text-ui-xs text-muted-foreground/80"
      />
    </>
  );
  // In selection mode EVERY row is a whole-row selection toggle (expand is
  // suspended, mirroring owner rows). Otherwise leaf and non-boundary rows are
  // static; only an expand boundary is an interactive, keyboard-reachable
  // toggle that reveals its sub-tree inline.
  let row;
  if (selecting) {
    row = (
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Select ${processLabel(process)}`}
        onClick={() =>
          kill.toggleSelection({
            key: rowKey,
            hostId: killHostId,
            pids: [process.pid],
          })
        }
        className={cn(
          rowClassName,
          "outline-none focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        )}
        style={rowStyle}
      >
        {inner}
      </button>
    );
  } else if (!canExpand) {
    row = (
      <div className={rowClassName} style={rowStyle}>
        {inner}
      </div>
    );
  } else {
    row = (
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} sub-processes of ${processLabel(process)}`}
        onClick={() => props.onToggleExpand(processRowKey(process))}
        className={cn(
          rowClassName,
          "outline-none focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        )}
        style={rowStyle}
      >
        {inner}
      </button>
    );
  }
  return (
    <div>
      <div
        className={cn(
          "group relative flex items-center pr-3.5",
          selected && "bg-muted/40",
          expanded && "sticky z-10 bg-popover",
        )}
        style={expanded ? { top: props.stickyTop } : undefined}
      >
        <ProcessRowSelectCheckbox
          visible={selecting}
          selected={selected}
          label={processLabel(process)}
          onToggle={
            selecting
              ? () =>
                  kill.toggleSelection({
                    key: rowKey,
                    hostId: killHostId,
                    pids: [process.pid],
                  })
              : null
          }
        />
        {row}
        <ProcessRowKillCell
          kill={props.kill}
          killHostId={props.killHostId}
          process={process}
          label={processLabel(process)}
        />
      </div>
      {!expanded
        ? null
        : props.processRow.children.map((child) => (
            <ProcessTreeRow
              key={processRowKey(child.process)}
              processRow={child}
              stickyTop={props.stickyTop}
              labelMode="full"
              onToggleExpand={props.onToggleExpand}
              kill={props.kill}
              killHostId={props.killHostId}
            />
          ))}
    </div>
  );
}

function ProcessMetricPair(props: {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly selfCpuPercent: number;
  readonly selfRssBytes: number;
  readonly treeCpuPercent: number;
  readonly treeRssBytes: number;
  readonly hasDescendants: boolean;
  readonly className: string;
}) {
  const metrics = (
    <MetricPair
      cpuPercent={props.cpuPercent}
      rssBytes={props.rssBytes}
      className={props.className}
    />
  );
  if (!props.hasDescendants) return metrics;
  return (
    <TooltipWrapper
      label={
        <div className="space-y-1 text-ui-xs">
          <div>
            Self: {formatCpuPercent(props.selfCpuPercent)} CPU ·{" "}
            {formatMemoryBytes(props.selfRssBytes)} memory
          </div>
          <div>
            Tree: {formatCpuPercent(props.treeCpuPercent)} CPU ·{" "}
            {formatMemoryBytes(props.treeRssBytes)} memory
          </div>
        </div>
      }
      side="left"
      sideOffset={6}
      align="center"
    >
      <div className="shrink-0">{metrics}</div>
    </TooltipWrapper>
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
    const owners = entry.owners.map((snapshot): OwnerDisplayRow => {
      const key = ownerKey(
        snapshot.owner.epicId,
        snapshot.owner.kind,
        snapshot.owner.ownerId,
      );
      const location = input.canvasIndex.locationByOwner.get(key) ?? null;
      const record = input.recordByOwner.get(key) ?? null;
      const processRows = buildProcessRows(
        snapshot.processes,
        NO_EXPANDED_PROCESSES,
        snapshot,
        input.sortOption,
      );
      return {
        snapshot,
        label: ownerLabel(snapshot, location, record, null),
        canOpen: canOpenOwner(snapshot, location, record),
        tabOrder:
          input.canvasIndex.tabOrderByOwner.get(key) ?? Number.MAX_SAFE_INTEGER,
        location,
        record,
        treeCpuPercent: processRows.treeCpuPercent,
        treeRssBytes: processRows.treeRssBytes,
      };
    });
    if (owners.length === 0) return [];
    return [
      {
        entry,
        label: taskLabel(entry.epicId, input.canvas, input.epicTitleById),
        tabOrder: taskTabOrder(entry.epicId, input.canvas),
        cpuPercent: owners.reduce(
          (sum, owner) => sum + owner.treeCpuPercent,
          0,
        ),
        rssBytes: owners.reduce((sum, owner) => sum + owner.treeRssBytes, 0),
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
  const openTabIds = new Set(canvas.openTabOrder);
  // Closing a task only removes its tab from the visible strip; its tab and
  // canvas stay preserved so reopening can restore the exact pane/tile focus.
  // Scan visible tabs first, then retained hidden tabs, so an open location
  // wins when duplicate task tabs contain the same owner.
  const indexedTabIds = [
    ...canvas.openTabOrder,
    ...Object.keys(canvas.tabsById).filter((tabId) => !openTabIds.has(tabId)),
  ];
  const candidates = indexedTabIds.flatMap((tabId) => {
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

function sortDesktopProcessGroups(
  groups: readonly DesktopProcessGroupEntry[],
  sortOption: ResourceSortOption,
): readonly DesktopProcessGroupEntry[] {
  const sorted = [...groups];
  switch (sortOption) {
    case "memory":
      sorted.sort((a, b) => b.usage.rssBytes - a.usage.rssBytes);
      break;
    case "cpu":
      sorted.sort((a, b) => b.usage.cpuPercent - a.usage.cpuPercent);
      break;
    case "name":
      sorted.sort((a, b) => a.label.localeCompare(b.label));
      break;
    case "tab":
      // Process groups have no tab identity; keep the fixed
      // Main / Renderer / Other order.
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
      sorted.sort((a, b) => b.treeRssBytes - a.treeRssBytes);
      break;
    case "cpu":
      sorted.sort((a, b) => b.treeCpuPercent - a.treeCpuPercent);
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
  readonly prepareOpenTileInTabFocusTarget: (
    tabId: string,
    node: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
  readonly prepareSetActiveTileTabFocusTarget: (
    tabId: string,
    paneId: string,
    tileTabId: string,
  ) => NestedFocusTarget | null;
  readonly resolveTargetTabForEpic: (
    epicId: string,
    name: string | undefined,
  ) => string;
  readonly navigate: NavigateFn;
  readonly navigateNested: NavigateNestedFocus;
  readonly activeEpicId: string | null;
  readonly activeTabId: string | null;
  readonly desktopNestedFocusEnabled: boolean;
}): boolean {
  const location = args.row.location;
  if (location !== null) {
    commitOwnerFocus({
      epicId: location.epicId,
      tabId: location.tabId,
      focus: focusForOwner(args.row.snapshot),
      prepare: () =>
        args.prepareSetActiveTileTabFocusTarget(
          location.tabId,
          location.paneId,
          location.tileTabId,
        ),
      navigate: args.navigate,
      navigateNested: args.navigateNested,
      activeEpicId: args.activeEpicId,
      activeTabId: args.activeTabId,
      desktopNestedFocusEnabled: args.desktopNestedFocusEnabled,
    });
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
  const recordType = record.type;
  if (recordType !== "chat" && recordType !== "terminal-agent") return false;
  const targetTabId = args.resolveTargetTabForEpic(
    snapshot.owner.epicId,
    taskLabel(snapshot.owner.epicId, args.canvas, args.epicTitleById),
  );
  commitOwnerFocus({
    epicId: snapshot.owner.epicId,
    tabId: targetTabId,
    focus: focusForOwner(snapshot),
    prepare: () =>
      args.prepareOpenTileInTabFocusTarget(targetTabId, {
        id: record.id,
        instanceId: uuidv4(),
        type: recordType,
        name: record.name,
        hostId: record.hostId,
      }),
    navigate: args.navigate,
    navigateNested: args.navigateNested,
    activeEpicId: args.activeEpicId,
    activeTabId: args.activeTabId,
    desktopNestedFocusEnabled: args.desktopNestedFocusEnabled,
  });
  return true;
}

/**
 * Commits an owner's focus target through the nested-focus opener boundary.
 *
 * Same-route (the owner's tab is already the active route) delegates to
 * `useEpicNestedFocusNavigation` so the search patch, duplicate-target skip,
 * and desktop-only gating stay identical to every other in-place focus
 * change in the app.
 *
 * Cross-route (the owner lives in a different tab, or a different epic, than
 * the active route) prepares the canvas mutation directly - the canvas store
 * is global and keyed by tabId, so preparing a background tab is valid -
 * then commits ONE top-level navigation carrying the prepared nested focus.
 * Arrival then paints the right pane immediately instead of wiping nested
 * search and waiting on route-sync canonicalization to self-heal it back in
 * on a second, asynchronous pass.
 */
function commitOwnerFocus(args: {
  readonly epicId: string;
  readonly tabId: string;
  readonly focus: EpicRouteFocus;
  readonly prepare: () => NestedFocusTarget | null;
  readonly navigate: NavigateFn;
  readonly navigateNested: NavigateNestedFocus;
  readonly activeEpicId: string | null;
  readonly activeTabId: string | null;
  readonly desktopNestedFocusEnabled: boolean;
}): void {
  if (args.epicId === args.activeEpicId && args.tabId === args.activeTabId) {
    args.navigateNested(args.epicId, args.tabId, args.prepare);
    return;
  }
  const nestedFocus = args.prepare();
  navigateToTabIntent(
    args.navigate,
    existingEpicTabIntentWithNestedFocus({
      epicId: args.epicId,
      tabId: args.tabId,
      focus: args.focus,
      nestedFocus: args.desktopNestedFocusEnabled ? nestedFocus : null,
    }),
  );
}

function focusForOwner(snapshot: OwnerResourceSnapshotWireV13) {
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
  snapshot: OwnerResourceSnapshotWireV13,
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
  // Three owner kinds render side by side here, so a raw Terminal has to stay
  // distinguishable from an Agent using the Terminal interface - qualification
  // is warranted. It uses the interface axis rather than coining "Chat agent" /
  // "Terminal agent" as sibling nouns, which would restate the entity model the
  // rename removes.
  if (kind === "terminal") return "Terminal";
  if (kind === "terminal-agent") return "Agent (Terminal)";
  return "Agent (Chat)";
}

// Subtitle beside the provider icon. Always non-empty so the icon never sits
// alone on its line: a known provider shows its friendly name ("Claude Code"),
// a harness-less owner (plain terminal) keeps its kind label; the running
// process name trails either when present.
function harnessProviderSubtitle(
  harnessId: string | null,
  kind: ResourceOwnerKindWire,
  activeProcessName: string | null,
): string {
  const providerId = harnessId === null ? null : normalizeProviderId(harnessId);
  const base =
    providerId === null ? ownerKindLabel(kind) : agentProviderLabel(providerId);
  return activeProcessName === null ? base : `${base} · ${activeProcessName}`;
}

function ownerLabel(
  snapshot: OwnerResourceSnapshotWireV13,
  location: OpenOwnerLocation | null,
  record: EpicNodeRecord | null,
  liveArtifactTitle: string | null,
): string {
  if (snapshot.owner.kind === "terminal") {
    if (
      location?.ref.type === "terminal" &&
      location.ref.titleSource === "manual"
    ) {
      return location.ref.name;
    }
    return terminalSessionTitle({
      title: null,
      activeProcessName: snapshot.activeProcessName,
    });
  }
  if (snapshot.owner.kind === "chat") {
    // Durable Agent read surface: an untitled Chat-interface Agent falls back
    // to "Untitled agent" (this light surface carries no first-user-message to
    // derive from).
    return displayTitle(
      liveArtifactTitle || location?.ref.name || record?.name || "",
      "agent",
    );
  }
  if (liveArtifactTitle !== null) return liveArtifactTitle;
  if (location !== null) return location.ref.name;
  if (record !== null) return record.name;
  return ownerKindLabel(snapshot.owner.kind);
}

function canOpenOwner(
  snapshot: OwnerResourceSnapshotWireV13,
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
  return leafLabelFrom(processLabel(process), hiddenCount);
}

/**
 * Compact label for an unattributed (Other) root: the executable basename
 * rather than the full command path, which for provider binaries is a long
 * install path that adds no signal at the collapsed level. The full command
 * remains visible on the expanded row.
 */
function processCompactLeafLabel(
  process: ResourceProcessSnapshotWire,
  hiddenCount: number,
): string {
  return leafLabelFrom(processBasename(process), hiddenCount);
}

function processBasename(process: ResourceProcessSnapshotWire): string {
  const source = process.name.length > 0 ? process.name : processLabel(process);
  const segments = source.split("/");
  const base = segments[segments.length - 1];
  return base.length > 0 ? base : source;
}

function leafLabelFrom(label: string, hiddenCount: number): string {
  if (hiddenCount === 0) return label;
  return `${label} (${countLabel(hiddenCount, "sub-process", "sub-processes")})`;
}

function processRowKey(process: ResourceProcessSnapshotWire): string {
  return `${process.rootPid}:${process.pid}`;
}

/**
 * Comparator for sibling process rows. Sorts on the SUBTREE aggregates, not a
 * process's own usage, so a parent with a heavy descendant bubbles above a
 * lighter sibling even while collapsed - matching the inclusive values the
 * collapsed rows display. "tab" has no meaning for OS processes; null keeps
 * the host's wire order.
 */
function processRowComparator(
  sortOption: ResourceSortOption,
): ((a: ProcessDisplayRow, b: ProcessDisplayRow) => number) | null {
  switch (sortOption) {
    case "memory":
      return (a, b) => b.treeRssBytes - a.treeRssBytes;
    case "cpu":
      return (a, b) => b.treeCpuPercent - a.treeCpuPercent;
    case "name":
      return (a, b) =>
        processLabel(a.process).localeCompare(processLabel(b.process));
    case "tab":
      return null;
  }
}

function buildProcessRows(
  processes: readonly ResourceProcessSnapshotWire[],
  expandedKeys: ReadonlySet<string>,
  fallback: { readonly cpuPercent: number; readonly rssBytes: number },
  sortOption: ResourceSortOption,
): OwnerProcessRows {
  if (processes.length === 0) {
    return {
      rows: [],
      rootRows: [],
      canExpand: false,
      selfCpuPercent: fallback.cpuPercent,
      selfRssBytes: fallback.rssBytes,
      treeCpuPercent: fallback.cpuPercent,
      treeRssBytes: fallback.rssBytes,
    };
  }

  const processByPid = new Map(
    processes.map((process) => [process.pid, process]),
  );
  const childrenByParent = processes.reduce((byParent, process) => {
    if (process.parentPid === null || !processByPid.has(process.parentPid)) {
      return byParent;
    }
    const siblings = byParent.get(process.parentPid) ?? [];
    siblings.push(process);
    byParent.set(process.parentPid, siblings);
    return byParent;
  }, new Map<number, ResourceProcessSnapshotWire[]>());

  // Rootness is purely structural: parentless, or parent outside this list.
  // `pid === rootPid` must NOT qualify — an owner can carry a second tracked
  // root that is an OS descendant of its first (e.g. a harness child under the
  // owner's PTY), and counting it as a root while `childrenByParent` also
  // attaches it under its in-list parent would double-count its subtree.
  const roots = processes.filter(
    (process) =>
      process.parentPid === null || !processByPid.has(process.parentPid),
  );
  const completeRoots = roots.length === 0 ? processes : roots;

  const compareRows = processRowComparator(sortOption);
  const sortSiblingRows = (
    siblingRows: readonly ProcessDisplayRow[],
  ): readonly ProcessDisplayRow[] =>
    compareRows === null ? siblingRows : [...siblingRows].sort(compareRows);

  const buildRow = (
    process: ResourceProcessSnapshotWire,
    depth: number,
    ancestors: ReadonlySet<number>,
  ): ProcessDisplayRow => {
    const childProcesses = (childrenByParent.get(process.pid) ?? []).filter(
      (child) => !ancestors.has(child.pid),
    );
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(process.pid);
    const children = sortSiblingRows(
      childProcesses.map((child) => buildRow(child, depth + 1, nextAncestors)),
    );
    const treeCpuPercent = children.reduce(
      (sum, child) => sum + child.treeCpuPercent,
      process.cpuPercent,
    );
    const treeRssBytes = children.reduce(
      (sum, child) => sum + child.treeRssBytes,
      process.rssBytes,
    );
    return {
      process,
      depth,
      canExpand: children.length > 0,
      expanded: children.length > 0 && expandedKeys.has(processRowKey(process)),
      hiddenCount: children.reduce(
        (sum, child) => sum + 1 + child.hiddenCount,
        0,
      ),
      treeCpuPercent,
      treeRssBytes,
      children,
    };
  };

  const rootRows = sortSiblingRows(
    completeRoots.map((root) => buildRow(root, 0, new Set())),
  );
  const rows = rootRows.flatMap((root) => root.children);
  return {
    rows,
    rootRows,
    canExpand: rows.length > 0,
    selfCpuPercent: rootRows.reduce(
      (sum, root) => sum + root.process.cpuPercent,
      0,
    ),
    selfRssBytes: rootRows.reduce(
      (sum, root) => sum + root.process.rssBytes,
      0,
    ),
    treeCpuPercent: rootRows.reduce(
      (sum, root) => sum + root.treeCpuPercent,
      0,
    ),
    treeRssBytes: rootRows.reduce((sum, root) => sum + root.treeRssBytes, 0),
  };
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${formatProcessCount(count)} ${count === 1 ? singular : plural}`;
}
