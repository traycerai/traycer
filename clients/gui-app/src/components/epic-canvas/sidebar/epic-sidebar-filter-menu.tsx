/**
 * Stable, nested view menus for the Agents and Artifacts section headers.
 *
 * The trigger is always visible and always last in its header action cluster.
 * Root rows summarize the current view; supported details open to the right via
 * Radix submenus. When there is not enough room for two menu columns, the same
 * root drills into a detail page with Back instead of flipping left.
 */
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronLeft,
  ChevronRight,
  CopyMinus,
  ListFilter,
  RotateCcw,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import {
  EPIC_NODE_ICONS,
  EPIC_NODE_LABELS,
} from "@/lib/artifacts/node-display";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ARTIFACT_SORT_FIELDS,
  CHAT_SORT_FIELDS,
  DEFAULT_SORT_MODE,
  SORT_DIRECTION,
  SORT_FIELD_LABELS,
  type SortField,
  type SortMode,
} from "@/lib/epic-sort";
import { STATUS_DOT_CLASSES, STATUS_LABELS } from "./epic-sidebar-tree-shared";
import {
  ARTIFACT_READ,
  ARTIFACT_STATUS,
  artifactFilterCount,
  CHAT_ARCHIVE_VISIBILITY,
  CHAT_ORIGIN,
  DEFAULT_CHAT_ARCHIVE_VISIBILITY,
  isArtifactFilterActive,
  isChatFilterActive,
  isSortModeActive,
  useArtifactFilter,
  useArtifactSort,
  useChatArchiveVisibility,
  useChatFilter,
  useChatSort,
  useLeftPanelStore,
  type ArtifactReadFilter,
  type ArtifactStatusFilter,
  type ChatArchiveVisibility,
  type ChatOriginFilter,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";
import {
  usePanelHeaderMenuOpen,
  usePanelHeaderMenuStore,
} from "@/stores/epics/panel-header-menu-store";

const TWO_COLUMN_MENU_MIN_AVAILABLE_PX = 520;
const VIEW_MENU_CONTENT_CLASS =
  "w-[var(--radix-dropdown-menu-content-available-width)] min-w-0 max-w-64 overflow-y-auto";
const VIEW_MENU_MAX_HEIGHT = "min(70vh, 28rem)";

type ChatViewDetail = "ordering" | "show" | "interface";
type ArtifactViewDetail = "ordering" | "status" | "type" | "read";

const CHAT_DETAIL_LABELS: Readonly<Record<ChatViewDetail, string>> = {
  ordering: "Ordering",
  show: "Show",
  interface: "Interface",
};

const ARTIFACT_DETAIL_LABELS: Readonly<Record<ArtifactViewDetail, string>> = {
  ordering: "Ordering",
  status: "Status",
  type: "Type",
  read: "Read state",
};

const CHAT_ORIGIN_OPTIONS: ReadonlyArray<{
  readonly value: ChatOriginFilter;
  readonly label: string;
}> = [
  { value: CHAT_ORIGIN.All, label: "All" },
  { value: CHAT_ORIGIN.Gui, label: "Chat" },
  { value: CHAT_ORIGIN.Tui, label: "Terminal" },
];

const CHAT_ARCHIVE_VISIBILITY_OPTIONS: ReadonlyArray<{
  readonly value: ChatArchiveVisibility;
  readonly label: string;
}> = [
  {
    value: CHAT_ARCHIVE_VISIBILITY.Unarchived,
    label: "Unarchived only",
  },
  { value: CHAT_ARCHIVE_VISIBILITY.Archived, label: "Archived only" },
  { value: CHAT_ARCHIVE_VISIBILITY.All, label: "All chats" },
];

function archiveVisibilityLabel(visibility: ChatArchiveVisibility): string {
  return (
    CHAT_ARCHIVE_VISIBILITY_OPTIONS.find(
      (option) => option.value === visibility,
    )?.label ?? "Unarchived only"
  );
}

const ARTIFACT_STATUS_OPTIONS: ReadonlyArray<ArtifactStatusFilter> = [
  ARTIFACT_STATUS.Todo,
  ARTIFACT_STATUS.InProgress,
  ARTIFACT_STATUS.Done,
];

const ARTIFACT_KIND_OPTIONS: ReadonlyArray<EpicArtifactKind> = [
  "spec",
  "ticket",
  "story",
  "review",
];

const ARTIFACT_READ_OPTIONS: ReadonlyArray<{
  readonly value: ArtifactReadFilter;
  readonly label: string;
}> = [
  { value: ARTIFACT_READ.All, label: "All" },
  { value: ARTIFACT_READ.Unread, label: "Unread" },
  { value: ARTIFACT_READ.Read, label: "Read" },
];

interface ViewMenuState<TDetail extends string> {
  readonly open: boolean;
  readonly drillIn: boolean;
  readonly detail: TDetail | null;
  readonly setTriggerElement: (element: HTMLButtonElement | null) => void;
  readonly handleOpenChange: (open: boolean) => void;
  readonly openDetail: (detail: TDetail) => void;
  readonly closeDetail: () => void;
}

function useViewMenuState<TDetail extends string>(
  tabId: string,
  panelId: LeftPanelId,
  collapsed: boolean,
): ViewMenuState<TDetail> {
  const open = usePanelHeaderMenuOpen(tabId, panelId, "filter");
  const setMenuOpen = usePanelHeaderMenuStore((state) => state.setMenuOpen);
  const [drillIn, setDrillIn] = useState(false);
  const [detail, setDetail] = useState<TDetail | null>(null);
  const [triggerElement, setTriggerElement] =
    useState<HTMLButtonElement | null>(null);
  const setPanelSectionCollapsed = useLeftPanelStore(
    (state) => state.setPanelSectionCollapsed,
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        if (collapsed) setPanelSectionCollapsed(panelId, false);
        const triggerRight = triggerElement?.getBoundingClientRect().right ?? 0;
        setDrillIn(
          window.innerWidth - triggerRight < TWO_COLUMN_MENU_MIN_AVAILABLE_PX,
        );
      } else {
        setDetail(null);
      }
      setMenuOpen(tabId, panelId, "filter", nextOpen);
    },
    [
      collapsed,
      panelId,
      setMenuOpen,
      setPanelSectionCollapsed,
      tabId,
      triggerElement,
    ],
  );

  const openDetail = useCallback((nextDetail: TDetail) => {
    setDetail(nextDetail);
  }, []);
  const closeDetail = useCallback(() => setDetail(null), []);

  return {
    open,
    drillIn,
    detail,
    setTriggerElement,
    handleOpenChange,
    openDetail,
    closeDetail,
  };
}

function ViewMenuTrigger(props: {
  readonly filterCount: number;
  readonly label: string;
  readonly setTriggerElement: (element: HTMLButtonElement | null) => void;
}) {
  const { filterCount, label, setTriggerElement } = props;
  const badge = filterCount > 9 ? "9+" : String(filterCount);
  return (
    <TooltipWrapper
      label={label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={setTriggerElement}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className="relative shrink-0 text-muted-foreground transition-colors hover:text-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground"
        >
          <ListFilter className="size-4" />
          {filterCount > 0 ? (
            <span
              aria-hidden
              className="pointer-events-none absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground px-0.5 text-[9px] leading-none font-semibold text-background ring-1 ring-background"
            >
              {badge}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
    </TooltipWrapper>
  );
}

function viewTriggerLabel(args: {
  readonly base: string;
  readonly filterCount: number;
  readonly sort: SortMode;
  readonly showChanged: boolean;
}): string {
  const details: string[] = [];
  if (args.filterCount > 0) {
    details.push(
      `${args.filterCount} ${args.filterCount === 1 ? "filter" : "filters"} active`,
    );
  }
  if (isSortModeActive(args.sort)) {
    details.push(`ordered by ${SORT_FIELD_LABELS[args.sort.field]}`);
  }
  if (args.showChanged) details.push("visibility changed");
  return details.length === 0
    ? args.base
    : `${args.base}, ${details.join(", ")}`;
}

function ViewDetailEntry<TDetail extends string>(props: {
  readonly detail: TDetail;
  readonly drillIn: boolean;
  readonly label: string;
  readonly summary: string;
  readonly onOpenDetail: (detail: TDetail) => void;
  readonly children: ReactNode;
}) {
  const [subOpen, setSubOpen] = useState(false);
  if (props.drillIn) {
    return (
      <DropdownMenuItem
        className="grid grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-1.5"
        onSelect={(event) => {
          event.preventDefault();
          props.onOpenDetail(props.detail);
        }}
      >
        <span className="min-w-0 truncate">{props.label}</span>
        <span className="min-w-0 truncate text-right text-ui-xs text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground">
          {props.summary}
        </span>
        <ChevronRight className="size-3.5 justify-self-end" />
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuSub open={subOpen} onOpenChange={setSubOpen}>
      <DropdownMenuSubTrigger
        className="grid grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-1.5 [&>svg:last-child]:ml-0 [&>svg:last-child]:justify-self-end"
        onClick={() => setSubOpen(true)}
      >
        <span className="min-w-0 truncate">{props.label}</span>
        <span className="min-w-0 truncate text-right text-ui-xs text-muted-foreground group-data-open:text-accent-foreground">
          {props.summary}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={8}
        alignOffset={-4}
        avoidCollisions={false}
        className="min-w-52"
      >
        {props.children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function DrillInHeader(props: {
  readonly title: string;
  readonly onBack: () => void;
}) {
  return (
    <>
      <DropdownMenuItem
        className="font-medium"
        onSelect={(event) => {
          event.preventDefault();
          props.onBack();
        }}
      >
        <ChevronLeft className="size-4" />
        Back
        <DropdownMenuShortcut>{props.title}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

function OrderingDetail(props: {
  readonly fields: ReadonlyArray<SortField>;
  readonly sort: SortMode;
  readonly onFieldChange: (field: SortField) => void;
  readonly onToggleDirection: () => void;
}) {
  const resetOrdering = (): void => {
    props.onFieldChange(DEFAULT_SORT_MODE.field);
    if (props.sort.direction !== DEFAULT_SORT_MODE.direction) {
      props.onToggleDirection();
    }
  };
  return (
    <>
      <DropdownMenuLabel>Order by</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={props.sort.field}
        onValueChange={(next) => {
          const match = props.fields.find((field) => field === next);
          if (match !== undefined) props.onFieldChange(match);
        }}
      >
        {props.fields.map((field) => (
          <DropdownMenuRadioItem
            key={field}
            value={field}
            onSelect={(event) => event.preventDefault()}
          >
            {SORT_FIELD_LABELS[field]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup value={props.sort.direction}>
        <DropdownMenuRadioItem
          value={SORT_DIRECTION.Desc}
          onSelect={(event) => {
            event.preventDefault();
            if (props.sort.direction !== SORT_DIRECTION.Desc) {
              props.onToggleDirection();
            }
          }}
        >
          <ArrowDownWideNarrow className="size-4" />
          Descending
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          value={SORT_DIRECTION.Asc}
          onSelect={(event) => {
            event.preventDefault();
            if (props.sort.direction !== SORT_DIRECTION.Asc) {
              props.onToggleDirection();
            }
          }}
        >
          <ArrowUpNarrowWide className="size-4" />
          Ascending
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      {isSortModeActive(props.sort) ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              resetOrdering();
            }}
          >
            <RotateCcw className="size-4" />
            Reset ordering
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

function sortSummary(sort: SortMode): string {
  return `${SORT_FIELD_LABELS[sort.field]} ${
    sort.direction === SORT_DIRECTION.Asc ? "↑" : "↓"
  }`;
}

function selectedSummary(labels: readonly string[]): string {
  if (labels.length === 0) return "All";
  if (labels.length === 1) return labels[0];
  return `${labels.length} selected`;
}

function ChatDetailContent(props: {
  readonly detail: ChatViewDetail;
  readonly filterOrigin: ChatOriginFilter;
  readonly sort: SortMode;
  readonly archiveVisibility: ChatArchiveVisibility;
  readonly setChatOrigin: (origin: ChatOriginFilter) => void;
  readonly setArchiveVisibility: (visibility: ChatArchiveVisibility) => void;
  readonly setSortField: (field: SortField) => void;
  readonly toggleSortDirection: () => void;
}) {
  switch (props.detail) {
    case "ordering":
      return (
        <OrderingDetail
          fields={CHAT_SORT_FIELDS}
          sort={props.sort}
          onFieldChange={props.setSortField}
          onToggleDirection={props.toggleSortDirection}
        />
      );
    case "show":
      return (
        <DropdownMenuRadioGroup
          value={props.archiveVisibility}
          onValueChange={(next) => {
            const match = CHAT_ARCHIVE_VISIBILITY_OPTIONS.find(
              (option) => option.value === next,
            );
            if (match !== undefined) {
              props.setArchiveVisibility(match.value);
            }
          }}
          data-testid="epic-sidebar-archive-visibility"
        >
          {CHAT_ARCHIVE_VISIBILITY_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              onSelect={(event) => event.preventDefault()}
              data-testid={`epic-sidebar-archive-visibility-${option.value}`}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      );
    case "interface":
      return (
        <DropdownMenuRadioGroup
          value={props.filterOrigin}
          onValueChange={(next) => {
            const match = CHAT_ORIGIN_OPTIONS.find(
              (option) => option.value === next,
            );
            if (match !== undefined) props.setChatOrigin(match.value);
          }}
        >
          {CHAT_ORIGIN_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              onSelect={(event) => event.preventDefault()}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      );
  }
}

export function ChatFilterMenu(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly collapsed: boolean;
  readonly canArchive: boolean;
  readonly onCollapseAll: () => void;
}) {
  const { epicId } = props;
  const filter = useChatFilter(epicId);
  const sort = useChatSort(epicId);
  const archiveVisibility = useChatArchiveVisibility(epicId);
  const setChatOrigin = useLeftPanelStore((state) => state.setChatOrigin);
  const setChatArchiveVisibility = useLeftPanelStore(
    (state) => state.setChatArchiveVisibility,
  );
  const setChatSortField = useLeftPanelStore((state) => state.setChatSortField);
  const toggleChatSortDirection = useLeftPanelStore(
    (state) => state.toggleChatSortDirection,
  );
  const resetChatView = useLeftPanelStore((state) => state.resetChatView);
  const filterActive = isChatFilterActive(filter);
  const filterCount = filterActive ? 1 : 0;
  const archiveVisibilityChanged =
    archiveVisibility !== DEFAULT_CHAT_ARCHIVE_VISIBILITY;
  const active =
    filterActive || archiveVisibilityChanged || isSortModeActive(sort);
  const menu = useViewMenuState<ChatViewDetail>(
    props.tabId,
    "chats",
    props.collapsed,
  );

  const detailProps = {
    filterOrigin: filter.origin,
    sort,
    archiveVisibility,
    setChatOrigin: (origin: ChatOriginFilter) => setChatOrigin(epicId, origin),
    setArchiveVisibility: (visibility: ChatArchiveVisibility) =>
      setChatArchiveVisibility(epicId, visibility),
    setSortField: (field: SortField) => setChatSortField(epicId, field),
    toggleSortDirection: () => toggleChatSortDirection(epicId),
  };
  const currentInterface =
    CHAT_ORIGIN_OPTIONS.find((option) => option.value === filter.origin)
      ?.label ?? "All";
  const triggerLabel = viewTriggerLabel({
    base: "Filter agents",
    filterCount,
    sort,
    showChanged: archiveVisibilityChanged,
  });

  return (
    <DropdownMenu open={menu.open} onOpenChange={menu.handleOpenChange}>
      <ViewMenuTrigger
        filterCount={filterCount}
        label={triggerLabel}
        setTriggerElement={menu.setTriggerElement}
      />
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        avoidCollisions={false}
        className={VIEW_MENU_CONTENT_CLASS}
        style={{ maxHeight: VIEW_MENU_MAX_HEIGHT }}
        data-testid="epic-sidebar-agent-view-menu"
      >
        {menu.drillIn && menu.detail !== null ? (
          <>
            <DrillInHeader
              title={CHAT_DETAIL_LABELS[menu.detail]}
              onBack={menu.closeDetail}
            />
            <ChatDetailContent detail={menu.detail} {...detailProps} />
          </>
        ) : (
          <>
            <ViewDetailEntry
              detail="ordering"
              drillIn={menu.drillIn}
              label="Ordering"
              summary={sortSummary(sort)}
              onOpenDetail={menu.openDetail}
            >
              <ChatDetailContent detail="ordering" {...detailProps} />
            </ViewDetailEntry>
            {props.canArchive ? (
              <ViewDetailEntry
                detail="show"
                drillIn={menu.drillIn}
                label="Show"
                summary={archiveVisibilityLabel(archiveVisibility)}
                onOpenDetail={menu.openDetail}
              >
                <ChatDetailContent detail="show" {...detailProps} />
              </ViewDetailEntry>
            ) : null}
            <DropdownMenuLabel className="mt-1 text-overline uppercase tracking-wide">
              Filters
            </DropdownMenuLabel>
            <ViewDetailEntry
              detail="interface"
              drillIn={menu.drillIn}
              label="Interface"
              summary={currentInterface}
              onOpenDetail={menu.openDetail}
            >
              <ChatDetailContent detail="interface" {...detailProps} />
            </ViewDetailEntry>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={props.onCollapseAll}>
              <CopyMinus className="size-4" />
              Collapse all
            </DropdownMenuItem>
            {active ? (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  resetChatView(epicId);
                }}
              >
                <RotateCcw className="size-4" />
                Reset view
              </DropdownMenuItem>
            ) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArtifactDetailContent(props: {
  readonly detail: ArtifactViewDetail;
  readonly filterStatuses: readonly ArtifactStatusFilter[];
  readonly filterKinds: readonly EpicArtifactKind[];
  readonly filterRead: ArtifactReadFilter;
  readonly sort: SortMode;
  readonly toggleStatus: (status: ArtifactStatusFilter) => void;
  readonly toggleKind: (kind: EpicArtifactKind) => void;
  readonly setRead: (read: ArtifactReadFilter) => void;
  readonly setSortField: (field: SortField) => void;
  readonly toggleSortDirection: () => void;
}) {
  switch (props.detail) {
    case "ordering":
      return (
        <OrderingDetail
          fields={ARTIFACT_SORT_FIELDS}
          sort={props.sort}
          onFieldChange={props.setSortField}
          onToggleDirection={props.toggleSortDirection}
        />
      );
    case "status":
      return (
        <>
          {ARTIFACT_STATUS_OPTIONS.map((status) => (
            <DropdownMenuCheckboxItem
              key={status}
              checked={props.filterStatuses.includes(status)}
              onCheckedChange={() => props.toggleStatus(status)}
              onSelect={(event) => event.preventDefault()}
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  STATUS_DOT_CLASSES[status],
                )}
              />
              {STATUS_LABELS[status]}
            </DropdownMenuCheckboxItem>
          ))}
        </>
      );
    case "type":
      return (
        <ArtifactTypeDetail
          filterKinds={props.filterKinds}
          toggleKind={props.toggleKind}
        />
      );
    case "read":
      return (
        <DropdownMenuRadioGroup
          value={props.filterRead}
          onValueChange={(next) => {
            const match = ARTIFACT_READ_OPTIONS.find(
              (option) => option.value === next,
            );
            if (match !== undefined) props.setRead(match.value);
          }}
        >
          {ARTIFACT_READ_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              onSelect={(event) => event.preventDefault()}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      );
  }
}

function ArtifactTypeDetail(props: {
  readonly filterKinds: readonly EpicArtifactKind[];
  readonly toggleKind: (kind: EpicArtifactKind) => void;
}) {
  const artifactIconColors = useSettingsStore(
    (state) => state.artifactIconColors,
  );
  const artifactIconColorMode = useSettingsStore(
    (state) => state.artifactIconColorMode,
  );

  return ARTIFACT_KIND_OPTIONS.map((kind) => {
    const TypeIcon = EPIC_NODE_ICONS[kind];
    const iconStyle =
      artifactIconColorMode === "byType"
        ? { color: artifactIconColors[kind] }
        : undefined;
    return (
      <DropdownMenuCheckboxItem
        key={kind}
        checked={props.filterKinds.includes(kind)}
        onCheckedChange={() => props.toggleKind(kind)}
        onSelect={(event) => event.preventDefault()}
      >
        <TypeIcon
          className={cn(
            "size-3.5",
            artifactIconColorMode === "none" && "text-muted-foreground",
          )}
          style={iconStyle}
        />
        {EPIC_NODE_LABELS[kind]}
      </DropdownMenuCheckboxItem>
    );
  });
}

export function ArtifactFilterMenu(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly collapsed: boolean;
  readonly onCollapseAll: () => void;
  readonly onMarkAllRead: () => void;
  readonly markAllReadDisabled: boolean;
}) {
  const { epicId } = props;
  const filter = useArtifactFilter(epicId);
  const sort = useArtifactSort(epicId);
  const toggleArtifactStatus = useLeftPanelStore(
    (state) => state.toggleArtifactStatus,
  );
  const toggleArtifactKind = useLeftPanelStore(
    (state) => state.toggleArtifactKind,
  );
  const setArtifactRead = useLeftPanelStore((state) => state.setArtifactRead);
  const setArtifactSortField = useLeftPanelStore(
    (state) => state.setArtifactSortField,
  );
  const toggleArtifactSortDirection = useLeftPanelStore(
    (state) => state.toggleArtifactSortDirection,
  );
  const resetArtifactView = useLeftPanelStore(
    (state) => state.resetArtifactView,
  );
  const filterActive = isArtifactFilterActive(filter);
  const filterCount = artifactFilterCount(filter);
  const active = filterActive || isSortModeActive(sort);
  const menu = useViewMenuState<ArtifactViewDetail>(
    props.tabId,
    "artifacts",
    props.collapsed,
  );

  const detailProps = {
    filterStatuses: filter.statuses,
    filterKinds: filter.kinds,
    filterRead: filter.read,
    sort,
    toggleStatus: (status: ArtifactStatusFilter) =>
      toggleArtifactStatus(epicId, status),
    toggleKind: (kind: EpicArtifactKind) => toggleArtifactKind(epicId, kind),
    setRead: (read: ArtifactReadFilter) => setArtifactRead(epicId, read),
    setSortField: (field: SortField) => setArtifactSortField(epicId, field),
    toggleSortDirection: () => toggleArtifactSortDirection(epicId),
  };
  const statusSummary = selectedSummary(
    filter.statuses.map((status) => STATUS_LABELS[status]),
  );
  const kindSummary = selectedSummary(
    filter.kinds.map((kind) => EPIC_NODE_LABELS[kind]),
  );
  const readSummary =
    ARTIFACT_READ_OPTIONS.find((option) => option.value === filter.read)
      ?.label ?? "All";
  const triggerLabel = viewTriggerLabel({
    base: "Filter artifacts",
    filterCount,
    sort,
    showChanged: false,
  });

  return (
    <DropdownMenu open={menu.open} onOpenChange={menu.handleOpenChange}>
      <ViewMenuTrigger
        filterCount={filterCount}
        label={triggerLabel}
        setTriggerElement={menu.setTriggerElement}
      />
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        avoidCollisions={false}
        className={VIEW_MENU_CONTENT_CLASS}
        style={{ maxHeight: VIEW_MENU_MAX_HEIGHT }}
        data-testid="epic-sidebar-artifact-view-menu"
      >
        {menu.drillIn && menu.detail !== null ? (
          <>
            <DrillInHeader
              title={ARTIFACT_DETAIL_LABELS[menu.detail]}
              onBack={menu.closeDetail}
            />
            <ArtifactDetailContent detail={menu.detail} {...detailProps} />
          </>
        ) : (
          <>
            <ViewDetailEntry
              detail="ordering"
              drillIn={menu.drillIn}
              label="Ordering"
              summary={sortSummary(sort)}
              onOpenDetail={menu.openDetail}
            >
              <ArtifactDetailContent detail="ordering" {...detailProps} />
            </ViewDetailEntry>
            <DropdownMenuLabel className="mt-1 text-overline uppercase tracking-wide">
              Filters
            </DropdownMenuLabel>
            <ViewDetailEntry
              detail="status"
              drillIn={menu.drillIn}
              label="Status"
              summary={statusSummary}
              onOpenDetail={menu.openDetail}
            >
              <ArtifactDetailContent detail="status" {...detailProps} />
            </ViewDetailEntry>
            <ViewDetailEntry
              detail="type"
              drillIn={menu.drillIn}
              label="Type"
              summary={kindSummary}
              onOpenDetail={menu.openDetail}
            >
              <ArtifactDetailContent detail="type" {...detailProps} />
            </ViewDetailEntry>
            <ViewDetailEntry
              detail="read"
              drillIn={menu.drillIn}
              label="Read state"
              summary={readSummary}
              onOpenDetail={menu.openDetail}
            >
              <ArtifactDetailContent detail="read" {...detailProps} />
            </ViewDetailEntry>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={props.onCollapseAll}>
              <CopyMinus className="size-4" />
              Collapse all
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={props.markAllReadDisabled}
              onSelect={props.onMarkAllRead}
            >
              Mark all as read
            </DropdownMenuItem>
            {active ? (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  resetArtifactView(epicId);
                }}
              >
                <RotateCcw className="size-4" />
                Reset view
              </DropdownMenuItem>
            ) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
