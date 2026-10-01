import { useMemo, useState, type ReactNode } from "react";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import { VERTICAL_STRIP_AXIS } from "@/components/epic-canvas/dnd/strip-axis";
import { resolveMinimapRailMaskClassName } from "@/components/minimap/minimap-rail-mask";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import { cn } from "@/lib/utils";
import {
  flattenStripItemRefs,
  tabRefKey,
  type StripItem,
} from "@/stores/tabs/layout";
import type { HeaderTab } from "@/stores/tabs/types";
import { HEADER_STRIP_SCROLL_TEST_ID } from "../header-strip-geometry";
import type { TabStripController } from "../tab-strip-controller";
import {
  stripRowsOf,
  type StripRow,
  type StripRowGroupStart,
} from "../tab-strip-rows";
import { useStripScroller } from "../use-strip-scroller";
import type { SideStripHandlers } from "./side-strip-item-input";
import { blockDropEdge, rowDropSide, stripDropLine } from "../strip-drop-line";
import { SideStripItem } from "./side-strip-item";
import { SideStripSections } from "./side-strip-sections";
import { useSectionedStrip } from "./strip-agents-mode";
import {
  SIDE_STRIP_LIST_CLASS,
  SIDE_STRIP_SECTIONED_SCROLL_PADDING_CLASS,
} from "./side-strip-tokens";
import { SideTabGroupBlock } from "./side-tab-group-block";
import { SideTabGroupColumn } from "./side-tab-group-column";
import { SideTabGroupHeader } from "./side-tab-group-header";
import type { SideTabRowVariant } from "./side-tab-row";
import { useSectionScroll } from "./use-section-scroll";

/** One run of a group: its rows, tab members' count and notification entities. */
interface GroupRun {
  readonly rows: Array<StripRow>;
  memberCount: number;
  readonly memberEntities: Array<HostNotificationsEntityRef>;
}

/** What the Layered view draws in order: a row of no group, or a group's run. */
type ListSegment =
  | { readonly kind: "row"; readonly row: StripRow }
  | {
      readonly kind: "group";
      /** The run's first item, which keys it. */
      readonly key: string;
      readonly start: StripRowGroupStart;
      readonly run: GroupRun;
    };

/**
 * The vertical strip's scrolling row list. The scroller is the drag contract
 * the provider reads (`data-strip-axis="y"`, `data-strip-edge`), holds the
 * trailing drop slot, re-bases every item after each commit and keeps the
 * active row in view (L-146). There is no hidden-tabs menu: the column
 * scrolls, and every row is reachable by wheel and by the leader badges.
 *
 * The Layered view lists the rows in the user's order under their group
 * headers; the Activity view lists them in its sections, where the expanded
 * list fades at its bottom edge while more lies below, and the rail runs its
 * tiles in the same sections.
 */
export function SideStripRowList(props: {
  readonly controller: TabStripController;
  readonly edge: EdgeSide;
  readonly variant: SideTabRowVariant;
}): ReactNode {
  const { controller, edge, variant } = props;
  const {
    headerItemIds,
    layoutItems,
    groups,
    customizations,
    activeItemId,
    dropIndicatorIndex,
    dropGroupId,
    dragSourceItemId,
    tabs,
  } = controller;
  const rows = useMemo(
    () => stripRowsOf(headerItemIds, layoutItems, groups, customizations),
    [headerItemIds, layoutItems, groups, customizations],
  );
  const segments = useMemo(
    () => listSegmentsOf(rows, layoutItems, tabs),
    [rows, layoutItems, tabs],
  );
  const handlers = useSideStripHandlers(controller);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const setScrollerNode = useStripScroller({
    axis: VERTICAL_STRIP_AXIS,
    activeItemId,
    itemCount: headerItemIds.length,
    extraRef: setScroller,
  });
  // The drop's line is placed among the rows that are drawn, which is how the
  // drag model counts them: a collapsed group's rows are not.
  const drawn = useMemo(() => rows.filter((row) => !row.hidden), [rows]);
  const dropLine = useMemo(() => {
    const sourceIndex = drawn.findIndex(
      (row) => row.itemId === dragSourceItemId,
    );
    return stripDropLine(
      drawn.map((row) => row.group?.groupId ?? null),
      dropIndicatorIndex,
      dropGroupId,
      sourceIndex < 0 ? null : sourceIndex,
    );
  }, [drawn, dropIndicatorIndex, dropGroupId, dragSourceItemId]);
  const sectioned = useSectionedStrip();
  // Only the expanded list has section headers to stick, fold and scroll to,
  // and group blocks (the rail's groups are columns).
  const expanded = variant === "expanded";
  const sectionedList = sectioned && expanded;
  const scroll = useSectionScroll(sectionedList ? scroller : null);
  // A grouped row sits in its group's block or column, which carries the colour.
  const item = (row: StripRow): ReactNode =>
    row.hidden ? null : (
      <SideStripItem
        key={row.itemId}
        itemId={row.itemId}
        stripIndex={row.stripIndex}
        offset={controller.offsets.get(row.itemId) ?? 0}
        memberOffset={row.memberOffset}
        isActive={row.itemId === activeItemId}
        dropIndicator={rowDropSide(dropLine, drawn.indexOf(row))}
        variant={variant}
        inBlock={row.group !== null}
        lane={null}
        members={null}
        handlers={handlers}
      />
    );
  return (
    <div
      ref={setScrollerNode}
      role="tablist"
      aria-label="Open tabs"
      aria-orientation="vertical"
      // The task rows are non-editable chrome and dim while a layout session
      // is live; the session's own row carries the marker that keeps it lit.
      data-layout-passive-members
      data-testid={HEADER_STRIP_SCROLL_TEST_ID}
      data-strip-axis="y"
      data-strip-edge={edge}
      className={cn(
        SIDE_STRIP_LIST_CLASS[variant],
        "no-scrollbar min-h-0 flex-[0_1_auto] overflow-y-auto overscroll-y-contain [-webkit-app-region:no-drag]",
        sectionedList && SIDE_STRIP_SECTIONED_SCROLL_PADDING_CLASS,
        sectionedList &&
          resolveMinimapRailMaskClassName(false, scroll.moreBelow),
      )}
    >
      {sectioned ? (
        <SideStripSections
          controller={controller}
          handlers={handlers}
          variant={variant}
          scroller={scroller}
          needsYouAbove={scroll.needsYouAbove}
        />
      ) : (
        segments.map((segment) => {
          if (segment.kind === "row") return item(segment.row);
          const { start, run } = segment;
          const members = run.rows.map((row) => item(row));
          const dropEdge = blockDropEdge(dropLine, start.groupId);
          const header = (
            <SideTabGroupHeader
              groupId={start.groupId}
              group={start.group}
              variant={variant}
              memberCount={run.memberCount}
              memberEntities={run.memberEntities}
              onClose={controller.onCloseGroup}
            />
          );
          return expanded ? (
            <SideTabGroupBlock
              key={segment.key}
              groupId={start.groupId}
              color={start.group.color}
              collapsed={start.group.collapsed}
              lane={null}
              dropEdge={dropEdge}
              header={header}
            >
              {members}
            </SideTabGroupBlock>
          ) : (
            <SideTabGroupColumn
              key={segment.key}
              groupId={start.groupId}
              color={start.group.color}
              lane={null}
              dropEdge={dropEdge}
              header={header}
            >
              {members}
            </SideTabGroupColumn>
          );
        })
      )}
    </div>
  );
}

/** The controller's handler fields, held stable across unrelated renders. */
function useSideStripHandlers(
  controller: TabStripController,
): SideStripHandlers {
  const {
    onClose,
    onCloseOtherTabs,
    canCloseOtherTabs,
    onDuplicateTab,
    onOpenInNewWindow,
    canOpenInNewWindow,
    onSplitCommand,
    taskPinnedStates,
    pendingSetPinnedEpicIds,
    onSetTaskPinned,
    onTaskPinMenuOpen,
  } = controller;
  return useMemo(
    () => ({
      onClose,
      onCloseOtherTabs,
      canCloseOtherTabs,
      onDuplicateTab,
      onOpenInNewWindow,
      canOpenInNewWindow,
      onSplitCommand,
      taskPinnedStates,
      pendingSetPinnedEpicIds,
      onSetTaskPinned,
      onTaskPinMenuOpen,
    }),
    [
      onClose,
      onCloseOtherTabs,
      canCloseOtherTabs,
      onDuplicateTab,
      onOpenInNewWindow,
      canOpenInNewWindow,
      onSplitCommand,
      taskPinnedStates,
      pendingSetPinnedEpicIds,
      onSetTaskPinned,
      onTaskPinMenuOpen,
    ],
  );
}

/**
 * The rows as the Layered view draws them: each group's run of rows with its
 * tab count and member entities, and every other row on its own. A split counts
 * each tab half; an entity is the epic, or the tab id for a non-epic tab, as a
 * row's own indicator reads it.
 */
function listSegmentsOf(
  rows: ReadonlyArray<StripRow>,
  layoutItems: ReadonlyArray<StripItem>,
  tabs: ReadonlyArray<HeaderTab>,
): ReadonlyArray<ListSegment> {
  const tabsByKey = new Map(tabs.map((tab) => [tabRefKey(tab), tab]));
  const segments: Array<ListSegment> = [];
  let open: GroupRun | null = null;
  for (const row of rows) {
    if (row.groupStart !== null) {
      open = { rows: [row], memberCount: 0, memberEntities: [] };
      segments.push({
        kind: "group",
        key: row.itemId,
        start: row.groupStart,
        run: open,
      });
    } else if (row.group === null) {
      open = null;
      segments.push({ kind: "row", row });
    } else {
      open?.rows.push(row);
    }
    const item = layoutItems.at(row.stripIndex);
    if (open === null || item === undefined) continue;
    for (const ref of flattenStripItemRefs(item)) {
      const tab = tabsByKey.get(tabRefKey(ref));
      open.memberCount += 1;
      open.memberEntities.push({
        epicId: tab?.kind === "epic" ? tab.epicId : ref.id,
      });
    }
  }
  return segments;
}
