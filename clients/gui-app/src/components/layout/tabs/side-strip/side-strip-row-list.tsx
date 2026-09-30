import { Fragment, useMemo, type ReactNode } from "react";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import { VERTICAL_STRIP_AXIS } from "@/components/epic-canvas/dnd/strip-axis";
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
import { stripRowsOf, type StripRow } from "../tab-strip-rows";
import { useStripScroller } from "../use-strip-scroller";
import {
  dropIndicatorOf,
  type SideStripHandlers,
} from "./side-strip-item-input";
import { SideStripItem } from "./side-strip-item";
import { SideStripSections } from "./side-strip-sections";
import { useLiveAgentsInStrip } from "./strip-agents-mode";
import { SIDE_STRIP_LIST_CLASS } from "./side-strip-tokens";
import { SideTabGroupHeader } from "./side-tab-group-header";
import type { SideTabRowVariant } from "./side-tab-row";

/** One run of a group: its tab members' count and notification entities. */
interface GroupRun {
  memberCount: number;
  readonly memberEntities: Array<HostNotificationsEntityRef>;
}

/**
 * The vertical strip's scrolling row list. The scroller is the drag contract
 * the provider reads (`data-strip-axis="y"`, `data-strip-edge`), holds the
 * trailing drop slot, re-bases every item after each commit and keeps the
 * active row in view (L-146). There is no hidden-tabs menu: the column
 * scrolls, and every row is reachable by wheel and by the leader badges.
 *
 * The Layered view lists the rows in the user's order under their group
 * headers; the Activity view lists them in its sections.
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
    tabs,
  } = controller;
  const rows = useMemo(
    () => stripRowsOf(headerItemIds, layoutItems, groups, customizations),
    [headerItemIds, layoutItems, groups, customizations],
  );
  const groupRuns = useMemo(
    () => groupRunsOf(rows, layoutItems, tabs),
    [rows, layoutItems, tabs],
  );
  const handlers = useSideStripHandlers(controller);
  const setScrollerNode = useStripScroller({
    axis: VERTICAL_STRIP_AXIS,
    activeItemId,
    itemCount: headerItemIds.length,
    extraRef: null,
  });
  const lastIndex = headerItemIds.length - 1;
  const sectioned = useLiveAgentsInStrip() && variant === "expanded";
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
      )}
    >
      {sectioned ? (
        <SideStripSections controller={controller} handlers={handlers} />
      ) : (
        rows.map((row) => (
          <Fragment key={row.itemId}>
            <GroupStart
              row={row}
              run={groupRuns.get(row.stripIndex)}
              variant={variant}
              onCloseGroup={controller.onCloseGroup}
            />
            {row.hidden ? null : (
              <SideStripItem
                itemId={row.itemId}
                stripIndex={row.stripIndex}
                offset={controller.offsets.get(row.itemId) ?? 0}
                memberOffset={row.memberOffset}
                isActive={row.itemId === activeItemId}
                dropIndicator={dropIndicatorOf(
                  dropIndicatorIndex,
                  row.stripIndex,
                  lastIndex,
                )}
                variant={variant}
                groupLine={row.group?.group.color ?? null}
                lane={null}
                members={null}
                handlers={handlers}
              />
            )}
          </Fragment>
        ))
      )}
    </div>
  );
}

function GroupStart(props: {
  readonly row: StripRow;
  readonly run: GroupRun | undefined;
  readonly variant: SideTabRowVariant;
  readonly onCloseGroup: (groupId: string) => void;
}): ReactNode {
  const start = props.row.groupStart;
  if (start === null) return null;
  return (
    <SideTabGroupHeader
      groupId={start.groupId}
      group={start.group}
      variant={props.variant}
      memberCount={props.run?.memberCount ?? 0}
      memberEntities={props.run?.memberEntities ?? []}
      onClose={props.onCloseGroup}
    />
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
 * Each group run's tab count and member entities, keyed by the strip index of
 * the run's first item. A split counts each tab half; an entity is the epic,
 * or the tab id for a non-epic tab, as a row's own indicator reads it.
 */
function groupRunsOf(
  rows: ReadonlyArray<StripRow>,
  layoutItems: ReadonlyArray<StripItem>,
  tabs: ReadonlyArray<HeaderTab>,
): ReadonlyMap<number, GroupRun> {
  const tabsByKey = new Map(tabs.map((tab) => [tabRefKey(tab), tab]));
  const runs = new Map<number, GroupRun>();
  let current: GroupRun | null = null;
  for (const row of rows) {
    if (row.groupStart !== null) {
      current = { memberCount: 0, memberEntities: [] };
      runs.set(row.stripIndex, current);
    } else if (row.group === null) {
      current = null;
    }
    const item = layoutItems.at(row.stripIndex);
    if (current === null || item === undefined) continue;
    for (const ref of flattenStripItemRefs(item)) {
      const tab = tabsByKey.get(tabRefKey(ref));
      current.memberCount += 1;
      current.memberEntities.push({
        epicId: tab?.kind === "epic" ? tab.epicId : ref.id,
      });
    }
  }
  return runs;
}
