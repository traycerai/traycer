import { ListFilter, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArtifactDetailContent,
  ChatInterfaceDetail,
  OrderingDetail,
  ViewMenuBadge,
} from "@/components/epic-canvas/sidebar/epic-sidebar-view-menu-details";
import {
  ARTIFACT_DETAIL_LABELS,
  CHAT_DETAIL_LABELS,
  viewTriggerLabel,
} from "@/components/epic-canvas/sidebar/epic-sidebar-view-menu-shared";
import { CHAT_SORT_FIELDS, type SortField } from "@/lib/epic-sort";
import {
  artifactFilterCount,
  chatFilterCount,
  isArtifactFilterActive,
  isSortModeActive,
  useArtifactFilter,
  useArtifactSort,
  useChatFilter,
  useChatSort,
  useLeftPanelStore,
  type ArtifactReadFilter,
  type ArtifactStatusFilter,
} from "@/stores/epics/left-panel-store";

/**
 * The switcher's view menu is capped well below the desktop sidebar's, because
 * it opens inside a 70dvh bottom sheet rather than over the full window: a menu
 * sized against the VIEWPORT would overhang the sheet that anchors it and read
 * as a detached overlay. Scrolling inside the menu is the intended outcome for
 * a long facet list on a phone.
 */
const SWITCHER_VIEW_MENU_MAX_HEIGHT = "min(50dvh, 20rem)";

/**
 * Trigger + content shell for a switcher category's view menu.
 *
 * Deliberately flat: the desktop sidebar reaches each facet through a Radix
 * submenu, or drills into it with a Back row when the rail is too narrow for
 * two columns, because a rail has no room to show them all at once. A phone
 * menu does - it scrolls - so the facets are listed one after another and the
 * whole drill-in controller (and the viewport-width rule behind it) has no
 * mobile counterpart to port. The facet bodies themselves are desktop's own.
 */
function SwitcherViewMenuShell(props: {
  readonly label: string;
  readonly filterCount: number;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={props.label}
          data-testid={props.testId}
          className="relative text-muted-foreground hover:text-foreground"
        >
          <ListFilter className="size-4" />
          <ViewMenuBadge filterCount={props.filterCount} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-w-64 min-w-52 overflow-y-auto"
        style={{ maxHeight: SWITCHER_VIEW_MENU_MAX_HEIGHT }}
        data-testid={`${props.testId}-content`}
      >
        {props.children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A facet's heading in the flat menu. The sidebar puts this text on the row you
 * open the facet FROM; with the facets inlined there is no such row, so the
 * label has to introduce the group instead - otherwise three radio groups run
 * together with nothing saying which axis each one is.
 */
function SwitcherFacetLabel(props: { readonly children: ReactNode }) {
  return (
    <DropdownMenuLabel className="text-overline uppercase tracking-wide">
      {props.children}
    </DropdownMenuLabel>
  );
}

/**
 * View menu for the Agents category, reading and writing the same per-epic chat
 * filter and sort the desktop sidebar does - so a narrowing picked on a phone
 * is the narrowing the sidebar shows, and neither surface owns a private copy.
 *
 * Carries Ordering and Interface. The sidebar's other two Agents facets are
 * absent, each for a reason that is about this surface rather than about the
 * facet:
 *
 * - **Ownership** sorts local agents from collaborators'. Every LOCAL agent is
 *   the viewer's own - a collaborator's arrives as a cloud row - and this list
 *   renders local records only. So "Mine" would select exactly what "All" does
 *   and "Others" would empty the list every time, on every epic. The control
 *   is only meaningful once cloud rows reach this surface.
 * - **Show** (archive visibility) needs more than the visibility flag to be
 *   correct: the sidebar pairs it with a reveal rule that keeps an archived
 *   agent visible while it is open, working, or unread. Shipping the control
 *   without that rule would silently hide agents the sidebar shows.
 *
 * "Reset view" is absent because it clears archive visibility too, so here it
 * would reset a facet the user cannot see.
 *
 * Both still APPLY when set from the sidebar - they are the same per-epic
 * store keys, and this list narrows through the same match set - so a phone
 * showing nothing under a desktop-set Ownership filter says so in its empty
 * state rather than pretending the epic is empty.
 */
export function SwitcherAgentsViewMenu(props: { readonly epicId: string }) {
  const { epicId } = props;
  const filter = useChatFilter(epicId);
  const sort = useChatSort(epicId);
  const setChatOrigin = useLeftPanelStore((state) => state.setChatOrigin);
  const setChatSortField = useLeftPanelStore((state) => state.setChatSortField);
  const toggleChatSortDirection = useLeftPanelStore(
    (state) => state.toggleChatSortDirection,
  );
  const filterCount = chatFilterCount(filter);
  return (
    <SwitcherViewMenuShell
      label={viewTriggerLabel({
        base: "Filter agents",
        filterCount,
        sort,
        showChanged: false,
      })}
      filterCount={filterCount}
      testId="switcher-agents-view-menu"
    >
      <OrderingDetail
        fields={CHAT_SORT_FIELDS}
        sort={sort}
        onFieldChange={(field) => setChatSortField(epicId, field)}
        onToggleDirection={() => toggleChatSortDirection(epicId)}
      />
      <DropdownMenuSeparator />
      <SwitcherFacetLabel>{CHAT_DETAIL_LABELS.interface}</SwitcherFacetLabel>
      <ChatInterfaceDetail
        filterOrigin={filter.origin}
        setChatOrigin={(origin) => setChatOrigin(epicId, origin)}
      />
    </SwitcherViewMenuShell>
  );
}

/**
 * View menu for the Artifacts category. Every sidebar facet is present here -
 * Ordering, Status, Type and Read state are all plain predicates over artifacts
 * this surface already holds - so this menu also carries the sidebar's "Reset
 * view".
 */
export function SwitcherArtifactsViewMenu(props: { readonly epicId: string }) {
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
  const filterCount = artifactFilterCount(filter);
  const active = isArtifactFilterActive(filter) || isSortModeActive(sort);
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
  return (
    <SwitcherViewMenuShell
      label={viewTriggerLabel({
        base: "Filter artifacts",
        filterCount,
        sort,
        showChanged: false,
      })}
      filterCount={filterCount}
      testId="switcher-artifacts-view-menu"
    >
      <ArtifactDetailContent detail="ordering" {...detailProps} />
      <DropdownMenuSeparator />
      <SwitcherFacetLabel>{ARTIFACT_DETAIL_LABELS.status}</SwitcherFacetLabel>
      <ArtifactDetailContent detail="status" {...detailProps} />
      <DropdownMenuSeparator />
      <SwitcherFacetLabel>{ARTIFACT_DETAIL_LABELS.type}</SwitcherFacetLabel>
      <ArtifactDetailContent detail="type" {...detailProps} />
      <DropdownMenuSeparator />
      <SwitcherFacetLabel>{ARTIFACT_DETAIL_LABELS.read}</SwitcherFacetLabel>
      <ArtifactDetailContent detail="read" {...detailProps} />
      {active ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="switcher-artifacts-reset-view"
            onSelect={(event) => {
              event.preventDefault();
              resetArtifactView(epicId);
            }}
          >
            <RotateCcw className="size-4" />
            Reset view
          </DropdownMenuItem>
        </>
      ) : null}
    </SwitcherViewMenuShell>
  );
}
