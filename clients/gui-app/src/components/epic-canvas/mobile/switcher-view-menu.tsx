import { ListFilter } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  OrderingDetail,
  ViewMenuBadge,
} from "@/components/epic-canvas/sidebar/epic-sidebar-view-menu-details";
import { viewTriggerLabel } from "@/components/epic-canvas/sidebar/epic-sidebar-view-menu-shared";
import { ARTIFACT_SORT_FIELDS, CHAT_SORT_FIELDS } from "@/lib/epic-sort";
import {
  useArtifactSort,
  useChatSort,
  useLeftPanelStore,
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
 * View menu for the Agents category, reading and writing the same per-epic
 * chat sort the desktop sidebar does - so an ordering picked on a phone is the
 * ordering the sidebar shows, and neither surface owns a private copy.
 */
export function SwitcherAgentsViewMenu(props: { readonly epicId: string }) {
  const { epicId } = props;
  const sort = useChatSort(epicId);
  const setChatSortField = useLeftPanelStore((state) => state.setChatSortField);
  const toggleChatSortDirection = useLeftPanelStore(
    (state) => state.toggleChatSortDirection,
  );
  return (
    <SwitcherViewMenuShell
      label={viewTriggerLabel({
        base: "Filter agents",
        filterCount: 0,
        sort,
        showChanged: false,
      })}
      filterCount={0}
      testId="switcher-agents-view-menu"
    >
      <OrderingDetail
        fields={CHAT_SORT_FIELDS}
        sort={sort}
        onFieldChange={(field) => setChatSortField(epicId, field)}
        onToggleDirection={() => toggleChatSortDirection(epicId)}
      />
    </SwitcherViewMenuShell>
  );
}

/** View menu for the Artifacts category. Same store, same shared bodies. */
export function SwitcherArtifactsViewMenu(props: { readonly epicId: string }) {
  const { epicId } = props;
  const sort = useArtifactSort(epicId);
  const setArtifactSortField = useLeftPanelStore(
    (state) => state.setArtifactSortField,
  );
  const toggleArtifactSortDirection = useLeftPanelStore(
    (state) => state.toggleArtifactSortDirection,
  );
  return (
    <SwitcherViewMenuShell
      label={viewTriggerLabel({
        base: "Filter artifacts",
        filterCount: 0,
        sort,
        showChanged: false,
      })}
      filterCount={0}
      testId="switcher-artifacts-view-menu"
    >
      <OrderingDetail
        fields={ARTIFACT_SORT_FIELDS}
        sort={sort}
        onFieldChange={(field) => setArtifactSortField(epicId, field)}
        onToggleDirection={() => toggleArtifactSortDirection(epicId)}
      />
    </SwitcherViewMenuShell>
  );
}
