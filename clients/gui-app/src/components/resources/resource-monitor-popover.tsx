import {
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  PointerEvent,
} from "react";
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
  MessagesSquare,
  Monitor,
  Search,
  Server,
  X,
} from "lucide-react";
import type {
  ManagedCommandOwnerWire,
  OwnerResourceSnapshotWireV14,
  HostTreeResourceSnapshotWire,
  OtherResourceSnapshotWire,
  ResourceOwnerKindWireV14,
  ResourceProcessSnapshotWire,
} from "@traycer/protocol/host/resources/subscribe";
import type { TaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import type { EpicNodeRecord } from "@/lib/artifacts/node-display";
import { displayTitle } from "@/lib/display-title";
import { useRegisteredEpicLiveArtifactTitles } from "@/lib/epic-selectors";
import { terminalSessionTitle } from "@/lib/terminals/terminal-title";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  AgentSpinningDots,
  MutedAgentSpinner,
} from "@/components/ui/agent-spinning-dots";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { isHostSwitcherListInteraction } from "@/components/settings/host-scope/host-switcher-portal";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import { PlanRestrictedUpgradeAction } from "@/components/settings/host-scope/plan-restricted-upgrade-action";
import { useScopedStreamBinding } from "@/components/settings/host-scope/use-scoped-stream-binding";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useResourceMonitorHostScope } from "@/hooks/resources/use-resource-monitor-host-scope";
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import { ManagedCommandMonitorIcon } from "@/components/managed-commands/managed-command-monitor-icon";
import { ManagedCommandStopButton } from "@/components/managed-commands/managed-command-action-buttons";
import { useManagedCommandStop } from "@/hooks/managed-command/use-managed-command-lifecycle-mutations";
import {
  MANAGED_COMMAND_NOUN,
  managedCommandTitle,
} from "@/lib/managed-commands/managed-command-copy";
import { normalizeProviderId } from "@/components/home/data/landing-options";
import { useResourcesKill } from "@/hooks/resources/use-resources-kill-mutation";
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
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import {
  EMPTY_GLOBAL_RESOURCE_PROJECTION,
  useGlobalResourceProjection,
  type GlobalResourceEpicEntry,
  type GlobalResourceProjection,
} from "@/stores/resources/resources-registry";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { GlobalResourcesStreamMount } from "@/providers/resources-stream-mount";
import { useGlobalResourcesUnsupported } from "@/hooks/resources/use-global-resources-unsupported";
import {
  StreamRuntimeContext,
  useStreamMethodSchemaVersion,
} from "@/lib/host/stream-runtime-context";
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
  activateTabIntent,
  resourceEpicTabIntent,
  type EpicPostResolvePreparation,
  type EpicRouteFocus,
} from "@/lib/tab-navigation";
import { cn } from "@/lib/utils";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { ClosedTilePayload } from "@/stores/epics/canvas/store";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
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
/** Row actions stay out of the way until the row is hovered or focused. */
const ROW_HOVER_REVEAL =
  "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100";
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
  readonly closedTilePayloadsByTabId: Readonly<
    Record<
      string,
      Readonly<Record<string, ClosedTilePayload | undefined>> | undefined
    >
  >;
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

/**
 * A closed tile whose payload is preserved in `closedTilePayloadsByTabId`.
 * The preserved ref carries everything needed to reopen the tile (for a
 * terminal: name, titleSource, cwd - none of which the resource wire
 * snapshot has), so an owner without a live tile stays clickable, matching
 * how notification clicks reopen closed terminal/agent tiles.
 */
interface ClosedOwnerTile {
  readonly tabId: string;
  readonly node: EpicNodeRef;
}

interface CanvasResourceIndex {
  readonly locationByOwner: ReadonlyMap<string, OpenOwnerLocation>;
  readonly closedTileByOwner: ReadonlyMap<string, ClosedOwnerTile>;
  readonly tabOrderByOwner: ReadonlyMap<string, number>;
}

interface CanvasOwnerCandidate {
  readonly key: string;
  readonly location: OpenOwnerLocation | null;
}

interface OwnerDisplayRow {
  readonly snapshot: OwnerResourceSnapshotWireV14;
  readonly label: string;
  readonly canOpen: boolean;
  readonly tabOrder: number;
  readonly location: OpenOwnerLocation | null;
  readonly closedTile: ClosedOwnerTile | null;
  readonly record: EpicNodeRecord | null;
  /**
   * The shells this row's agent created, nested behind its chevron. Empty for
   * every row that is not a creator - a shell itself never has shells.
   */
  readonly shells: readonly OwnerDisplayRow[];
  /**
   * A Synthetic Agent Row: the stand-in for a creator whose own program is not
   * running while its shells still are. It owns no processes (its snapshot is
   * an honest all-zero one the GUI builds), so it can neither be killed nor
   * report usage of its own - it exists to carry the agent's name, its
   * navigation, and its shells' combined total.
   */
  readonly synthetic: boolean;
  /** Subtree total: this row's own process tree plus its shells' trees. */
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
  readonly searchForcesExpanded: boolean;
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

interface ResourceSearchProjection {
  readonly desktopApp: DesktopAppResourceUsage | null;
  readonly hostApp: AppResourceUsage | null;
  readonly other: OtherResourceUsage | null;
  readonly taskRows: readonly TaskDisplayRow[];
  readonly visibleOwnerKeys: ReadonlySet<string>;
  readonly visibleKillKeys: ReadonlySet<string>;
  readonly active: boolean;
  readonly noResults: boolean;
}

interface RowActionTargetIndexInput {
  readonly owners: readonly OwnerResourceUsage[];
  readonly other: OtherResourceUsage | null;
  readonly defaultHostId: string | null;
  readonly visibleOwnerKeys: ReadonlySet<string>;
  readonly visibleKillKeys: ReadonlySet<string>;
  readonly searchQuery: string;
}

const NO_EXPANDED_PROCESSES: ReadonlySet<string> = new Set();

/**
 * Marks the panel body so `PopoverContent`'s `onInteractOutside` can tell an
 * interaction that really is outside from one Radix only reports that way
 * because the sort menu's own layer is on top. A DOM marker rather than a ref
 * handed down: the guard lives on the element's ANCESTOR, so a ref would have
 * to cross a component boundary as a prop, which nothing else here needs.
 */
const RESOURCE_MONITOR_PANEL_ATTRIBUTE = "data-resource-monitor-panel";
const RESOURCE_SEARCH_ATTRIBUTE = "data-resource-search";
const RESOURCE_NAVIGATION_KEY_ATTRIBUTE = "data-resource-navigation-key";
const RESOURCE_ACTION_KEY_ATTRIBUTE = "data-resource-action-key";
const RESOURCE_CONFIRMATION_ATTRIBUTE = "data-resource-confirmation";

// For process rows that can never expand (e.g. the host's single root process).
function noProcessToggle(): void {}

function resourceNavigationButtons(
  panel: HTMLDivElement,
): ReadonlyArray<HTMLButtonElement> {
  return Array.from(
    panel.querySelectorAll<HTMLButtonElement>(
      `button[${RESOURCE_NAVIGATION_KEY_ATTRIBUTE}]:not(:disabled)`,
    ),
  );
}

function moveResourceNavigationFocus(
  panel: HTMLDivElement,
  current: HTMLElement,
  direction: 1 | -1,
): boolean {
  const rows = resourceNavigationButtons(panel);
  if (rows.length === 0) return false;
  const currentIndex = rows.findIndex((row) => row === current);
  let nextIndex: number;
  if (currentIndex >= 0) {
    nextIndex = (currentIndex + direction + rows.length) % rows.length;
  } else {
    nextIndex = direction > 0 ? 0 : rows.length - 1;
  }
  rows[nextIndex]?.focus();
  return true;
}

function armResourceRowAction(
  panel: HTMLDivElement,
  navigationKey: string,
): boolean {
  const actionContainer = Array.from(
    panel.querySelectorAll<HTMLElement>(`[${RESOURCE_ACTION_KEY_ATTRIBUTE}]`),
  ).find(
    (element) =>
      element.getAttribute(RESOURCE_ACTION_KEY_ATTRIBUTE) === navigationKey,
  );
  const button = actionContainer?.querySelector<HTMLButtonElement>("button");
  if (button === undefined || button === null || button.disabled) return false;
  button.click();
  return true;
}

/**
 * Header trigger for the resource monitor, scoped to the host its own picker
 * selected.
 *
 * The scope is resolved HERE, above both the stream mount and the panel, and
 * re-provided as this subtree's `StreamRuntimeContext`. That one swap is what
 * re-targets the whole surface: `resources.subscribe` is a STREAM, so unlike
 * the usage popover (whose reads are unary RPCs behind `HostRuntimeContext`)
 * the transport that has to move is the streaming one. The unary context is
 * deliberately left alone — every mutation this panel fires already pins its
 * own transient client to the row's `hostId` (`resources.kill`,
 * `managedCommand.stop`), and the host directory the picker itself reads is
 * app-wide.
 *
 * `useScopedStreamBinding` returns null while the pick is the active host, or
 * while it has not resolved to its own client — in both cases the value below
 * falls back to the AMBIENT binding, which is exactly what this subtree read
 * before there was a picker at all.
 *
 * The provider is rendered unconditionally, and that is load-bearing rather
 * than tidiness: mounting it only when a scoped binding exists changes the
 * element type at this position the moment a pick resolves, so React would
 * unmount the whole subtree and take the popover's own `open` state with it —
 * closing the panel the instant a host was chosen from the picker inside it.
 */
export function ResourceMonitorPopover(props: ResourceMonitorPopoverProps) {
  const { scope, hasExplicitPick } = useResourceMonitorHostScope();
  const scopedStreamBinding = useScopedStreamBinding(scope);
  const ambientStreamBinding = use(StreamRuntimeContext);
  return (
    <StreamRuntimeContext.Provider
      value={scopedStreamBinding ?? ambientStreamBinding}
    >
      <ScopedResourceMonitorPopover
        className={props.className}
        scope={scope}
        hasExplicitPick={hasExplicitPick}
        streamBoundToScope={
          !hasExplicitPick ||
          scope.isViewingActive ||
          scopedStreamBinding !== null
        }
      />
    </StreamRuntimeContext.Provider>
  );
}

function ScopedResourceMonitorPopover(props: {
  readonly className: string | undefined;
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  /** The provided stream client is the picked host's, not a fallback. */
  readonly streamBoundToScope: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const chord = useBindingForAction("app.resources.open");
  useEffect(
    () =>
      registerDynamicActionHandler("app.resources.open", () => {
        setOpen(true);
      }),
    [],
  );
  // While the panel is open, let the header drop its title-bar drag regions so a
  // click on the (otherwise event-swallowing) drag area dismisses the popover.
  useTitleBarDragSuppression("resource-monitor", open);
  const scope = props.scope;
  const tooltipLabel = watchesNamedHost(scope, props.hasExplicitPick)
    ? `Resources · ${scope.hostLabel}`
    : "Resources";
  const tooltip =
    chord === null
      ? tooltipLabel
      : `${tooltipLabel} (${formatChordForDisplay(chord)})`;

  return (
    <>
      {/* Held out of the tree entirely under an unresolved pick, rather than
          mounted and ignored: this mount OPENS a stream, and one opened on the
          ambient host would be sampling processes on a machine nobody asked
          about — and would then have to be disowned by every reader below. */}
      {props.streamBoundToScope ? <GlobalResourcesStreamMount /> : null}
      <Popover open={open} onOpenChange={setOpen}>
        <TooltipWrapper
          // The host belongs in the label only when it is NOT the obvious one.
          // Naming the active host on every hover would train people to ignore
          // the one case the words exist for.
          label={tooltip}
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
          <ResourceMonitorContent
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onClose={() => setOpen(false)}
            scope={scope}
            hasExplicitPick={props.hasExplicitPick}
            streamBoundToScope={props.streamBoundToScope}
          />
        ) : null}
      </Popover>
    </>
  );
}

/**
 * Owns the resource monitor's row-action + multi-select state. Groups selected
 * kill targets by host and merges their pids into one `resources.kill` per
 * host, so a bulk kill is one RPC per host rather than one per row. The host
 * validates every pid against its live tracked set, so an already-dead pid is
 * harmless. Shells are stopped one call each: `managedCommand.stop` names a
 * single command and is idempotent, so a shell already on its way down costs
 * nothing.
 */
function sameResourceKeySet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function useResourceRowActions(
  // Keys of every row currently rendered as actionable. Selection is pruned
  // against this LIVE set at read time (never via an effect), so a selected
  // process that exits on its own stops counting the moment its row drops
  // out of the projection.
  liveKeys: ReadonlySet<string>,
  // Top-level targets (owner rows + Other roots) for "Select all".
  // Deliberately excludes descendant process rows: acting on an owner already
  // takes its whole tree, and counting children would double-count.
  topLevelTargets: ReadonlyMap<string, RowActionTarget>,
): {
  readonly api: ResourceRowActionApi;
  readonly selectionMode: boolean;
  readonly selectedCount: number;
  readonly selectedStopCount: number;
  readonly selectedKillCount: number;
  readonly allVisibleSelected: boolean;
  readonly enterSelection: () => void;
  readonly cancelSelection: () => void;
  readonly selectAllVisible: () => void;
  readonly deselectAllVisible: () => void;
  readonly clearSelection: () => void;
  readonly runSelected: () => void;
  readonly isPending: boolean;
} {
  const killMutation = useResourcesKill();
  const stopMutation = useManagedCommandStop();
  const killPids = killMutation.mutate;
  const stopShell = stopMutation.mutate;
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<
    ReadonlyMap<string, RowActionTarget>
  >(() => new Map());
  const [previousLiveKeys, setPreviousLiveKeys] =
    useState<ReadonlySet<string>>(liveKeys);
  const liveSelected = new Map(
    [...selected].filter(([key]) => liveKeys.has(key)),
  );
  if (!sameResourceKeySet(liveKeys, previousLiveKeys)) {
    setPreviousLiveKeys(liveKeys);
    if (liveSelected.size !== selected.size) setSelected(liveSelected);
  }
  const runTargets = (targets: readonly RowActionTarget[]): void => {
    const pidsByHost = new Map<string, number[]>();
    for (const target of targets) {
      if (target.kind === "stop") {
        stopShell({
          hostId: target.hostId,
          epicId: target.epicId,
          commandId: target.commandId,
        });
        continue;
      }
      const existing = pidsByHost.get(target.hostId) ?? [];
      existing.push(...target.pids);
      pidsByHost.set(target.hostId, existing);
    }
    for (const [hostId, pids] of pidsByHost) {
      if (pids.length > 0) killPids({ hostId, pids });
    }
  };
  const isPending = killMutation.isPending || stopMutation.isPending;
  const api: ResourceRowActionApi = {
    selectionMode,
    isSelected: (key) => liveSelected.has(key),
    toggleSelection: (target) =>
      setSelected((prev) => {
        const next = new Map(prev);
        if (next.has(target.key)) next.delete(target.key);
        else next.set(target.key, target);
        return next;
      }),
    runOne: (target) => runTargets([target]),
    isPending,
  };
  const selectedStopCount = [...liveSelected.values()].filter(
    (target) => target.kind === "stop",
  ).length;
  return {
    api,
    selectionMode,
    selectedCount: liveSelected.size,
    selectedStopCount,
    selectedKillCount: liveSelected.size - selectedStopCount,
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
    clearSelection: () => setSelected(new Map()),
    runSelected: () => {
      runTargets([...liveSelected.values()]);
      setSelectionMode(false);
      setSelected(new Map());
    },
    isPending,
  };
}

interface SelectionActionCopy {
  readonly text: string;
  readonly ariaLabel: string;
  readonly destructive: boolean;
}

function countedNoun(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * What the bulk action button says. A mixed selection has to name BOTH verbs:
 * the button would otherwise promise one act and perform another on half the
 * rows. A shells-only selection also drops the destructive styling, because
 * stopping a shell destroys nothing - it stays listed and restartable.
 */
function selectionActionCopy(
  stopCount: number,
  killCount: number,
): SelectionActionCopy {
  if (stopCount === 0) {
    return {
      text: killCount > 0 ? `Kill ${killCount}` : "Kill",
      ariaLabel: `Kill ${killCount} selected`,
      destructive: true,
    };
  }
  if (killCount === 0) {
    return {
      text: `Stop ${stopCount}`,
      ariaLabel: `Stop ${stopCount} selected`,
      destructive: false,
    };
  }
  return {
    text: `Stop ${stopCount} · Kill ${killCount}`,
    ariaLabel: `Stop ${countedNoun(stopCount, "shell", "shells")}, kill ${countedNoun(killCount, "process", "processes")}`,
    destructive: true,
  };
}

/**
 * The popover surface: the host picker row, then either the panel or the
 * reason there isn't one.
 *
 * The sort menu's open flag lives HERE rather than with the control it belongs
 * to because `PopoverContent`'s `onInteractOutside` reads it, and that handler
 * cannot be pushed down past the element it guards. The panel itself is found
 * by DOM marker instead (`RESOURCE_MONITOR_PANEL_ATTRIBUTE`).
 */
function ResourceMonitorContent(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (value: string) => void;
  readonly onClose: () => void;
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  /** The provided stream client is the picked host's, not a fallback. */
  readonly streamBoundToScope: boolean;
}) {
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const scope = props.scope;
  // The picker earns its row once there is a choice to make. One host means one
  // possible answer, and a control whose only outcome is the state you are
  // already in is chrome. The `vanished` exception is not a choice but a way
  // OUT: a pick that no longer resolves must never leave someone stranded on a
  // notice with the only control that could clear it hidden.
  const showHostPicker =
    scope.hosts.length > 1 || scope.vanishedHostId !== null;
  // Everything below reads through this subtree's stream binding, and a PICK
  // that is not `ready` did not produce one - so every process, every total and
  // every kill target would describe the AMBIENT host under the name this
  // header just printed.
  //
  // Gated on there being a pick at all, because without one the ambient host is
  // not a substitution for anything: it is the host this surface has always
  // reported, and blanking it on a routine blip would take a working monitor
  // away from every single-host user for a picker they never opened.
  const scopeUnusable =
    props.hasExplicitPick && !isHostScopeUsable(scope.status);
  // A reachable host whose stream cannot serve this subscription is a THIRD
  // outcome, and it is terminal: nothing will ever attribute a usable global
  // projection to this machine, whether because the mount declined to acquire
  // or because the stream it did open negotiated a version too old to carry
  // one. Only checked while watching another host — following the active one,
  // an old host still has the per-epic fallback, which is genuinely its data.
  //
  // Gated on the stream actually being BOUND to the pick, because the pre-check
  // half of this verdict is read from whichever client the context is serving.
  // While a pick's own binding is unresolved (still dialling, or backing off
  // after a close) that is the AMBIENT one, and an old ambient host would have
  // us report the picked machine as outdated on evidence collected from a
  // different computer entirely. Unbound, we have not asked this host anything
  // yet. The stream half carries its own, stricter attribution check, since the
  // registry entry it reads is a singleton that can outlive a swap.
  const resourcesUnsupported = useGlobalResourcesUnsupported(scope.hostId);
  const streamIncompatible =
    props.streamBoundToScope &&
    watchesNamedHost(scope, props.hasExplicitPick) &&
    resourcesUnsupported;

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
      // Radix owns a document-level Escape listener, so the inline row
      // confirmation cannot protect the containing popover through React event
      // propagation alone. Keep the popover mounted while that confirmation
      // consumes Escape and restores focus to its row.
      onEscapeKeyDown={(event) => {
        const activeElement = document.activeElement;
        if (
          activeElement instanceof Element &&
          activeElement.closest(`[${RESOURCE_CONFIRMATION_ATTRIBUTE}]`) !== null
        ) {
          event.preventDefault();
        }
      }}
      onInteractOutside={(event) => {
        const target = event.target;
        // The host switcher's own list is a nested Radix popover, so it portals
        // OUTSIDE this content and every click in it reads as an interaction
        // outside. Without this, opening the picker closed the surface the
        // picker exists to scope, and no host could ever be chosen. Shared with
        // every other container that embeds it.
        if (
          target instanceof Element &&
          isHostSwitcherListInteraction(target)
        ) {
          event.preventDefault();
          return;
        }
        if (!sortMenuOpen) return;
        if (!(target instanceof Element)) return;
        if (target.closest(`[${RESOURCE_MONITOR_PANEL_ATTRIBUTE}]`) !== null) {
          event.preventDefault();
        }
      }}
    >
      {showHostPicker ? (
        <ResourceMonitorHostPickerRow scope={scope} onClose={props.onClose} />
      ) : null}
      <ResourceMonitorBody
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        onClose={props.onClose}
        scope={scope}
        hasExplicitPick={props.hasExplicitPick}
        scopeUnusable={scopeUnusable}
        streamIncompatible={streamIncompatible}
        sortMenuOpen={sortMenuOpen}
        onSortMenuOpenChange={setSortMenuOpen}
      />
    </PopoverContent>
  );
}

/**
 * Which of the card's three mutually exclusive bodies is showing. Split out so
 * the choice reads as the ordered set of questions it is — can this scope be
 * read at all, then can its host serve this stream, then show it — rather than
 * as nested ternaries in the middle of the card.
 *
 * The order matters: an unreachable host has no negotiated stream to judge, so
 * asking about compatibility first would report an old host as merely offline.
 */
function ResourceMonitorBody(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (value: string) => void;
  readonly onClose: () => void;
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  readonly scopeUnusable: boolean;
  readonly streamIncompatible: boolean;
  readonly sortMenuOpen: boolean;
  readonly onSortMenuOpenChange: (open: boolean) => void;
}) {
  if (props.scopeUnusable) {
    return <ResourceMonitorHostUnavailableNotice scope={props.scope} />;
  }
  if (props.streamIncompatible) {
    return <ResourceMonitorHostIncompatibleNotice scope={props.scope} />;
  }
  return (
    <ResourceMonitorPanel
      searchQuery={props.searchQuery}
      onSearchQueryChange={props.onSearchQueryChange}
      onClose={props.onClose}
      scope={props.scope}
      hasExplicitPick={props.hasExplicitPick}
      sortMenuOpen={props.sortMenuOpen}
      onSortMenuOpenChange={props.onSortMenuOpenChange}
    />
  );
}

/**
 * The host row above the panel: which machine's processes this surface is
 * reporting. It heads the whole card rather than sitting inside the list,
 * because it scopes every section in it - the host app, the task trees and the
 * Other roots alike.
 *
 * `HostSwitcher` is Settings' picker, reused rather than re-skinned, on the
 * same terms as the usage popover's row: the two surfaces answer different
 * questions (administer vs. watch) but the rows answer the same one - which
 * machine is this, can I reach it, which one is active - and a second picker
 * over one concept is how two vocabularies for it start.
 */
function ResourceMonitorHostPickerRow(props: {
  readonly scope: HostScope;
  readonly onClose: () => void;
}) {
  const { openSettings } = useSystemTabModalActions();
  // The registry list this picker renders is served by a NON-polling observer;
  // the Settings sidebar is normally the surface that opts the window into the
  // liveness poll. When this popover is the only host-list surface mounted, a
  // row would otherwise keep an Online dot from the last registry DTO until
  // something else happened to refetch - so this picker carries the same opt-in
  // for exactly as long as it is on screen.
  useRegisteredHostsPollLiveness();
  const scope = props.scope;
  return (
    // Full-bleed on purpose: the strip's own edges ARE the card's, so the
    // picker's list can drop from it at exactly the card's width. Padding here
    // would inset the trigger, and with it the list anchored to the trigger,
    // leaving a few pixels of card showing down both sides of the open list.
    <div
      className="flex shrink-0 items-center border-b"
      data-testid="resource-monitor-host-picker-row"
    >
      <HostSwitcher
        hosts={scope.hosts}
        selected={scope.host}
        activeHostId={scope.activeHostId}
        onSelect={scope.setHostId}
        // Managing hosts - adding, renaming, updating, removing - is Settings'
        // job, with its own dialogs and failure states; this popover watches
        // processes. So the list ends in one link to where that work already
        // lives, rather than a second copy of one verb from it.
        action={{
          kind: "manage-hosts",
          onSelect: () => {
            props.onClose();
            carryViewedHostIntoSettingsScope(scope.hostId);
            openSettings({ section: "host", resetToGeneral: false });
          },
        }}
        surface="panel-header"
        intent="view"
        disabled={false}
        isLoading={scope.isLoading}
        listsFailed={scope.listsFailed}
        onRetryLists={scope.retryLists}
      />
    </div>
  );
}

/**
 * Why this surface is showing nothing rather than showing the active host's
 * processes under another host's name. Each branch names the remedy it has,
 * because the three states differ in exactly that: `vanished` needs the pick
 * dropped, `unreachable` needs the machine back, `connecting` needs a moment.
 */
function ResourceMonitorHostUnavailableNotice(props: {
  readonly scope: HostScope;
}) {
  const scope = props.scope;
  if (scope.status === "connecting") {
    return (
      <div
        className="flex items-center justify-center gap-2 px-3.5 py-8 text-ui-sm text-muted-foreground"
        data-testid="resource-monitor-host-connecting"
      >
        <MutedAgentSpinner />
        Finding {scope.hostLabel}…
      </div>
    );
  }
  // A plan-gated host is not an offline one, and the copy below would send
  // someone to debug a network that is working: the machine is up, this app
  // just may not attach to it remotely on the current plan. The scope gate
  // makes exactly this distinction for the Settings panels
  // (`host-scope-gate.tsx`), and a picker that can land on the same host owes
  // the same answer and the same remedy.
  if (scope.host?.planRestricted === true) {
    return (
      <div
        role="status"
        className="flex flex-col items-center gap-2 px-6 py-8 text-center"
        data-testid="resource-monitor-host-plan-restricted"
      >
        <p className="max-w-[40ch] text-ui-sm font-medium text-foreground">
          Reading {scope.hostLabel} needs a paid plan
        </p>
        <p className="max-w-[40ch] text-ui-sm text-muted-foreground">
          It keeps working on its own machine. This app just can&apos;t attach
          to it remotely on the current plan, so its processes can&apos;t be
          streamed here.
        </p>
        <PlanRestrictedUpgradeAction />
        <button
          type="button"
          onClick={scope.returnToActive}
          className="rounded-md px-1 py-0.5 text-ui-sm text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          data-testid="resource-monitor-host-return-to-active"
        >
          Show the active host
        </button>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 px-6 py-8 text-center"
      data-testid="resource-monitor-host-unavailable"
    >
      <p className="max-w-[40ch] text-ui-sm font-medium text-foreground">
        {scope.status === "vanished"
          ? `${scope.hostLabel} is no longer connected`
          : `Can't reach ${scope.hostLabel}`}
      </p>
      <p className="max-w-[40ch] text-ui-sm text-muted-foreground">
        {scope.status === "vanished"
          ? "It was removed or signed out, so its processes can't be read."
          : "Process trees are streamed from the host itself, so they're unavailable while it's offline."}
      </p>
      <button
        type="button"
        onClick={scope.returnToActive}
        className="rounded-md px-1 py-0.5 text-ui-sm text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="resource-monitor-host-return-to-active"
      >
        Show the active host
      </button>
    </div>
  );
}

/**
 * A host that is reachable, answering, and simply too old to stream its
 * processes to this window.
 *
 * It gets its own notice rather than the waiting copy because the difference is
 * whether anything is coming: `unreachable` may recover on its own, but a host
 * that did not negotiate the global subscription will not start, and a spinner
 * over that says something untrue for as long as the pick stands. The remedy is
 * named for the same reason — it is an action on the other machine, not
 * something this window can retry.
 */
function ResourceMonitorHostIncompatibleNotice(props: {
  readonly scope: HostScope;
}) {
  const scope = props.scope;
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 px-6 py-8 text-center"
      data-testid="resource-monitor-host-incompatible"
    >
      <p className="max-w-[40ch] text-ui-sm font-medium text-foreground">
        {scope.hostLabel} can&apos;t report its processes
      </p>
      <p className="max-w-[40ch] text-ui-sm text-muted-foreground">
        It&apos;s running an older Traycer host, which doesn&apos;t stream
        resource usage. Update it to see its processes here.
      </p>
      <button
        type="button"
        onClick={scope.returnToActive}
        className="rounded-md px-1 py-0.5 text-ui-sm text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="resource-monitor-host-return-to-active"
      >
        Show the active host
      </button>
    </div>
  );
}

/**
 * What "nothing here yet" means, which differs by who is being watched.
 *
 * Under a pick this covers a host whose stream has not been attributed to it
 * yet: the transport is still resolving, or a swap left the projection still
 * naming the machine we just stopped watching. Naming the machine keeps that
 * honest instead of implying data is on its way from a host this window is not
 * actually reading. A host that will NEVER be attributed — one too old to serve
 * a global stream — is not one of these: it gets a terminal notice rather than
 * a wait that cannot end (`ResourceMonitorHostIncompatibleNotice`).
 */
function resourceMonitorWaitingCopy(
  scope: HostScope,
  hasExplicitPick: boolean,
): string {
  return watchesNamedHost(scope, hasExplicitPick)
    ? `Waiting for ${scope.hostLabel}…`
    : "Waiting for resource data.";
}

/**
 * Whether this surface is reporting a machine the user NAMED — the question
 * every "are we watching someone else" branch actually wants answered.
 *
 * `isViewingActive` cannot answer it. It is `isFollowing`, which requires a
 * RESOLVED host, so it reads false throughout the cold-start window before the
 * host lists reply — during which there is no pick, nothing is named on screen,
 * and treating the surface as if it were watching another machine blanks a
 * working monitor and can accuse the ambient host of being unable to report.
 * The pick is what the person did; `isViewingActive` is a fact about lists that
 * happens to correlate once they load.
 *
 * The second half stands because naming the active host on a surface already
 * following it is noise — but it is only ever consulted once a pick exists.
 */
function watchesNamedHost(scope: HostScope, hasExplicitPick: boolean): boolean {
  return hasExplicitPick && !scope.isViewingActive;
}

/** Everything watching another machine changes about what this panel reads. */
interface ResourceMonitorHostReading {
  /**
   * Where a kill goes for rows that carry no host of their own - the "Other"
   * roots. Owner rows route by their own `owner.hostId` and never consult this.
   */
  readonly killHostId: string | null;
  readonly projection: GlobalResourceProjection;
  readonly desktopApp: DesktopAppResourceUsage | null;
}

/**
 * Whether "Traycer Desktop" — the Electron shell, which is THIS computer's
 * process — belongs in the reading.
 *
 * The test is the machine's IDENTITY, not whether the surface happens to be
 * following the active selection. Those come apart in both directions: the
 * active host can itself be a remote machine (counting the local shell there
 * attributes this computer's memory to another one, over a "RAM share"
 * denominator its numerator never came from), and someone can explicitly pick
 * the machine they are sitting at while the active host is elsewhere — where
 * the row is exactly what they asked for.
 *
 * With no host resolved the answer is "we do not know which machine this is
 * describing", and the row stays hidden — which is also what it did before
 * there was a picker, since `isViewingActive` is itself false until a host
 * resolves (`isFollowing` requires one). Reaching for `isViewingActive` as a
 * cold-start fallback here looks like it preserves something and cannot: it is
 * false in exactly the case it would be consulted.
 */
function readingShowsLocalDesktop(scope: HostScope): boolean {
  return scope.host?.isLocalMachine === true;
}

/**
 * Reconcile the panel's three host-dependent inputs in ONE place, so the
 * "which machine is this" question is answered once rather than re-derived
 * beside every consumer — the shape of mistake where the totals move to the
 * picked host and the kill route quietly does not.
 *
 * Following the active host every answer is what it was before the picker
 * existed; nothing about a single-host window changes.
 */
function resolveResourceMonitorHostReading(input: {
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  readonly streamed: GlobalResourceProjection;
  readonly localDesktopApp: DesktopAppResourceUsage | null;
}): ResourceMonitorHostReading {
  // ONE value answers "which machine is this reading about", and it answers it
  // for both the data and the actions. Deriving the kill target from a second
  // reader of the active host — `useReactiveActiveHostId`, which this used to
  // call — is what let the two disagree: on an ambient host swap it moved to
  // the new machine a commit before the stream transport did, so the panel
  // showed the old host's processes with kills aimed at the new one. That
  // needed no picker to happen, and no pick to reproduce.
  return {
    killHostId: input.scope.hostId,
    projection: attributedProjection(
      input.scope,
      input.hasExplicitPick,
      input.streamed,
    ),
    desktopApp: readingShowsLocalDesktop(input.scope)
      ? input.localDesktopApp
      : null,
  };
}

/**
 * The projection, or nothing, according to what this surface is CLAIMING —
 * and the two claims differ, so the burden of proof does too.
 *
 * The projection is a module singleton that outlives any one transport, so it
 * can describe a machine the current reading was not opened against: a host
 * swap still in flight (ambient or scoped — the registry entry is named at
 * acquire time, one commit before the replacement binding reaches context), or
 * a pick just dropped, where the entry still carries the abandoned host's name.
 *
 * **Under a pick** the surface is accountable to a machine the person named, so
 * it owes positive proof: the projection must say this host, or there is
 * nothing to show. An unattributed projection is not good enough — that is
 * exactly the pre-v1.1 per-epic fallback, which rides the ambient transport and
 * would put one machine's processes under another's name.
 *
 * **With no pick** nothing on screen names a machine; the only thing that can
 * go wrong is a kill routed at a host these rows did not come from. So refuse
 * what can be PROVEN foreign and nothing more. A scope that has not resolved
 * its host id — every cold start, between the ambient stream connecting and the
 * host lists answering — proves nothing, and has no kill target either
 * (`defaultHostId` is null, so the Other roots offer no action). Demanding
 * proof there would blank a working monitor on every launch to defend a name it
 * never prints.
 *
 * The branch is `hasExplicitPick`, NOT `isViewingActive`. The latter is false
 * throughout that same cold-start window (see `watchesNamedHost`), so keying on
 * it puts the strict branch in charge of exactly the case the permissive branch
 * exists for — which is the bug this comment used to describe as fixed.
 */
function attributedProjection(
  scope: HostScope,
  hasExplicitPick: boolean,
  streamed: GlobalResourceProjection,
): GlobalResourceProjection {
  if (hasExplicitPick) {
    return streamed.hostId !== null && streamed.hostId === scope.hostId
      ? streamed
      : EMPTY_GLOBAL_RESOURCE_PROJECTION;
  }
  const provablyAnotherMachine =
    streamed.hostId !== null &&
    scope.hostId !== null &&
    streamed.hostId !== scope.hostId;
  return provablyAnotherMachine ? EMPTY_GLOBAL_RESOURCE_PROJECTION : streamed;
}

/**
 * The panel itself, mounted only once the surface is bound to the host it
 * names. Split from `ResourceMonitorContent` so the reads below are not
 * mounted at all under an unusable scope.
 */
function ResourceMonitorPanel(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (value: string) => void;
  readonly onClose: () => void;
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  readonly sortMenuOpen: boolean;
  readonly onSortMenuOpenChange: (open: boolean) => void;
}) {
  const [sortOption, setSortOption] = useState<ResourceSortOption>("tab");
  const searchQuery = props.searchQuery;
  const scope = props.scope;
  const sortMenuOpen = props.sortMenuOpen;
  const setSortMenuOpen = props.onSortMenuOpenChange;
  const [expandedOwners, setExpandedOwners] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedProcesses, setExpandedProcesses] = useState<Set<string>>(
    () => new Set(),
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sortTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dismissingSortMenuRef = useRef(false);
  const streamedProjection = useGlobalResourceProjection();
  const localDesktopApp = useDesktopAppResourceUsage();
  const reading = resolveResourceMonitorHostReading({
    scope,
    hasExplicitPick: props.hasExplicitPick,
    streamed: streamedProjection,
    localDesktopApp,
  });
  const defaultHostId = reading.killHostId;
  const projection = reading.projection;
  const desktopApp = reading.desktopApp;
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
  const liveOwnerTitleEntries = useMemo(
    () =>
      taskRows.flatMap((task) =>
        flattenOwnerRows(task.owners).map((owner) => ({
          ownerKey: ownerRowKey(owner),
          epicId: owner.snapshot.owner.epicId,
          artifactId:
            owner.snapshot.owner.kind === "terminal"
              ? null
              : owner.snapshot.owner.ownerId,
        })),
      ),
    [taskRows],
  );
  const liveOwnerTitles = useRegisteredEpicLiveArtifactTitles(
    liveOwnerTitleEntries,
  );
  const liveOwnerTitleByKey = useMemo(
    () =>
      new Map(
        liveOwnerTitleEntries.map((entry, index) => [
          entry.ownerKey,
          liveOwnerTitles[index],
        ]),
      ),
    [liveOwnerTitleEntries, liveOwnerTitles],
  );
  const search = useMemo(
    () =>
      buildResourceSearchProjection({
        desktopApp,
        hostApp: projection.app,
        other: supportsHostTree ? projection.other : null,
        taskRows,
        liveOwnerTitleByKey,
        searchQuery,
        expandedOwners,
      }),
    [
      desktopApp,
      expandedOwners,
      projection.app,
      projection.other,
      liveOwnerTitleByKey,
      searchQuery,
      supportsHostTree,
      taskRows,
    ],
  );
  const actionTargetIndex = useMemo(
    () =>
      buildRowActionTargetIndex({
        owners: projection.owners,
        other: search.other,
        defaultHostId,
        visibleOwnerKeys: search.visibleOwnerKeys,
        visibleKillKeys: search.visibleKillKeys,
        searchQuery,
      }),
    [
      defaultHostId,
      projection.owners,
      search.other,
      search.visibleKillKeys,
      search.visibleOwnerKeys,
      searchQuery,
    ],
  );
  const rowActions = useResourceRowActions(
    actionTargetIndex.live,
    actionTargetIndex.topLevel,
  );
  const selectionCopy = selectionActionCopy(
    rowActions.selectedStopCount,
    rowActions.selectedKillCount,
  );
  const updateSearchQuery = (value: string): void => {
    rowActions.clearSelection();
    props.onSearchQueryChange(value);
  };

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

  const handlePanelKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (!(event.target instanceof HTMLElement)) return;
    const target = event.target;
    const isSearch = target.hasAttribute(RESOURCE_SEARCH_ATTRIBUTE);
    const navigationKey = target.getAttribute(
      RESOURCE_NAVIGATION_KEY_ATTRIBUTE,
    );
    if (isSearch || navigationKey !== null) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (
          moveResourceNavigationFocus(
            panelRef.current ?? event.currentTarget,
            target,
            event.key === "ArrowDown" ? 1 : -1,
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
    }
    if (navigationKey !== null && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      target.click();
      return;
    }
    if (
      navigationKey !== null &&
      (event.key === "Delete" || event.key === "Backspace") &&
      armResourceRowAction(
        panelRef.current ?? event.currentTarget,
        navigationKey,
      )
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div
      ref={panelRef}
      {...{ [RESOURCE_MONITOR_PANEL_ATTRIBUTE]: "" }}
      className="min-w-0"
      onPointerDownCapture={dismissSortMenuFromPanelClick}
      onClickCapture={swallowDismissedSortMenuClick}
      onKeyDownCapture={handlePanelKeyDown}
    >
      <div className="border-b border-border/60 px-3.5 pb-3 pt-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground">
            Resources
          </h4>
          <div className="flex shrink-0 items-center gap-1">
            {rowActions.selectionMode ? (
              // Selection mode replaces the header controls wholesale (the
              // sort dropdown included), mirroring the chat navigator's
              // Select all / Cancel / destructive-action toolbar.
              <div className="flex items-center gap-0.5">
                <SelectAllToggle
                  allSelected={rowActions.allVisibleSelected}
                  onSelectAll={rowActions.selectAllVisible}
                  onDeselectAll={rowActions.deselectAllVisible}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-6 px-1.5 text-muted-foreground hover:text-foreground"
                  aria-label="Cancel selection"
                  onClick={rowActions.cancelSelection}
                >
                  <X className="mr-1 size-3.5" />
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className={cn(
                    "h-6 px-1.5",
                    selectionCopy.destructive
                      ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  disabled={
                    rowActions.selectedCount === 0 || rowActions.isPending
                  }
                  aria-label={selectionCopy.ariaLabel}
                  onClick={rowActions.runSelected}
                >
                  {selectionCopy.text}
                  {rowActions.isPending ? (
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
                  onClick={rowActions.enterSelection}
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
                      className="flex h-6 items-center gap-1 rounded-sm px-1.5 text-ui-xs text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
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

        <ResourceSearchInput value={searchQuery} onChange={updateSearchQuery} />

        {summary === null ? (
          <div className="mt-4 text-ui-xs text-muted-foreground">
            {resourceMonitorWaitingCopy(scope, props.hasExplicitPick)}
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
              className="mt-3 h-1 w-full overflow-hidden rounded-full bg-foreground/6"
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
        {search.desktopApp === null ? null : (
          <DesktopAppResourceSection
            app={search.desktopApp}
            sortOption={sortOption}
            searchQuery={searchQuery}
          />
        )}
        {search.hostApp === null ? null : (
          <HostAppResourceSection app={search.hostApp} />
        )}
        {summary === null ? null : (
          <div className="py-1">
            {!search.active && search.taskRows.length === 0 ? (
              <div className="px-3.5 py-4 text-center text-ui-xs text-muted-foreground">
                No active task process trees.
              </div>
            ) : (
              search.taskRows.map((task) => (
                <TaskResourceSection
                  key={task.entry.epicId}
                  task={task}
                  searchQuery={searchQuery}
                  liveOwnerTitleByKey={liveOwnerTitleByKey}
                  expandedOwners={expandedOwners}
                  expandedProcesses={expandedProcesses}
                  sortOption={sortOption}
                  onToggleOwner={toggleOwner}
                  onToggleProcess={toggleProcess}
                  onOpenOwner={openOwner}
                  actions={rowActions.api}
                />
              ))
            )}
            {search.other === null ? null : (
              <OtherResourceSection
                other={search.other}
                searchQuery={searchQuery}
                expandedProcesses={expandedProcesses}
                sortOption={sortOption}
                onToggleProcess={toggleProcess}
                actions={rowActions.api}
                killHostId={defaultHostId}
              />
            )}
            {search.noResults ? (
              <div className="px-3.5 py-6 text-center text-ui-xs text-muted-foreground">
                No resources match “{searchQuery.trim()}”.
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
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
      closedTilePayloadsByTabId: state.closedTilePayloadsByTabId,
      artifactTreeByEpicId: state.artifactTreeByEpicId,
    })),
  );
}

function ResourceSearchInput(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <InputGroup className="mt-3 h-7">
      <InputGroupAddon align="inline-start">
        <Search className="size-3.5" aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        {...{ [RESOURCE_SEARCH_ATTRIBUTE]: "" }}
        type="search"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder="Search resources…"
        aria-label="Search resources"
        autoComplete="off"
        spellCheck={false}
        className="text-ui-sm [&::-webkit-search-cancel-button]:hidden"
      />
      {props.value.length > 0 ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label="Clear resource search"
            onClick={() => {
              props.onChange("");
              inputRef.current?.focus();
            }}
          >
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
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
  readonly searchQuery: string;
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
    ].filter((group) =>
      matchesResourceSearch(props.searchQuery, [
        "Traycer Desktop",
        group.label,
      ]),
    ),
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
    <div className="flex items-center justify-between gap-3 px-3.5 py-1 pl-7 text-muted-foreground transition-colors hover:bg-foreground/5">
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
            searchForcesExpanded: false,
            hiddenCount: 0,
            treeCpuPercent: props.app.process.cpuPercent,
            treeRssBytes: props.app.process.rssBytes,
            children: [],
          }}
          ownerDepth={0}
          stickyTop={0}
          labelMode="full"
          onToggleExpand={noProcessToggle}
          actions={null}
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
  owners: readonly OwnerResourceSnapshotWireV14[],
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
  owners: readonly OwnerResourceSnapshotWireV14[],
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
  readonly searchQuery: string;
  readonly liveOwnerTitleByKey: ReadonlyMap<string, string | null>;
  readonly expandedOwners: ReadonlySet<string>;
  readonly expandedProcesses: ReadonlySet<string>;
  readonly sortOption: ResourceSortOption;
  readonly onToggleOwner: (key: string) => void;
  readonly onToggleProcess: (key: string) => void;
  readonly onOpenOwner: (row: OwnerDisplayRow) => void;
  readonly actions: ResourceRowActionApi;
}) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const taskMatchesSearch = taskRowMatchesSearch(props.task, props.searchQuery);

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
      {props.task.owners.map((row) => (
        <OwnerTreeRow
          key={ownerRowKey(row)}
          row={row}
          depth={0}
          searchQuery={taskMatchesSearch ? "" : props.searchQuery}
          taskSearchTerms={taskSearchTerms(props.task)}
          liveOwnerTitleByKey={props.liveOwnerTitleByKey}
          expandedOwners={props.expandedOwners}
          expandedProcesses={props.expandedProcesses}
          sortOption={props.sortOption}
          stickyTop={headerHeight}
          onToggleOwner={props.onToggleOwner}
          onToggleProcess={props.onToggleProcess}
          onOpenOwner={props.onOpenOwner}
          actions={props.actions}
        />
      ))}
    </div>
  );
}

function OtherResourceSection(props: {
  readonly other: OtherResourceSnapshotWire;
  readonly searchQuery: string;
  readonly expandedProcesses: ReadonlySet<string>;
  readonly sortOption: ResourceSortOption;
  readonly onToggleProcess: (key: string) => void;
  readonly actions: ResourceRowActionApi;
  readonly killHostId: string | null;
}) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  // Collapsed by default: the header aggregate says everything most users
  // need; the per-root breakdown (provider servers, probes, misc children)
  // is inspect-on-demand, matching collapsed-by-default owner trees.
  const [expanded, setExpanded] = useState(false);
  const allProcessRows = buildProcessRows(
    props.other.processes,
    props.expandedProcesses,
    props.other,
    props.sortOption,
  );
  const sectionMatchesSearch = matchesResourceSearch(props.searchQuery, [
    "Other",
  ]);
  const processRows = sectionMatchesSearch
    ? allProcessRows
    : filterOwnerProcessRowsForSearch(allProcessRows, props.searchQuery, true, [
        "Other",
      ]);
  const searchForcesExpanded =
    normalizeResourceSearch(props.searchQuery).length > 0 &&
    !sectionMatchesSearch;
  const visibleExpanded = expanded || searchForcesExpanded;

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

  let toggleLabel = visibleExpanded
    ? "Collapse other processes"
    : "Expand other processes";
  if (searchForcesExpanded) {
    toggleLabel = "Other processes expanded by search";
  }

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
          aria-expanded={visibleExpanded}
          disabled={searchForcesExpanded}
          aria-label={toggleLabel}
          onClick={() => setExpanded((previous) => !previous)}
          className="flex min-w-0 items-center gap-1 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:hover:text-muted-foreground"
        >
          {visibleExpanded ? (
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
      {!visibleExpanded
        ? null
        : processRows.rootRows.map((processRow) => (
            <ProcessTreeRow
              key={processRowKey(processRow.process)}
              processRow={processRow}
              ownerDepth={0}
              stickyTop={headerHeight}
              labelMode="compact-root"
              onToggleExpand={props.onToggleProcess}
              actions={props.actions}
              killHostId={props.killHostId}
            />
          ))}
    </div>
  );
}

/** A concrete kill target: a host and the root pids whose trees to terminate. */
interface KillTarget {
  readonly kind: "kill";
  readonly key: string;
  readonly hostId: string;
  readonly pids: readonly number[];
}

/**
 * A shell to hand back to its supervisor. Named by command id rather than by
 * pid because that is what the stop acts on - the supervised object, not the
 * process currently standing in for it.
 */
interface StopTarget {
  readonly kind: "stop";
  readonly key: string;
  readonly hostId: string;
  readonly epicId: string;
  readonly commandId: string;
}

/**
 * What acting on one row means. The two verbs are not interchangeable: a raw
 * process tree is killed, but a SUPERVISED shell is stopped through its
 * supervisor. Signalling a shell directly would be recorded as
 * `exited (signal SIGTERM)` - a crash, as far as every reader of that status is
 * concerned - which lights the chat's attention badge and invites the agent to
 * restart the very shell a human just asked it to stop.
 */
type RowActionTarget = KillTarget | StopTarget;

/**
 * Row action controls threaded down to actionable rows. `selectionMode` toggles
 * the multi-select affordance; the rest drive per-row and bulk actions. `null`
 * for rows that can't be acted on (the app/host sections never receive it).
 */
interface ResourceRowActionApi {
  readonly selectionMode: boolean;
  readonly isSelected: (key: string) => boolean;
  readonly toggleSelection: (target: RowActionTarget) => void;
  readonly runOne: (target: RowActionTarget) => void;
  readonly isPending: boolean;
}

/**
 * Per-row destructive affordance: hidden until the row is hovered/focused,
 * then a two-step INLINE confirm (no modal). The keyboard path deliberately
 * lands on Confirm after Delete/Backspace arms it, making Enter the second,
 * distinct confirmation key; Escape dismisses and restores row focus.
 */
function ConfirmableRowAction(props: {
  readonly target: RowActionTarget;
  readonly label: string;
  readonly onRun: (target: RowActionTarget) => void;
  readonly isPending: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const verb = props.target.kind === "kill" ? "kill" : "stop";
  const arm = (): void => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setArmed(true);
  };
  const disarm = (): void => {
    setArmed(false);
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  };
  useLayoutEffect(() => {
    if (armed) confirmRef.current?.focus();
  }, [armed]);
  const confirm = (): void => {
    props.onRun(props.target);
    setArmed(false);
  };
  const cancelFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    disarm();
  };

  if (armed) {
    // Armed confirm floats over the row's right edge as a small panel (the
    // row wrapper is `relative`), instead of squeezing beside the metrics -
    // nothing shifts or clips while confirming.
    return (
      <>
        <span className={ROW_ACTION_SLOT} />
        <span
          {...{ [RESOURCE_CONFIRMATION_ATTRIBUTE]: "" }}
          className="absolute inset-y-0 right-2 z-30 my-auto flex h-7 items-center gap-0.5 rounded-md border border-border/60 bg-popover px-1 shadow-sm"
        >
          <Button
            ref={confirmRef}
            type="button"
            variant="ghost"
            size="xs"
            className="h-5 px-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={props.isPending}
            aria-label={`Confirm ${verb} ${props.label}`}
            aria-keyshortcuts="Enter"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                cancelFromKeyboard(event);
                return;
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.stopPropagation();
              confirm();
            }}
            onClick={(event) => {
              event.stopPropagation();
              confirm();
            }}
          >
            Confirm
            <span aria-hidden className="ml-1 text-muted-foreground">
              ↵
            </span>
            {props.isPending ? (
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
            aria-keyshortcuts="Escape"
            onKeyDown={cancelFromKeyboard}
            onClick={(event) => {
              event.stopPropagation();
              disarm();
            }}
          >
            Cancel
            <span aria-hidden className="ml-1">
              Esc
            </span>
          </Button>
        </span>
      </>
    );
  }
  return (
    <span {...{ [RESOURCE_ACTION_KEY_ATTRIBUTE]: props.target.key }}>
      {props.target.kind === "stop" ? (
        <ManagedCommandStopButton
          commandId={props.target.commandId}
          ariaLabel={`Stop ${props.label}`}
          isPending={props.isPending}
          className={ROW_HOVER_REVEAL}
          onStop={arm}
        />
      ) : (
        <>
          {/* Text label, not an icon: a bin reads as "delete this agent's
              state" and a stop glyph reads as "stop the turn", but this only
              terminates the process tree. The word carries the meaning. */}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={cn(
              "h-6 shrink-0 px-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive",
              ROW_HOVER_REVEAL,
            )}
            aria-label={`Kill ${props.label}`}
            onClick={(event) => {
              event.stopPropagation();
              arm();
            }}
          >
            Kill
          </Button>
        </>
      )}
    </span>
  );
}

/**
 * The owner row's leading cell: a select checkbox when the row can be acted on
 * and selection mode is on, otherwise the expand chevron (or a spacer when the
 * tree has no descendants). Owns the selection branching so `OwnerTreeRow`
 * stays flat.
 */
function OwnerRowLeadingCell(props: {
  readonly actions: ResourceRowActionApi | null;
  readonly target: RowActionTarget | null;
  readonly label: string;
  readonly canExpand: boolean;
  readonly expanded: boolean;
  readonly forcedExpanded: boolean;
  readonly onToggle: () => void;
}) {
  const actions = props.actions ?? null;
  const target = props.target;
  if (actions !== null && target !== null && actions.selectionMode) {
    return (
      <span className="ml-3 flex size-6 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          className="size-3.5 accent-destructive"
          checked={actions.isSelected(target.key)}
          aria-label={`Select ${props.label}`}
          onChange={() => actions.toggleSelection(target)}
        />
      </span>
    );
  }
  if (!props.canExpand) {
    return <span className="ml-3 size-6 shrink-0" />;
  }
  let toggleLabel = props.expanded
    ? "Collapse process tree"
    : "Expand process tree";
  if (props.forcedExpanded) {
    toggleLabel = "Process tree expanded by search";
  }
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      disabled={props.forcedExpanded}
      onClick={props.onToggle}
      className="ml-3 flex size-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
      aria-label={toggleLabel}
    >
      {props.expanded ? (
        <ChevronDown className="size-3.5" />
      ) : (
        <ChevronRight className="size-3.5" />
      )}
    </button>
  );
}

/**
 * Trailing action affordance for an owner row (hidden in selection mode). A
 * shell gets the supervisor's Stop - the same button the Shells surfaces
 * carry - so the row that ends a shell looks the same wherever it appears, and
 * never like the "Kill" beside it.
 */
function OwnerRowActionCell(props: {
  readonly actions: ResourceRowActionApi | null;
  readonly target: RowActionTarget | null;
  readonly label: string;
}) {
  const actions = props.actions ?? null;
  const target = props.target;
  if (actions === null || target === null || actions.selectionMode) {
    return <span className={ROW_ACTION_SLOT} />;
  }
  return (
    <span className={ROW_ACTION_SLOT}>
      <ConfirmableRowAction
        target={target}
        label={props.label}
        onRun={actions.runOne}
        isPending={actions.isPending}
      />
    </span>
  );
}

/**
 * What acting on this owner row means, or `null` when there is nothing to act
 * on - a Synthetic Agent Row, which owns no process of its own.
 *
 * A shell is stopped rather than killed regardless of how it is nested, so this
 * reads the snapshot rather than the row's position in the tree.
 */
function ownerSnapshotActionTarget(
  snapshot: OwnerResourceSnapshotWireV14,
  key: string,
): RowActionTarget | null {
  const managedCommand = snapshot.managedCommand;
  if (managedCommand !== null) {
    return {
      kind: "stop",
      key,
      hostId: snapshot.owner.hostId,
      epicId: snapshot.owner.epicId,
      commandId: managedCommand.commandId,
    };
  }
  if (snapshot.rootPids.length === 0) return null;
  return {
    kind: "kill",
    key,
    hostId: snapshot.owner.hostId,
    pids: snapshot.rootPids,
  };
}

/**
 * Index of currently-actionable rows. `live` holds every selectable key so a
 * selection whose process exited on its own is pruned at read time; `topLevel`
 * holds the owner-row / Other-root targets "Select all" operates on
 * (descendant process rows are excluded - acting on an owner already takes its
 * whole tree, and counting children would double-count).
 */
function buildRowActionTargetIndex(input: RowActionTargetIndexInput): {
  readonly live: ReadonlySet<string>;
  readonly topLevel: ReadonlyMap<string, RowActionTarget>;
} {
  const live = new Set<string>();
  const topLevel = new Map<string, RowActionTarget>();
  for (const owner of input.owners) {
    const key = ownerKey(
      owner.owner.epicId,
      owner.owner.kind,
      owner.owner.ownerId,
    );
    if (input.visibleKillKeys.has(key)) live.add(key);
    const ownerTarget = ownerSnapshotActionTarget(owner, key);
    if (ownerTarget !== null && input.visibleOwnerKeys.has(key)) {
      topLevel.set(key, ownerTarget);
    }
    for (const process of owner.processes) {
      const processKey = processRowKey(process);
      if (input.visibleKillKeys.has(processKey)) live.add(processKey);
    }
  }
  if (input.other !== null && input.defaultHostId !== null) {
    const matchingRootPids = matchingOtherRootPids(
      input.other.processes,
      input.searchQuery,
    );
    for (const process of input.other.processes) {
      const key = processRowKey(process);
      if (input.visibleKillKeys.has(key)) live.add(key);
      if (
        process.rootPid === process.pid &&
        matchingRootPids.has(process.pid)
      ) {
        topLevel.set(key, {
          kind: "kill",
          key,
          hostId: input.defaultHostId,
          pids: [process.pid],
        });
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
  actions: ResourceRowActionApi | null,
  target: RowActionTarget | null,
  onOpen: () => void,
): () => void {
  if (!selecting || actions === null || target === null) return onOpen;
  return () => actions.toggleSelection(target);
}

/**
 * Provider icon for an owner row's subtitle, or a neutral glyph for a
 * harness-less owner. Subscript-scale (`size-3`) so it reads as part of the
 * secondary text line, not a second row element.
 *
 * A shell has no provider at all, and the generic `Server` glyph told a viewer
 * nothing that the row did not already say. It gets the shell glyph instead -
 * the same one the sidebar, the strip and the chip use - so the row is
 * recognisable as the shell it is, watching or not. The noun is still in the
 * row's title in words, so the glyph stays decorative.
 */
function OwnerProviderIcon(props: {
  readonly harnessId: string | null;
  readonly managedCommand: ManagedCommandOwnerWire | null;
  readonly synthetic: boolean;
}) {
  // A Synthetic Agent Row has no running program, so there is no provider to
  // advertise; the chat glyph says what the row stands for - the agent whose
  // shells are still running underneath it.
  if (props.synthetic) {
    return (
      <MessagesSquare className="size-3 shrink-0 text-muted-foreground/70" />
    );
  }
  if (props.managedCommand !== null) {
    return (
      <ManagedCommandMonitorIcon
        monitoring={props.managedCommand.monitoring}
        decorative
        className={undefined}
      />
    );
  }
  const providerId =
    props.harnessId === null ? null : normalizeProviderId(props.harnessId);
  if (providerId === null) {
    return <Server className="size-3 shrink-0 text-muted-foreground/70" />;
  }
  return <HarnessIcon harnessId={providerId} className="size-3" />;
}

/**
 * One owner row and everything nested behind its chevron: the shells its agent
 * created (rendered as sub-rows of the same shape, above), then its own OS
 * process tree. A shell has no shells of its own, so the recursion is two deep.
 */
function resourceNavigationKey(
  canOpen: boolean,
  selecting: boolean,
  rowKey: string,
): string | undefined {
  return canOpen && !selecting ? rowKey : undefined;
}

function OwnerTreeRow(props: {
  readonly row: OwnerDisplayRow;
  readonly depth: number;
  readonly searchQuery: string;
  readonly taskSearchTerms: readonly (string | number | null)[];
  readonly liveOwnerTitleByKey: ReadonlyMap<string, string | null>;
  readonly expandedOwners: ReadonlySet<string>;
  readonly expandedProcesses: ReadonlySet<string>;
  readonly sortOption: ResourceSortOption;
  readonly stickyTop: number;
  readonly onToggleOwner: (key: string) => void;
  readonly onToggleProcess: (key: string) => void;
  readonly onOpenOwner: (row: OwnerDisplayRow) => void;
  readonly actions: ResourceRowActionApi | null;
}) {
  const owner = props.row.snapshot.owner;
  const rowKey = ownerRowKey(props.row);
  const label = resolvedOwnerLabel(
    props.row,
    props.liveOwnerTitleByKey.get(rowKey) ?? null,
  );
  const shells = props.row.shells;
  const processRows = buildProcessRows(
    props.row.snapshot.processes,
    props.expandedProcesses,
    props.row.snapshot,
    props.sortOption,
  );
  const processSearch = buildOwnerProcessSearchProjection({
    row: props.row,
    label,
    processRows,
    searchQuery: props.searchQuery,
    taskTerms: props.taskSearchTerms,
  });
  const visibleProcessRows = processSearch.rows;
  const visibleExpanded =
    props.expandedOwners.has(rowKey) || processSearch.forcesExpanded;
  // Shells and OS processes hang off the same chevron, so either one is reason
  // enough to offer it.
  const canExpand = visibleProcessRows.canExpand || shells.length > 0;
  const actionTarget = ownerSnapshotActionTarget(props.row.snapshot, rowKey);
  const actions = props.actions ?? null;
  const canAct = actions !== null && actionTarget !== null;
  const selecting = canAct && actions.selectionMode;
  const selected = selecting && actions.isSelected(actionTarget.key);
  const rowClick = ownerRowClickHandler(selecting, actions, actionTarget, () =>
    props.onOpenOwner(props.row),
  );
  return (
    <div>
      <div
        className={cn(
          "group relative flex items-center pr-3.5 transition-colors hover:bg-foreground/5",
          selected && "bg-foreground/5",
          visibleExpanded && "sticky z-10 bg-popover",
        )}
        style={{
          paddingLeft: `${props.depth}rem`,
          ...(visibleExpanded ? { top: props.stickyTop } : {}),
        }}
      >
        <OwnerRowLeadingCell
          actions={actions}
          target={actionTarget}
          label={label}
          canExpand={canExpand}
          expanded={visibleExpanded}
          forcedExpanded={processSearch.forcesExpanded}
          onToggle={() => props.onToggleOwner(rowKey)}
        />
        <button
          type="button"
          onClick={rowClick}
          disabled={!selecting && !props.row.canOpen}
          {...{
            [RESOURCE_NAVIGATION_KEY_ATTRIBUTE]: resourceNavigationKey(
              props.row.canOpen,
              selecting,
              rowKey,
            ),
          }}
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
              <OwnerProviderIcon
                harnessId={props.row.snapshot.harnessId}
                managedCommand={props.row.snapshot.managedCommand}
                synthetic={props.row.synthetic}
              />
              <span className="min-w-0 truncate">
                {harnessProviderSubtitle(
                  props.row.snapshot.harnessId,
                  owner.kind,
                  props.row.snapshot.activeProcessName,
                )}
              </span>
            </div>
          </div>
          <OwnerRowMetrics
            row={props.row}
            processRows={processRows}
            expanded={visibleExpanded}
            hasDescendants={canExpand}
          />
        </button>
        <OwnerRowActionCell
          actions={actions}
          target={actionTarget}
          label={label}
        />
      </div>
      {!visibleExpanded
        ? null
        : shells.map((shell) => (
            <OwnerTreeRow
              key={ownerRowKey(shell)}
              row={shell}
              depth={props.depth + 1}
              searchQuery={props.searchQuery}
              taskSearchTerms={props.taskSearchTerms}
              liveOwnerTitleByKey={props.liveOwnerTitleByKey}
              expandedOwners={props.expandedOwners}
              expandedProcesses={props.expandedProcesses}
              sortOption={props.sortOption}
              stickyTop={props.stickyTop}
              onToggleOwner={props.onToggleOwner}
              onToggleProcess={props.onToggleProcess}
              onOpenOwner={props.onOpenOwner}
              actions={props.actions}
            />
          ))}
      {!visibleExpanded
        ? null
        : visibleProcessRows.rows.map((processRow) => (
            <ProcessTreeRow
              key={processRowKey(processRow.process)}
              processRow={processRow}
              ownerDepth={props.depth}
              stickyTop={props.stickyTop}
              labelMode="full"
              onToggleExpand={props.onToggleProcess}
              actions={props.actions}
              killHostId={owner.hostId}
            />
          ))}
    </div>
  );
}

/**
 * The owner row's cpu/memory cell. Collapsed it states the whole subtree (own
 * process tree plus its shells'); expanded it states only this row's own
 * process, the rest now carried on the lines below. A Synthetic Agent Row has
 * no process at all, so expanded it states nothing rather than a row of zeroes.
 */
function OwnerRowMetrics(props: {
  readonly row: OwnerDisplayRow;
  readonly processRows: OwnerProcessRows;
  readonly expanded: boolean;
  readonly hasDescendants: boolean;
}) {
  if (props.row.synthetic) {
    // No process of its own means no honest Self/Tree split to offer a
    // tooltip: collapsed states the shells' sum plainly, expanded nothing.
    if (props.expanded) return <MetricSpacer />;
    return (
      <MetricPair
        cpuPercent={props.row.treeCpuPercent}
        rssBytes={props.row.treeRssBytes}
        className="text-ui-sm text-foreground/90"
      />
    );
  }
  return (
    <ProcessMetricPair
      cpuPercent={
        props.expanded
          ? props.processRows.selfCpuPercent
          : props.row.treeCpuPercent
      }
      rssBytes={
        props.expanded ? props.processRows.selfRssBytes : props.row.treeRssBytes
      }
      selfCpuPercent={props.processRows.selfCpuPercent}
      selfRssBytes={props.processRows.selfRssBytes}
      treeCpuPercent={props.row.treeCpuPercent}
      treeRssBytes={props.row.treeRssBytes}
      hasDescendants={props.hasDescendants}
      className="text-ui-sm text-foreground/90"
    />
  );
}

/** Holds the cpu/memory columns for a row that has no numbers of its own. */
function MetricSpacer() {
  return (
    <div className={cn(METRIC_COLS, "text-ui-sm")}>
      <span className={CPU_COL} />
      <span className={MEM_COL} />
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
  readonly actions: ResourceRowActionApi | null;
  readonly killHostId: string | null;
  readonly process: ResourceProcessSnapshotWire;
  readonly label: string;
}) {
  // `?? null` collapses undefined to null: a partial HMR update can transiently
  // render this row before a parent passes `kill`, and a hover affordance must
  // never crash the whole popover.
  const actions = props.actions ?? null;
  const killHostId = props.killHostId ?? null;
  if (actions === null || killHostId === null) {
    return <span className={ROW_ACTION_SLOT} />;
  }
  const target: KillTarget = {
    kind: "kill",
    key: processRowKey(props.process),
    hostId: killHostId,
    pids: [props.process.pid],
  };
  if (actions.selectionMode) {
    // The selection checkbox lives on the row's LEFT (matching the chat /
    // artifact selection convention); keep the trailing gutter as a spacer.
    return <span className={ROW_ACTION_SLOT} />;
  }
  return (
    <ConfirmableRowAction
      target={target}
      label={props.label}
      onRun={actions.runOne}
      isPending={actions.isPending}
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

function processExpandAriaLabel(row: ProcessDisplayRow): string {
  const label = processLabel(row.process);
  if (row.searchForcesExpanded) {
    return `Sub-processes of ${label} expanded by search`;
  }
  return `${row.expanded ? "Collapse" : "Expand"} sub-processes of ${label}`;
}

function ProcessTreeRow(props: {
  readonly processRow: ProcessDisplayRow;
  /**
   * Indent levels contributed by the owner row above this tree, so a nested
   * shell's processes sit deeper than its creator's own processes instead of
   * lining up with them.
   */
  readonly ownerDepth: number;
  readonly stickyTop: number;
  readonly labelMode: "full" | "compact-root";
  readonly onToggleExpand: (key: string) => void;
  readonly actions: ResourceRowActionApi | null;
  readonly killHostId: string | null;
}) {
  const {
    process,
    depth,
    canExpand,
    expanded,
    searchForcesExpanded,
    hiddenCount,
    treeCpuPercent,
    treeRssBytes,
  } = props.processRow;
  const actions = props.actions ?? null;
  const killHostId = props.killHostId ?? null;
  const selecting =
    actions !== null && killHostId !== null && actions.selectionMode;
  const rowKey = processRowKey(process);
  const selected = selecting && actions.isSelected(rowKey);
  const rowClassName =
    "flex min-w-0 flex-1 items-center justify-between gap-3 py-1 pl-3.5 text-left text-muted-foreground transition-colors hover:bg-foreground/5";
  const rowStyle = {
    paddingLeft: `calc(1.25rem + ${props.ownerDepth + depth} * 1rem)`,
  };
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
          actions.toggleSelection({
            kind: "kill",
            key: rowKey,
            hostId: killHostId,
            pids: [process.pid],
          })
        }
        className={cn(
          rowClassName,
          "outline-none focus-visible:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
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
        aria-label={processExpandAriaLabel(props.processRow)}
        disabled={searchForcesExpanded}
        onClick={() => props.onToggleExpand(processRowKey(process))}
        className={cn(
          rowClassName,
          "outline-none focus-visible:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default",
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
          selected && "bg-foreground/5",
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
                  actions.toggleSelection({
                    kind: "kill",
                    key: rowKey,
                    hostId: killHostId,
                    pids: [process.pid],
                  })
              : null
          }
        />
        {row}
        <ProcessRowKillCell
          actions={props.actions}
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
              ownerDepth={props.ownerDepth}
              stickyTop={props.stickyTop}
              labelMode="full"
              onToggleExpand={props.onToggleExpand}
              actions={props.actions}
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

interface TaskRowBuildInput {
  readonly entries: readonly GlobalResourceEpicEntry[];
  readonly canvas: CanvasResourceSnapshot;
  readonly canvasIndex: CanvasResourceIndex;
  readonly recordByOwner: ReadonlyMap<string, EpicNodeRecord>;
  readonly epicTitleById: ReadonlyMap<string, string>;
  readonly sortOption: ResourceSortOption;
}

/** The owner kinds an agent's own program runs under - the only shell creators. */
const AGENT_OWNER_KINDS = ["chat", "terminal-agent"] as const;

function isAgentOwnerKind(kind: ResourceOwnerKindWireV14): boolean {
  return AGENT_OWNER_KINDS.some((candidate) => candidate === kind);
}

function buildTaskRows(input: TaskRowBuildInput): TaskDisplayRow[] {
  const rows = input.entries.flatMap((entry): TaskDisplayRow[] => {
    if (entry.owners.length === 0) return [];
    const flatRows = entry.owners.map((snapshot) =>
      buildOwnerRow(snapshot, input),
    );
    const owners = nestShellsUnderCreators(flatRows, input).map((row) =>
      row.shells.length === 0
        ? row
        : { ...row, shells: sortOwnerRows(row.shells, input.sortOption) },
    );
    return [
      {
        entry,
        label: taskLabel(entry.epicId, input.canvas, input.epicTitleById),
        tabOrder: taskTabOrder(entry.epicId, input.canvas),
        // Top-level totals are already subtree-inclusive, so nesting a shell
        // under its creator moves where its usage is reported without changing
        // what the section header adds up to.
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

function buildOwnerRow(
  snapshot: OwnerResourceSnapshotWireV14,
  input: TaskRowBuildInput,
): OwnerDisplayRow {
  const key = ownerKey(
    snapshot.owner.epicId,
    snapshot.owner.kind,
    snapshot.owner.ownerId,
  );
  const location = input.canvasIndex.locationByOwner.get(key) ?? null;
  const closedTile = input.canvasIndex.closedTileByOwner.get(key) ?? null;
  const record = input.recordByOwner.get(key) ?? null;
  const processRows = buildProcessRows(
    snapshot.processes,
    NO_EXPANDED_PROCESSES,
    snapshot,
    input.sortOption,
  );
  return {
    snapshot,
    label: ownerLabel(
      snapshot,
      ownerTileRef(location, closedTile),
      record,
      null,
    ),
    canOpen: canOpenOwner(snapshot, location, closedTile, record),
    tabOrder:
      input.canvasIndex.tabOrderByOwner.get(key) ?? Number.MAX_SAFE_INTEGER,
    location,
    closedTile,
    record,
    shells: [],
    synthetic: false,
    treeCpuPercent: processRows.treeCpuPercent,
    treeRssBytes: processRows.treeRssBytes,
  };
}

/**
 * Nests every shell row under a node for its creator. While the creator's own
 * agent program is running, that node IS its owner row; otherwise a Synthetic
 * Agent Row stands in. A shell whose creator names no agent this client can
 * resolve stays where it has always been - flat, at the task level.
 */
function nestShellsUnderCreators(
  rows: readonly OwnerDisplayRow[],
  input: TaskRowBuildInput,
): OwnerDisplayRow[] {
  const shells = rows.filter(
    (row) => row.snapshot.owner.kind === "managed-command",
  );
  if (shells.length === 0) return [...rows];
  const parents = rows.filter(
    (row) => row.snapshot.owner.kind !== "managed-command",
  );
  const runningCreators = new Map(
    parents
      .filter((row) => isAgentOwnerKind(row.snapshot.owner.kind))
      .map((row): [string, OwnerDisplayRow] => [
        row.snapshot.owner.ownerId,
        row,
      ]),
  );
  const syntheticCreators = new Map<string, OwnerDisplayRow>();
  const shellsByCreatorId = new Map<string, OwnerDisplayRow[]>();
  const unparented: OwnerDisplayRow[] = [];

  for (const shell of shells) {
    const creatorId = shell.snapshot.managedCommand?.createdByAgentId ?? "";
    let creator =
      runningCreators.get(creatorId) ??
      syntheticCreators.get(creatorId) ??
      null;
    if (creator === null) {
      creator = buildSyntheticAgentRow(creatorId, shell, input);
      if (creator !== null) syntheticCreators.set(creatorId, creator);
    }
    if (creator === null) {
      unparented.push(shell);
      continue;
    }
    const attached = shellsByCreatorId.get(creatorId);
    if (attached === undefined) shellsByCreatorId.set(creatorId, [shell]);
    else attached.push(shell);
  }

  const attachShells = (row: OwnerDisplayRow): OwnerDisplayRow => {
    if (!isAgentOwnerKind(row.snapshot.owner.kind)) return row;
    const attached = shellsByCreatorId.get(row.snapshot.owner.ownerId) ?? [];
    if (attached.length === 0) return row;
    return {
      ...row,
      shells: attached,
      treeCpuPercent: attached.reduce(
        (sum, shell) => sum + shell.treeCpuPercent,
        row.treeCpuPercent,
      ),
      treeRssBytes: attached.reduce(
        (sum, shell) => sum + shell.treeRssBytes,
        row.treeRssBytes,
      ),
    };
  };
  return [
    ...parents.map(attachShells),
    ...[...syntheticCreators.values()].map(attachShells),
    ...unparented,
  ];
}

/**
 * The Synthetic Agent Row for a creator whose own program is not running. Its
 * snapshot is an honest all-zero one: this agent really does own no processes
 * right now, which is what leaves the row with no kill affordance and no usage
 * of its own to report. `null` when nothing in this client names the creator -
 * the caller then leaves the shell flat rather than inventing an unknown node.
 */
function buildSyntheticAgentRow(
  creatorId: string,
  shell: OwnerDisplayRow,
  input: TaskRowBuildInput,
): OwnerDisplayRow | null {
  if (creatorId.length === 0) return null;
  const epicId = shell.snapshot.owner.epicId;
  for (const kind of AGENT_OWNER_KINDS) {
    const key = ownerKey(epicId, kind, creatorId);
    const location = input.canvasIndex.locationByOwner.get(key) ?? null;
    const closedTile = input.canvasIndex.closedTileByOwner.get(key) ?? null;
    const record = input.recordByOwner.get(key) ?? null;
    if (location === null && closedTile === null && record === null) continue;
    const snapshot: OwnerResourceSnapshotWireV14 = {
      owner: {
        kind,
        hostId: shell.snapshot.owner.hostId,
        epicId,
        ownerId: creatorId,
      },
      sampledAt: shell.snapshot.sampledAt,
      rootPids: [],
      activeProcessName: null,
      processCount: 0,
      cpuPercent: 0,
      rssBytes: 0,
      processes: [],
      harnessId: null,
      managedCommand: null,
    };
    return {
      snapshot,
      label: ownerLabel(
        snapshot,
        ownerTileRef(location, closedTile),
        record,
        null,
      ),
      canOpen: canOpenOwner(snapshot, location, closedTile, record),
      tabOrder:
        input.canvasIndex.tabOrderByOwner.get(key) ?? Number.MAX_SAFE_INTEGER,
      location,
      closedTile,
      record,
      shells: [],
      synthetic: true,
      treeCpuPercent: 0,
      treeRssBytes: 0,
    };
  }
  return null;
}

/** A task section's rows in render order: each top-level row, then its shells. */
function flattenOwnerRows(rows: readonly OwnerDisplayRow[]): OwnerDisplayRow[] {
  return rows.flatMap((row) => [row, ...row.shells]);
}

/**
 * The owner rows currently on screen in a task section: a parent's shells
 * count only once the parent is expanded - by hand, or by the search
 * force-expand that reveals a shell whose parent failed to match on its own
 * terms (mirroring `buildOwnerProcessSearchProjection`). Kill targeting must
 * track exactly this: "Select all" must never reap a row the user cannot see.
 */
function visibleOwnerRowsForTask(
  task: TaskDisplayRow,
  searchQuery: string,
  liveOwnerTitleByKey: ReadonlyMap<string, string | null>,
  expandedOwners: ReadonlySet<string>,
): OwnerDisplayRow[] {
  // A matching task renders its owners with an empty query (no forcing), the
  // same substitution TaskResourceSection makes.
  const effectiveQuery = taskRowMatchesSearch(task, searchQuery)
    ? ""
    : searchQuery;
  const searchActive = normalizeResourceSearch(effectiveQuery).length > 0;
  return task.owners.flatMap((row) => {
    if (row.shells.length === 0) return [row];
    const key = ownerRowKey(row);
    let shellsVisible = expandedOwners.has(key);
    if (!shellsVisible && searchActive) {
      const label = resolvedOwnerLabel(
        row,
        liveOwnerTitleByKey.get(key) ?? null,
      );
      shellsVisible = !matchesResourceSearch(effectiveQuery, [
        ...taskSearchTerms(task),
        ...ownerMetadataSearchTerms(row, label),
      ]);
    }
    return shellsVisible ? [row, ...row.shells] : [row];
  });
}

function normalizeResourceSearch(searchQuery: string): string {
  return searchQuery.trim().toLowerCase();
}

function matchesResourceSearch(
  searchQuery: string,
  terms: readonly (string | number | null)[],
): boolean {
  const normalized = normalizeResourceSearch(searchQuery);
  if (normalized.length === 0) return true;
  const haystack = terms
    .map((term) => (term === null ? "" : String(term)))
    .join(" ")
    .toLowerCase();
  return normalized.split(/\s+/).every((token) => haystack.includes(token));
}

function processSearchTerms(
  process: ResourceProcessSnapshotWire,
): readonly (string | number | null)[] {
  return [
    process.name,
    process.command,
    process.pid,
    process.parentPid,
    process.rootPid,
  ];
}

function matchingProcessPidsForSearch(
  processes: readonly ResourceProcessSnapshotWire[],
  searchQuery: string,
  ancestorTerms: readonly (string | number | null)[],
): ReadonlySet<number> {
  const processByPid = new Map(
    processes.map((process) => [process.pid, process]),
  );
  return new Set(
    processes
      .filter((process) => {
        const lineageTerms: (string | number | null)[] = [...ancestorTerms];
        let current: ResourceProcessSnapshotWire | undefined = process;
        const visitedPids = new Set<number>();
        while (current !== undefined && !visitedPids.has(current.pid)) {
          visitedPids.add(current.pid);
          lineageTerms.push(...processSearchTerms(current));
          current =
            current.parentPid === null
              ? undefined
              : processByPid.get(current.parentPid);
        }
        return matchesResourceSearch(searchQuery, lineageTerms);
      })
      .map((process) => process.pid),
  );
}

function taskRowMatchesSearch(
  task: TaskDisplayRow,
  searchQuery: string,
): boolean {
  return matchesResourceSearch(searchQuery, taskSearchTerms(task));
}

function taskSearchTerms(
  task: TaskDisplayRow,
): readonly (string | number | null)[] {
  return [task.label, task.entry.epicId];
}

function ownerMetadataSearchTerms(
  row: OwnerDisplayRow,
  label: string,
): readonly (string | number | null)[] {
  const snapshot = row.snapshot;
  return [
    label,
    ownerKindLabel(snapshot.owner.kind),
    harnessProviderSubtitle(
      snapshot.harnessId,
      snapshot.owner.kind,
      snapshot.activeProcessName,
    ),
    snapshot.owner.ownerId,
    snapshot.owner.hostId,
  ];
}

function resolvedOwnerLabel(
  row: OwnerDisplayRow,
  liveArtifactTitle: string | null,
): string {
  return ownerLabel(
    row.snapshot,
    ownerTileRef(row.location, row.closedTile),
    row.record,
    liveArtifactTitle,
  );
}

function ownerHierarchyMatchesSearch(
  task: TaskDisplayRow,
  row: OwnerDisplayRow,
  searchQuery: string,
  liveArtifactTitle: string | null,
): boolean {
  const label = resolvedOwnerLabel(row, liveArtifactTitle);
  const ownerTerms = [
    ...taskSearchTerms(task),
    ...ownerMetadataSearchTerms(row, label),
  ];
  return (
    matchesResourceSearch(searchQuery, ownerTerms) ||
    matchingProcessPidsForSearch(
      row.snapshot.processes,
      searchQuery,
      ownerTerms,
    ).size > 0
  );
}

function buildOwnerProcessSearchProjection(input: {
  readonly row: OwnerDisplayRow;
  readonly label: string;
  readonly processRows: OwnerProcessRows;
  readonly searchQuery: string;
  readonly taskTerms: readonly (string | number | null)[];
}): { readonly rows: OwnerProcessRows; readonly forcesExpanded: boolean } {
  const ownerTerms = [
    ...input.taskTerms,
    ...ownerMetadataSearchTerms(input.row, input.label),
  ];
  const ownerMatches = matchesResourceSearch(input.searchQuery, ownerTerms);
  const filteredRows = input.processRows.rootRows.flatMap((root) => {
    const rootTerms = [...ownerTerms, ...processSearchTerms(root.process)];
    const rootMatches = matchesResourceSearch(input.searchQuery, rootTerms);
    return filterProcessDisplayRowsForSearch(
      rootMatches ? [root] : root.children,
      input.searchQuery,
      rootMatches ? ownerTerms : rootTerms,
    );
  });
  return {
    rows: ownerMatches
      ? input.processRows
      : {
          ...input.processRows,
          rows: filteredRows,
          canExpand: filteredRows.length > 0,
        },
    forcesExpanded:
      normalizeResourceSearch(input.searchQuery).length > 0 && !ownerMatches,
  };
}

function filterTaskRowsForSearch(
  rows: readonly TaskDisplayRow[],
  searchQuery: string,
  liveOwnerTitleByKey: ReadonlyMap<string, string | null>,
): TaskDisplayRow[] {
  if (normalizeResourceSearch(searchQuery).length === 0) return [...rows];
  const matches = (row: OwnerDisplayRow, task: TaskDisplayRow): boolean =>
    ownerHierarchyMatchesSearch(
      task,
      row,
      searchQuery,
      liveOwnerTitleByKey.get(ownerRowKey(row)) ?? null,
    );
  return rows.flatMap((task): TaskDisplayRow[] => {
    if (taskRowMatchesSearch(task, searchQuery)) return [task];
    // A parent that matches keeps its whole subtree; one that does not survives
    // only on its matching shells, so searching a shell's name reveals it (the
    // parent force-expands, having failed to match on its own terms).
    const owners = task.owners.flatMap((owner): OwnerDisplayRow[] => {
      if (matches(owner, task)) return [owner];
      const shells = owner.shells.filter((shell) => matches(shell, task));
      if (shells.length === 0) return [];
      // The subtree totals must describe the shells that survived the filter,
      // not the ones it removed - the metrics tooltip renders them even while
      // the row itself is force-expanded.
      const droppedCpu = owner.shells.reduce(
        (sum, shell) =>
          shells.includes(shell) ? sum : sum + shell.treeCpuPercent,
        0,
      );
      const droppedRss = owner.shells.reduce(
        (sum, shell) =>
          shells.includes(shell) ? sum : sum + shell.treeRssBytes,
        0,
      );
      return [
        {
          ...owner,
          shells,
          treeCpuPercent: owner.treeCpuPercent - droppedCpu,
          treeRssBytes: owner.treeRssBytes - droppedRss,
        },
      ];
    });
    return owners.length === 0 ? [] : [{ ...task, owners }];
  });
}

function buildResourceSearchProjection(input: {
  readonly desktopApp: DesktopAppResourceUsage | null;
  readonly hostApp: AppResourceUsage | null;
  readonly other: OtherResourceUsage | null;
  readonly taskRows: readonly TaskDisplayRow[];
  readonly liveOwnerTitleByKey: ReadonlyMap<string, string | null>;
  readonly searchQuery: string;
  readonly expandedOwners: ReadonlySet<string>;
}): ResourceSearchProjection {
  const desktopApp =
    input.desktopApp !== null &&
    desktopAppMatchesSearch(input.desktopApp, input.searchQuery)
      ? input.desktopApp
      : null;
  const hostApp =
    input.hostApp !== null &&
    hostAppMatchesSearch(input.hostApp, input.searchQuery)
      ? input.hostApp
      : null;
  const other =
    input.other !== null &&
    otherResourcesMatchSearch(input.other, input.searchQuery)
      ? input.other
      : null;
  const taskRows = filterTaskRowsForSearch(
    input.taskRows,
    input.searchQuery,
    input.liveOwnerTitleByKey,
  );
  const visibleOwnerKeys = new Set(
    taskRows.flatMap((task) =>
      visibleOwnerRowsForTask(
        task,
        input.searchQuery,
        input.liveOwnerTitleByKey,
        input.expandedOwners,
      ).map(ownerRowKey),
    ),
  );
  const visibleKillKeys = buildSearchVisibleKillKeys({
    taskRows,
    other,
    searchQuery: input.searchQuery,
    liveOwnerTitleByKey: input.liveOwnerTitleByKey,
    expandedOwners: input.expandedOwners,
  });
  const active = normalizeResourceSearch(input.searchQuery).length > 0;
  const hasResults =
    desktopApp !== null ||
    hostApp !== null ||
    other !== null ||
    taskRows.length > 0;
  return {
    desktopApp,
    hostApp,
    other,
    taskRows,
    visibleOwnerKeys,
    visibleKillKeys,
    active,
    noResults: active && !hasResults,
  };
}

function buildSearchVisibleKillKeys(input: {
  readonly taskRows: readonly TaskDisplayRow[];
  readonly other: OtherResourceUsage | null;
  readonly searchQuery: string;
  readonly liveOwnerTitleByKey: ReadonlyMap<string, string | null>;
  readonly expandedOwners: ReadonlySet<string>;
}): ReadonlySet<string> {
  const { taskRows, other, searchQuery, liveOwnerTitleByKey, expandedOwners } =
    input;
  const visibleKeys = new Set<string>();
  for (const task of taskRows) {
    const taskMatches = taskRowMatchesSearch(task, searchQuery);
    for (const owner of visibleOwnerRowsForTask(
      task,
      searchQuery,
      liveOwnerTitleByKey,
      expandedOwners,
    )) {
      const key = ownerRowKey(owner);
      visibleKeys.add(key);
      const label = resolvedOwnerLabel(
        owner,
        liveOwnerTitleByKey.get(key) ?? null,
      );
      const taskTerms = taskSearchTerms(task);
      const ownerTerms = [
        ...taskTerms,
        ...ownerMetadataSearchTerms(owner, label),
      ];
      const ownerMatches =
        taskMatches || matchesResourceSearch(searchQuery, ownerTerms);
      const processKeys = ownerMatches
        ? owner.snapshot.processes.map(processRowKey)
        : searchVisibleProcessKeys(
            owner.snapshot.processes,
            searchQuery,
            ownerTerms,
          );
      for (const processKey of processKeys) visibleKeys.add(processKey);
    }
  }
  if (other === null) return visibleKeys;
  const otherMatches = matchesResourceSearch(searchQuery, ["Other"]);
  const otherProcessKeys = otherMatches
    ? other.processes.map(processRowKey)
    : searchVisibleProcessKeys(other.processes, searchQuery, ["Other"]);
  for (const processKey of otherProcessKeys) visibleKeys.add(processKey);
  if (!otherMatches) {
    const matchingRootPids = matchingOtherRootPids(
      other.processes,
      searchQuery,
    );
    for (const process of other.processes) {
      if (
        process.pid === process.rootPid &&
        matchingRootPids.has(process.pid)
      ) {
        visibleKeys.add(processRowKey(process));
      }
    }
  }
  return visibleKeys;
}

function searchVisibleProcessKeys(
  processes: readonly ResourceProcessSnapshotWire[],
  searchQuery: string,
  ancestorTerms: readonly (string | number | null)[],
): ReadonlySet<string> {
  const processByPid = new Map(
    processes.map((process) => [process.pid, process]),
  );
  const structuralRootPids = new Set(
    processes
      .filter(
        (process) =>
          process.parentPid === null || !processByPid.has(process.parentPid),
      )
      .map((process) => process.pid),
  );
  const matchingProcessPids = matchingProcessPidsForSearch(
    processes,
    searchQuery,
    ancestorTerms,
  );
  const visibleKeys = new Set<string>();
  for (const process of processes) {
    if (!matchingProcessPids.has(process.pid)) continue;
    let current: ResourceProcessSnapshotWire | undefined = process;
    const visitedPids = new Set<number>();
    while (current !== undefined && !visitedPids.has(current.pid)) {
      visitedPids.add(current.pid);
      if (
        !structuralRootPids.has(current.pid) ||
        matchingProcessPids.has(current.pid)
      ) {
        visibleKeys.add(processRowKey(current));
      }
      current =
        current.parentPid === null
          ? undefined
          : processByPid.get(current.parentPid);
    }
  }
  return visibleKeys;
}

function desktopAppMatchesSearch(
  app: DesktopAppResourceUsage,
  searchQuery: string,
): boolean {
  if (
    matchesResourceSearch(searchQuery, ["Traycer Desktop", "Main"]) ||
    matchesResourceSearch(searchQuery, ["Traycer Desktop", "Renderer"])
  ) {
    return true;
  }
  const showOther =
    app.other.cpuPercent > 0 ||
    app.other.rssBytes > 0 ||
    app.other.processCount > 0;
  return (
    showOther &&
    matchesResourceSearch(searchQuery, ["Traycer Desktop", "Other"])
  );
}

function hostAppMatchesSearch(
  app: AppResourceUsage,
  searchQuery: string,
): boolean {
  if (matchesResourceSearch(searchQuery, ["Traycer Host"])) return true;
  return (
    app.process !== null &&
    matchesResourceSearch(searchQuery, [
      "Traycer Host",
      ...processSearchTerms(app.process),
    ])
  );
}

function otherResourcesMatchSearch(
  other: OtherResourceUsage,
  searchQuery: string,
): boolean {
  return (
    matchesResourceSearch(searchQuery, ["Other"]) ||
    matchingProcessPidsForSearch(other.processes, searchQuery, ["Other"]).size >
      0
  );
}

function matchingOtherRootPids(
  processes: readonly ResourceProcessSnapshotWire[],
  searchQuery: string,
): ReadonlySet<number> {
  if (matchesResourceSearch(searchQuery, ["Other"])) {
    return new Set(processes.map((process) => process.rootPid));
  }
  const matchingProcessPids = matchingProcessPidsForSearch(
    processes,
    searchQuery,
    ["Other"],
  );
  const matchingRootPids = new Set<number>();
  for (const process of processes) {
    if (matchingProcessPids.has(process.pid)) {
      matchingRootPids.add(process.rootPid);
    }
  }
  return matchingRootPids;
}

function filterProcessDisplayRowsForSearch(
  rows: readonly ProcessDisplayRow[],
  searchQuery: string,
  ancestorTerms: readonly (string | number | null)[],
): ProcessDisplayRow[] {
  return rows.flatMap((row): ProcessDisplayRow[] => {
    const rowTerms = [...ancestorTerms, ...processSearchTerms(row.process)];
    const children = filterProcessDisplayRowsForSearch(
      row.children,
      searchQuery,
      rowTerms,
    );
    const rowMatches = matchesResourceSearch(searchQuery, rowTerms);
    if (!rowMatches && children.length === 0) return [];
    if (children.length === 0) {
      return [
        {
          ...row,
          canExpand: false,
          expanded: false,
          searchForcesExpanded: false,
          hiddenCount: 0,
          children,
        },
      ];
    }
    return [
      {
        ...row,
        canExpand: true,
        expanded: true,
        searchForcesExpanded: true,
        hiddenCount: 0,
        children,
      },
    ];
  });
}

function filterOwnerProcessRowsForSearch(
  processRows: OwnerProcessRows,
  searchQuery: string,
  includeRoots: boolean,
  ancestorTerms: readonly (string | number | null)[],
): OwnerProcessRows {
  if (normalizeResourceSearch(searchQuery).length === 0) return processRows;
  const rows = filterProcessDisplayRowsForSearch(
    includeRoots ? processRows.rootRows : processRows.rows,
    searchQuery,
    ancestorTerms,
  );
  return {
    ...processRows,
    rows: includeRoots ? processRows.rows : rows,
    rootRows: includeRoots ? rows : processRows.rootRows,
    canExpand: rows.length > 0,
  };
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

  // A tile closed out of a tab's canvas keeps its payload in
  // `closedTilePayloadsByTabId`; index those refs so the owner row can reopen
  // the tile (terminals have no artifact record, so this preserved ref is the
  // only way to reconstruct their tile).
  const closedTileByOwner = new Map<string, ClosedOwnerTile>();
  for (const tabId of indexedTabIds) {
    const tab = canvas.tabsById[tabId];
    if (tab === undefined) continue;
    for (const payload of Object.values(
      canvas.closedTilePayloadsByTabId[tabId] ?? {},
    )) {
      const node = payload?.node;
      if (node === undefined || !isOwnerNodeRef(node)) continue;
      const ownerKind = resourceOwnerKindForRef(node);
      if (ownerKind === null) continue;
      const key = ownerKey(tab.epicId, ownerKind, node.id);
      if (!closedTileByOwner.has(key)) {
        closedTileByOwner.set(key, { tabId, node });
      }
    }
  }

  return { locationByOwner, closedTileByOwner, tabOrderByOwner };
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
      name: undefined,
      focus: focusForOwner(args.row.snapshot),
      preparation: {
        kind: "activate-tile",
        paneId: location.paneId,
        tileTabId: location.tileTabId,
      },
      navigate: args.navigate,
      navigateNested: args.navigateNested,
      activeEpicId: args.activeEpicId,
      activeTabId: args.activeTabId,
      desktopNestedFocusEnabled: args.desktopNestedFocusEnabled,
    });
    return true;
  }

  const snapshot = args.row.snapshot;

  // No live tile, but the tile's payload survived its close (same store the
  // notification reopen path reads). Reopen the preserved ref in its original
  // tab - `setActiveTab` reinserts a hidden tab into the strip, and the
  // open-tile preparation re-adds the tile to that tab's canvas. This is the
  // only reopen path for terminals, whose refs (cwd, title) cannot be rebuilt
  // from the resource snapshot or an artifact record.
  const closedTile = args.row.closedTile;
  if (closedTile !== null) {
    commitOwnerFocus({
      epicId: snapshot.owner.epicId,
      tabId: closedTile.tabId,
      name: undefined,
      focus: focusForOwner(snapshot),
      // A preserved tile the human already chose to keep once: reopening it is
      // a return to their own tab, not a glance at a new one.
      preparation: { kind: "open-tile", node: closedTile.node, preview: false },
      navigate: args.navigate,
      navigateNested: args.navigateNested,
      activeEpicId: args.activeEpicId,
      activeTabId: args.activeTabId,
      desktopNestedFocusEnabled: args.desktopNestedFocusEnabled,
    });
    return true;
  }

  // A shell has no canvas node to reopen - its output window is built from the
  // command id alone, and the canvas's content-id dedup turns "open" into
  // "focus the one that is already there".
  if (snapshot.owner.kind === "managed-command") {
    commitOwnerFocus({
      epicId: snapshot.owner.epicId,
      tabId: null,
      name: taskLabel(snapshot.owner.epicId, args.canvas, args.epicTitleById),
      focus: focusForOwner(snapshot),
      preparation: {
        kind: "open-tile",
        node: makeManagedCommandOutputTileRef({
          commandId: snapshot.owner.ownerId,
          hostId: snapshot.owner.hostId,
        }),
        // Same glance every other shell door is (see
        // `useOpenManagedCommandOutput`): jumping from a resource row to the
        // log is a look, and the strip should not keep it unasked.
        preview: true,
      },
      navigate: args.navigate,
      navigateNested: args.navigateNested,
      activeEpicId: args.activeEpicId,
      activeTabId: args.activeTabId,
      desktopNestedFocusEnabled: args.desktopNestedFocusEnabled,
    });
    return true;
  }

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
  commitOwnerFocus({
    epicId: snapshot.owner.epicId,
    tabId: null,
    name: taskLabel(snapshot.owner.epicId, args.canvas, args.epicTitleById),
    focus: focusForOwner(snapshot),
    preparation: {
      kind: "open-tile",
      node: {
        id: record.id,
        instanceId: uuidv4(),
        type: recordType,
        name: record.name,
        hostId: record.hostId,
      },
      preview: false,
    },
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
 * Cross-route passes an unresolved preparation payload to the top-level
 * navigation controller. The controller resolves/creates and activates the
 * exact header tab first, then prepares nested focus and issues one correlated
 * route navigation carrying that target.
 */
function commitOwnerFocus(args: {
  readonly epicId: string;
  readonly tabId: string | null;
  readonly name: string | undefined;
  readonly focus: EpicRouteFocus;
  readonly preparation: EpicPostResolvePreparation;
  readonly navigate: NavigateFn;
  readonly navigateNested: NavigateNestedFocus;
  readonly activeEpicId: string | null;
  readonly activeTabId: string | null;
  readonly desktopNestedFocusEnabled: boolean;
}): void {
  if (
    args.tabId !== null &&
    args.epicId === args.activeEpicId &&
    args.tabId === args.activeTabId
  ) {
    const tabId = args.tabId;
    args.navigateNested(args.epicId, tabId, () =>
      prepareResourceTarget(tabId, args.preparation),
    );
    return;
  }
  activateTabIntent(
    args.navigate,
    resourceEpicTabIntent({
      epicId: args.epicId,
      tabId: args.tabId,
      name: args.name,
      focus: args.focus,
      preparation: args.preparation,
      includeNestedFocus: args.desktopNestedFocusEnabled,
    }),
    undefined,
  );
}

function prepareResourceTarget(
  tabId: string,
  preparation: EpicPostResolvePreparation,
): NestedFocusTarget | null {
  const canvas = useEpicCanvasStore.getState();
  if (preparation.kind === "open-tile") {
    return preparation.preview
      ? canvas.prepareOpenTilePreviewInTabFocusTarget(tabId, preparation.node)
      : canvas.prepareOpenTileInTabFocusTarget(tabId, preparation.node);
  }
  return canvas.prepareSetActiveTileTabFocusTarget(
    tabId,
    preparation.paneId,
    preparation.tileTabId,
  );
}

// Terminals and shells are not artifacts, so neither has an artifact id to
// focus - the tile preparation is the whole of what they navigate to.
function focusForOwner(snapshot: OwnerResourceSnapshotWireV14): EpicRouteFocus {
  const kind = snapshot.owner.kind;
  return {
    focusedAt: Date.now(),
    focusArtifactId:
      kind === "terminal" || kind === "managed-command"
        ? undefined
        : snapshot.owner.ownerId,
    focusThreadId: undefined,
    migrationSource: undefined,
  };
}

function findOwnerRecord(
  canvas: CanvasResourceSnapshot,
  snapshot: OwnerResourceSnapshotWireV14,
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
  kind: ResourceOwnerKindWireV14,
  ownerId: string,
): string {
  return `${epicId}\x1f${kind}\x1f${ownerId}`;
}

function ownerRowKey(row: OwnerDisplayRow): string {
  return ownerKey(
    row.snapshot.owner.epicId,
    row.snapshot.owner.kind,
    row.snapshot.owner.ownerId,
  );
}

function resourceOwnerKindForNodeType(
  type: string,
): ResourceOwnerKindWireV14 | null {
  if (type === "terminal-agent") return "terminal-agent";
  if (type === "chat") return "chat";
  return null;
}

function resourceOwnerKindForRef(
  ref: EpicCanvasTileRef,
): ResourceOwnerKindWireV14 | null {
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

function ownerKindLabel(kind: ResourceOwnerKindWireV14): string {
  // Several owner kinds render side by side here, so a raw Terminal has to stay
  // distinguishable from an Agent using the Terminal interface - qualification
  // is warranted. It uses the interface axis rather than coining "Chat agent" /
  // "Terminal agent" as sibling nouns, which would restate the entity model the
  // rename removes.
  if (kind === "terminal") return "Terminal";
  if (kind === "terminal-agent") return "Agent (Terminal)";
  if (kind === "managed-command") {
    // The KIND, not this shell's name: it sits in a column of classes
    // ("Terminal", "Agent (Chat)"), and a monitor is a shell. The row title
    // beside it is where the monitor flag speaks.
    return MANAGED_COMMAND_NOUN;
  }
  return "Agent (Chat)";
}

/**
 * Row title for a managed command. Its own description is the only name it
 * has - it is not a canvas node, so none of the tile/record fallbacks the
 * other owner kinds walk apply to it.
 *
 * Straight through `managedCommandTitle`, exactly as the Shells list names the
 * same shell: the owner frame carries `monitoring` precisely so one process
 * tree is not labelled two different ways. An owner the host sent without
 * naming (nothing does today) falls back to the umbrella noun rather than to a
 * third one - "Managed command" is the term the UI does not use.
 */
function managedCommandLabel(
  managedCommand: ManagedCommandOwnerWire | null,
): string {
  if (managedCommand === null) return MANAGED_COMMAND_NOUN;
  return managedCommandTitle(managedCommand);
}

// Subtitle beside the provider icon. Always non-empty so the icon never sits
// alone on its line: a known provider shows its friendly name ("Claude Code"),
// a harness-less owner (plain terminal) keeps its kind label; the running
// process name trails either when present.
function harnessProviderSubtitle(
  harnessId: string | null,
  kind: ResourceOwnerKindWireV14,
  activeProcessName: string | null,
): string {
  // A managed command already names itself in the row title, so its subtitle
  // spends the width on what is actually running instead of repeating it.
  if (kind === "managed-command") {
    return activeProcessName ?? MANAGED_COMMAND_NOUN;
  }
  const providerId = harnessId === null ? null : normalizeProviderId(harnessId);
  const base =
    providerId === null ? ownerKindLabel(kind) : agentProviderLabel(providerId);
  return activeProcessName === null ? base : `${base} · ${activeProcessName}`;
}

/**
 * The owner's tile ref for labelling - the live canvas tile when one is
 * open, otherwise the preserved closed-tile payload's ref, so a closed
 * terminal keeps its manually-set title readable after the tile leaves the
 * canvas.
 */
function ownerTileRef(
  location: OpenOwnerLocation | null,
  closedTile: ClosedOwnerTile | null,
): EpicNodeRef | null {
  return location?.ref ?? closedTile?.node ?? null;
}

function ownerLabel(
  snapshot: OwnerResourceSnapshotWireV14,
  ref: EpicNodeRef | null,
  record: EpicNodeRecord | null,
  liveArtifactTitle: string | null,
): string {
  if (snapshot.owner.kind === "terminal") {
    if (ref?.type === "terminal" && ref.titleSource === "manual") {
      return ref.name;
    }
    return terminalSessionTitle({
      title: null,
      activeProcessName: snapshot.activeProcessName,
      currentCwd: null,
    });
  }
  if (snapshot.owner.kind === "chat") {
    // Durable Agent read surface: an untitled Chat-interface Agent falls back
    // to "Untitled agent" (this light surface carries no first-user-message to
    // derive from).
    return displayTitle(
      liveArtifactTitle || ref?.name || record?.name || "",
      "agent",
    );
  }
  if (snapshot.owner.kind === "managed-command") {
    return managedCommandLabel(snapshot.managedCommand);
  }
  if (liveArtifactTitle !== null) return liveArtifactTitle;
  if (ref !== null) return ref.name;
  if (record !== null) return record.name;
  return ownerKindLabel(snapshot.owner.kind);
}

function canOpenOwner(
  snapshot: OwnerResourceSnapshotWireV14,
  location: OpenOwnerLocation | null,
  closedTile: ClosedOwnerTile | null,
  record: EpicNodeRecord | null,
): boolean {
  if (location !== null) return true;
  if (closedTile !== null) return true;
  // A shell's output window is a pure pointer (command id + host), so it can
  // always be opened - there is no tile payload or artifact record to have lost.
  if (snapshot.owner.kind === "managed-command") return true;
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
      searchForcesExpanded: false,
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
