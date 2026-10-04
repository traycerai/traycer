import { useLayoutUsage } from "@/components/layout-editor/inspector/use-layout-usage";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { NoLayoutUsageProviders } from "@/components/layout-editor/inspector/provider-limit-windows";
import type { LayoutFormContext } from "@/components/layout-editor/regions/row-availability";
import { useState, type ReactNode } from "react";
import { ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import { SortableList } from "@/components/layout-editor/inspector/sortable-list";
import { useLayoutFormHost } from "@/components/layout-editor/inspector/layout-form-host";
import { useSortableRowPadding } from "@/components/layout-editor/inspector/sortable-row-padding";
import { assertNever } from "@/components/layout-editor/inspector/rows/assert-never";
import {
  dividerOrderItem,
  providerOrderItems,
  railPanelOrderItem,
  regionRowItems,
  stackOrderItem,
  type SortableRowDecorator,
} from "@/components/layout-editor/inspector/rows/order-row-items";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import {
  ORDER_GROUPS,
  orderGroupHeaded,
  orderGroupInstruction,
  orderGroupListLabel,
  PHONE_RAIL_INSTRUCTION,
  toolbarMembers,
} from "@/components/layout-editor/regions/surface-groups";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  insertRailDivider,
  movedWithin,
  moveRailEntry,
  movePanelAmongPanels,
  type LayoutArrangement,
  type OrderGroupId,
} from "@/lib/layout/layout-arrangement";
import type { LayoutValues } from "@/lib/layout/layout-values";
import type {
  DockRegionId,
  RegionId,
  ToolbarRegionId,
} from "@/lib/layout/region-id";
import { railDividerInsertIndex } from "@/lib/layout/rail";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * One order group's sortable list, typed in that group's own ids.
 *
 * Written as a branch per group rather than through one `ReadonlyArray<string>`
 * seam: only the rail actually mixes two kinds of id, and widening every group
 * to `string` meant re-narrowing each id back on the way out, where a
 * mis-routed id was silently DROPPED instead of failing (G1-23).
 *
 * THE list for its group in both hosts (L-03, L-95): the area form draws it
 * once per group, with the canvas's selected region highlighted.
 */
export function OrderGroupList(props: {
  readonly group: OrderGroupId;
  readonly selectedId: RegionId | null;
  readonly values: LayoutValues;
  readonly arrangement: LayoutArrangement;
  readonly decorate: SortableRowDecorator | null;
  readonly context: LayoutFormContext;
}): ReactNode {
  const { group, arrangement } = props;
  const gutter = useSortableRowPadding();
  const narrow = useIsMobileViewport();
  return (
    <div className="flex flex-col">
      <OrderGroupRows {...props} />
      {narrow && group === "rail" ? (
        // A phone has no rail: these rows order its tab switcher, whose last
        // entry is always More - where a panel set to In More goes. Drawn as
        // the list's pinned last line so the list reads the way the bar does.
        <div
          data-testid="layout-rail-more-row"
          className={cn(
            gutter.row,
            "flex items-center gap-2 border-t border-border/40 text-muted-foreground",
          )}
        >
          <span aria-hidden className="size-3.5 shrink-0" />
          <MoreHorizontal aria-hidden className="size-3.5 shrink-0" />
          <span className="font-medium">More</span>
          <span className="ml-auto text-ui-xs">Panels set to In More</span>
        </div>
      ) : null}
      {/* No dividers on a phone: its switcher is a flat chip bar. */}
      {ORDER_GROUPS[group].dividers && !narrow ? (
        // In the rows' own gutter: it is the last line of the same list, not a
        // button parked under a card (L-25, L-155).
        <div className={cn(gutter.row, "flex")}>
          {/* In the label column, under the names of the rows it adds to. */}
          <span aria-hidden className="w-11 shrink-0" />
          <Button
            type="button"
            variant="muted-outline"
            size="xs"
            onClick={() => {
              // Before the LAST panel, never after it (L-159): a divider past
              // the last icon spaces nothing, so an appended one made the
              // press read as a no-op and the user pressed again.
              writeArrangement(
                insertRailDivider(
                  arrangement,
                  railDividerInsertIndex(arrangement.rail),
                ),
              );
            }}
          >
            <Plus />
            Add divider
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The header that introduces one of these lists: its name, how it is operated,
 * and whatever verb belongs to the GROUP rather than to a member (R3-11) - the
 * area form's order revert.
 */
export function OrderGroupHeader(props: {
  readonly group: OrderGroupId;
  /** The list's revert, drawn after its heading, or `null`. */
  readonly revert: ReactNode;
}): ReactNode {
  const { group, revert } = props;
  const facts = ORDER_GROUPS[group];
  const gutter = useSortableRowPadding();
  const page = useLayoutFormHost() === "page";
  const narrow = useIsMobileViewport();
  if (!orderGroupHeaded(group, narrow)) return null;
  // At the row edge, the same x the area's own heading starts at; the rows'
  // grip column hangs under it.
  return (
    <div className={gutter.row}>
      <div className="flex items-center gap-1">
        <h3 className="font-medium text-foreground">{facts.label}</h3>
        {revert === null ? null : (
          <span className="-my-1 flex shrink-0">{revert}</span>
        )}
      </div>
      <p
        className={cn(
          "mt-0.5 max-w-[72ch] text-pretty text-muted-foreground",
          page ? "text-ui-sm" : "text-ui-xs",
        )}
      >
        {narrow && group === "rail"
          ? PHONE_RAIL_INSTRUCTION
          : orderGroupInstruction(group)}
      </p>
    </div>
  );
}

function OrderGroupRows(props: {
  readonly group: OrderGroupId;
  readonly selectedId: RegionId | null;
  readonly values: LayoutValues;
  readonly arrangement: LayoutArrangement;
  readonly decorate: SortableRowDecorator | null;
  readonly context: LayoutFormContext;
}): ReactNode {
  const { group, selectedId, values, arrangement, decorate, context } = props;
  const { providerIds } = useLayoutUsage();
  const narrow = useIsMobileViewport();
  const visibleProviders = arrangement.usageProviders.filter((id) =>
    providerIds.includes(id),
  );
  switch (group) {
    case "dock":
      return (
        <SortableList<DockRegionId>
          label={orderGroupListLabel(group)}
          selectedId={selectedId}
          items={regionRowItems(arrangement.dock, values, decorate)}
          onMove={(id, toIndex) => {
            writeArrangement({
              ...arrangement,
              dock: movedById(arrangement.dock, id, toIndex),
            });
          }}
        />
      );
    case "toolbarLeft":
      return (
        <SortableList<ToolbarRegionId>
          label={orderGroupListLabel(group)}
          selectedId={selectedId}
          items={regionRowItems(
            toolbarMembers("toolbarLeft", narrow, context),
            values,
            decorate,
          )}
          onMove={
            narrow
              ? null
              : (id, toIndex) => {
                  writeArrangement({
                    ...arrangement,
                    toolbarLeft: movedById(
                      arrangement.toolbarLeft,
                      id,
                      toIndex,
                    ),
                  });
                }
          }
        />
      );
    case "toolbarRight":
      return (
        <SortableList<ToolbarRegionId>
          label={orderGroupListLabel(group)}
          selectedId={selectedId}
          items={regionRowItems(
            toolbarMembers("toolbarRight", narrow, context),
            values,
            decorate,
          )}
          onMove={
            narrow
              ? null
              : (id, toIndex) => {
                  writeArrangement({
                    ...arrangement,
                    toolbarRight: movedById(
                      arrangement.toolbarRight,
                      id,
                      toIndex,
                    ),
                  });
                }
          }
        />
      );
    case "usageProviders":
      return (
        <ProviderLists
          configured={visibleProviders}
          arrangement={arrangement}
          decorate={decorate}
        />
      );
    case "rail":
      if (narrow) {
        // A phone's switcher is a flat chip bar, so the list is just the
        // panels: no divider rows, no stack rows and no Stack verb. The
        // dividers and stacks stay in the rail for the desktop.
        const panelIds = arrangement.rail.flatMap((entry) =>
          entry.kind === "panel" ? [entry.id] : [],
        );
        return (
          <SortableList<string>
            label={orderGroupListLabel(group)}
            selectedId={selectedId}
            items={panelIds.map((regionId) => ({
              ...railPanelOrderItem(regionId, arrangement, values, decorate),
              onStack: null,
            }))}
            onMove={(id, toIndex) => {
              writeArrangement(movePanelAmongPanels(arrangement, id, toIndex));
            }}
          />
        );
      }
      return (
        <SortableList<string>
          label={orderGroupListLabel(group)}
          selectedId={selectedId}
          items={arrangement.rail.map((entry) => {
            if (entry.kind === "divider")
              return dividerOrderItem(entry.id, arrangement);
            if (entry.kind === "stack")
              return stackOrderItem(entry.id, arrangement, values);
            return railPanelOrderItem(entry.id, arrangement, values, decorate);
          })}
          // Panels, dividers and stack links alike (L-155, L-166): the rail is
          // one flat list and the Position list is that list in order. Only
          // the first two are draggable - a link moves with its panels, and
          // the row says so by carrying no grab (L-168).
          onMove={(id, toIndex) => {
            writeArrangement(moveRailEntry(arrangement, id, toIndex));
          }}
        />
      );
    default:
      return assertNever(group);
  }
}

/**
 * The providers configured on the watched host, in their saved order, then
 * the rest behind a Show all providers disclosure (C13). The disclosure is not
 * a layout setting, and an unconfigured provider keeps its saved choices.
 */
function ProviderLists(props: {
  readonly configured: ReadonlyArray<RateLimitProviderId>;
  readonly arrangement: LayoutArrangement;
  readonly decorate: SortableRowDecorator | null;
}): ReactNode {
  const { configured, arrangement, decorate } = props;
  const [showAll, setShowAll] = useState(false);
  const gutter = useSortableRowPadding();
  const others = arrangement.usageProviders.filter(
    (id) => !configured.includes(id),
  );
  return (
    <>
      {configured.length === 0 ? (
        <div className={cn(gutter.row, "flex")}>
          <span aria-hidden className="w-11 shrink-0" />
          <NoLayoutUsageProviders />
        </div>
      ) : (
        <SortableList<RateLimitProviderId>
          label={orderGroupListLabel("usageProviders")}
          selectedId={null}
          items={providerOrderItems(configured, arrangement, decorate)}
          onMove={(id, toIndex) => {
            writeArrangement({
              ...arrangement,
              usageProviders: reorderVisibleProviders(
                arrangement.usageProviders,
                configured,
                id,
                toIndex,
              ),
            });
          }}
        />
      )}
      {others.length === 0 ? null : (
        <div className={cn(gutter.row, "flex")}>
          <span aria-hidden className="w-11 shrink-0" />
          <Button
            type="button"
            variant="muted"
            size="xs"
            aria-expanded={showAll}
            onClick={() => {
              setShowAll(!showAll);
            }}
            // Allowed to narrow with its row, so the label ends in an ellipsis
            // on a phone's column instead of running off its edge.
            className="min-w-0 shrink"
          >
            <ChevronRight
              aria-hidden
              className={cn("transition-transform", showAll && "rotate-90")}
            />
            <span className="truncate">
              {showAll
                ? "Hide other providers"
                : `Show all providers (${String(others.length)} not configured on this host)`}
            </span>
          </Button>
        </div>
      )}
      {showAll && others.length > 0 ? (
        <SortableList<RateLimitProviderId>
          label="Providers not configured on this host"
          selectedId={null}
          items={providerOrderItems(others, arrangement, decorate)}
          onMove={null}
        />
      ) : null}
    </>
  );
}

/** One id's new index, with an id this list no longer holds left alone. */
function movedById<Id extends string>(
  list: ReadonlyArray<Id>,
  id: Id,
  toIndex: number,
): ReadonlyArray<Id> {
  const fromIndex = list.indexOf(id);
  return fromIndex < 0 ? list : movedWithin(list, fromIndex, toIndex);
}

/** Omitted providers keep their slots, including preferences for hosts enabled later. */
function reorderVisibleProviders(
  order: ReadonlyArray<RateLimitProviderId>,
  visible: ReadonlyArray<RateLimitProviderId>,
  id: RateLimitProviderId,
  toIndex: number,
): ReadonlyArray<RateLimitProviderId> {
  const moved = movedById(visible, id, toIndex);
  let index = 0;
  return order.map((providerId) =>
    visible.includes(providerId) ? moved[index++] : providerId,
  );
}
