import {
  Fragment,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as m from "motion/react-m";
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
import { useAppearanceHeaderStripItem } from "@/stores/tabs/use-header-tabs";
import { HEADER_STRIP_SCROLL_TEST_ID } from "../header-strip-geometry";
import { useHeaderTabDisplacementTransition } from "../tab-chrome-tokens";
import type { TabStripController } from "../tab-strip-controller";
import { stripRowsOf, type StripRow } from "../tab-strip-rows";
import {
  useStripTabItem,
  type HeaderTabDndConfig,
} from "../use-strip-tab-item";
import { useStripItemDisplacement } from "../use-strip-item-displacement";
import { useStripScroller } from "../use-strip-scroller";
import {
  stripTabItemInputOf,
  type DropIndicator,
  type SideStripHandlers,
  type SideStripItemProps,
} from "./side-strip-item-input";
import { SideSplitItem } from "./side-strip-split-item";
import { SideStripTabRow } from "./side-strip-tab-row";
import { StripAgentGroup } from "./strip-agent-group";
import { StripNeedsYouScope } from "./strip-needs-you-scope";
import { useStripTaskGroup } from "./strip-task-group";
import { useSideTabJoin } from "./side-tab-join";
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
      <StripNeedsYouScope>
        {rows.map((row) => (
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
                handlers={handlers}
              />
            )}
          </Fragment>
        ))}
      </StripNeedsYouScope>
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

/** The insertion line on the row it lands before, or after the last row. */
function dropIndicatorOf(
  dropIndex: number | null,
  stripIndex: number,
  lastIndex: number,
): DropIndicator {
  if (dropIndex === stripIndex) return "before";
  if (dropIndex === stripIndex + 1 && stripIndex === lastIndex) return "after";
  return null;
}

const SideStripItem = memo(function SideStripItem(
  props: SideStripItemProps,
): ReactNode {
  const item = useAppearanceHeaderStripItem(props.itemId);
  if (item === null) return null;
  if (item.kind === "split") return <SideSplitItem {...props} item={item} />;
  return <SideTabItem {...props} tab={item.tab} />;
});

/** A lone tab: its reorder frame, displaced along y, around its row. */
function SideTabItem(
  props: SideStripItemProps & { readonly tab: HeaderTab },
): ReactNode {
  const transition = useHeaderTabDisplacementTransition();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const y = useStripItemDisplacement({
    nodeRef: frameRef,
    offset: props.offset,
    transition,
  });
  const dnd = useMemo<HeaderTabDndConfig>(
    () => ({
      stripItemId: props.itemId,
      index: props.stripIndex,
      isDropSlot: true,
    }),
    [props.itemId, props.stripIndex],
  );
  const input = stripTabItemInputOf(
    {
      tab: props.tab,
      index: props.memberOffset,
      dnd,
      isActive: props.isActive,
    },
    props.handlers,
  );
  const { rootRef, ...item } = useStripTabItem(input);
  const [rowNode, setRowNode] = useState<HTMLDivElement | null>(null);
  const bindRow = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef(node);
      setRowNode(node);
    },
    [rootRef],
  );
  const joined = useSideTabJoin(
    props.isActive && !item.isDragging,
    rowNode,
    props.tab,
  );
  const group = useStripTaskGroup(props.tab, props.isActive);
  return (
    <m.div
      ref={frameRef}
      initial={false}
      // Hidden on the frame the overlay first paints, so the column never
      // shows two copies of the dragged row.
      animate={{ opacity: item.isDragging ? 0 : 1 }}
      style={{ y }}
      transition={transition}
      data-strip-item-id={props.itemId}
      data-strip-item-mergeable="true"
      className="relative flex flex-col"
    >
      <SideStripTabRow
        item={item}
        rootRef={bindRow}
        input={input}
        variant={props.variant}
        groupLine={
          props.groupLine === null
            ? null
            : { color: props.groupLine, seat: "row" }
        }
        dropIndicator={props.dropIndicator}
        joined={joined}
        group={group}
      />
      <StripAgentGroup group={group} />
    </m.div>
  );
}
