/**
 * Stable, nested view menus for the Agents and Artifacts section headers.
 *
 * The trigger is always visible and always last in its header action cluster.
 * Root rows summarize the current view; supported details open to the right via
 * Radix submenus. When there is not enough room for two menu columns, the same
 * root drills into a detail page with Back instead of flipping left.
 */
import { ChevronLeft, ChevronRight, ListFilter, RotateCcw } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { EPIC_NODE_LABELS } from "@/lib/artifacts/node-display";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SortField } from "@/lib/epic-sort";
import { STATUS_LABELS } from "./epic-sidebar-tree-shared";
import {
  ArtifactDetailContent,
  ChatDetailContent,
  ViewMenuBadge,
} from "./epic-sidebar-view-menu-details";
import {
  ARTIFACT_DETAIL_LABELS,
  ARTIFACT_READ_OPTIONS,
  archiveVisibilityLabel,
  CHAT_DETAIL_LABELS,
  CHAT_ORIGIN_OPTIONS,
  CHAT_OWNERSHIP_OPTIONS,
  selectedSummary,
  sortSummary,
  viewTriggerLabel,
  type ArtifactViewDetail,
  type ChatViewDetail,
} from "./epic-sidebar-view-menu-shared";
import {
  artifactFilterCount,
  chatFilterCount,
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
  type ChatOwnershipFilter,
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
          <ViewMenuBadge filterCount={filterCount} />
        </Button>
      </DropdownMenuTrigger>
    </TooltipWrapper>
  );
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

export function ChatFilterMenu(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly collapsed: boolean;
  readonly canArchive: boolean;
}) {
  const { epicId } = props;
  const filter = useChatFilter(epicId);
  const sort = useChatSort(epicId);
  const archiveVisibility = useChatArchiveVisibility(epicId);
  const setChatOrigin = useLeftPanelStore((state) => state.setChatOrigin);
  const setChatOwnership = useLeftPanelStore((state) => state.setChatOwnership);
  const setChatArchiveVisibility = useLeftPanelStore(
    (state) => state.setChatArchiveVisibility,
  );
  const setChatSortField = useLeftPanelStore((state) => state.setChatSortField);
  const toggleChatSortDirection = useLeftPanelStore(
    (state) => state.toggleChatSortDirection,
  );
  const resetChatView = useLeftPanelStore((state) => state.resetChatView);
  const filterActive = isChatFilterActive(filter);
  const filterCount = chatFilterCount(filter);
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
    filterOwnership: filter.ownership,
    sort,
    archiveVisibility,
    setChatOrigin: (origin: ChatOriginFilter) => setChatOrigin(epicId, origin),
    setChatOwnership: (ownership: ChatOwnershipFilter) =>
      setChatOwnership(epicId, ownership),
    setArchiveVisibility: (visibility: ChatArchiveVisibility) =>
      setChatArchiveVisibility(epicId, visibility),
    setSortField: (field: SortField) => setChatSortField(epicId, field),
    toggleSortDirection: () => toggleChatSortDirection(epicId),
  };
  const currentInterface =
    CHAT_ORIGIN_OPTIONS.find((option) => option.value === filter.origin)
      ?.label ?? "All";
  const currentOwnership =
    CHAT_OWNERSHIP_OPTIONS.find((option) => option.value === filter.ownership)
      ?.label ?? "All";
  const triggerLabel = viewTriggerLabel({
    base: "Filter agents",
    filterCount,
    sort,
    // Gated on `canArchive` alongside the Show detail itself: a stored
    // preference outlives the permission that set it, and announcing a setting
    // the menu can no longer expose names something the user cannot go change.
    visibilityLabel:
      props.canArchive && archiveVisibilityChanged
        ? archiveVisibilityLabel(archiveVisibility)
        : null,
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
            <ViewDetailEntry
              detail="ownership"
              drillIn={menu.drillIn}
              label="Ownership"
              summary={currentOwnership}
              onOpenDetail={menu.openDetail}
            >
              <ChatDetailContent detail="ownership" {...detailProps} />
            </ViewDetailEntry>
            {active ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    resetChatView(epicId);
                  }}
                >
                  <RotateCcw className="size-4" />
                  Reset view
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ArtifactFilterMenu(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly collapsed: boolean;
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
    // The artifacts panel has no archive-visibility control.
    visibilityLabel: null,
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
