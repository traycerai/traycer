import { tabRefKey } from "@/stores/tabs/layout";
import { useLayoutSurface } from "@/components/layout-editor/use-layout-surface";
import { HiddenTabsMenu } from "./hidden-tabs-menu";
import { useHiddenHeaderTabs } from "./use-hidden-header-tabs";
import { TabGroupChip } from "./tab-group-chip";
import { stripRowsOf, taskPinReadOf } from "./tab-strip-rows";
import {
  memo,
  Fragment,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { HORIZONTAL_STRIP_AXIS } from "@/components/epic-canvas/dnd/strip-axis";
import { useNavigate } from "@tanstack/react-router";
import { revealSelectedMember, useStripScroller } from "./use-strip-scroller";
import { useOpenStripEntrances } from "./use-strip-entrance";
import { useAppearanceHeaderStripItem } from "@/stores/tabs/use-header-tabs";
import { useTabsStore } from "@/stores/tabs/store";
import { tabResolveIntent } from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";
import { TabStripSkeleton } from "@/components/layout/tabs/tab-strip-skeleton";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { TabItem } from "@/components/layout/tabs/tab-strip-item";
import { SplitTabItem } from "@/components/layout/tabs/split-tab-item";
import { TabStripNewButton } from "@/components/layout/tabs/tab-strip-new-button";
import { HomeStripSlot } from "@/components/layout/tabs/tab-strip-home-item";
import { useHomeTabDrawn } from "@/components/layout/tabs/use-home-tab-drawn";
import { useTabStripController } from "@/components/layout/tabs/tab-strip-controller";
import { TabStripIndicatorScope } from "@/components/layout/tabs/tab-strip-indicator-scope";
import { useArrangementValue } from "@/lib/layout-overrides";
import { useHorizontalWheelScroll } from "@/hooks/use-horizontal-wheel-scroll";
import type { TabSplitCommandId } from "@/stores/tabs/tab-split-commands";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { useStripExitGhosts, type StripExitGhost } from "./strip-exit-ghosts";
import { StripExitGhostSpacer } from "./strip-exit-ghost-spacer";
import { useSelectionTravel } from "./strip-selection-travel";
import { StripSelectionTraveller } from "./strip-selection-traveller";
import { useJoinGlowStore } from "./join-glow";

export function TabStrip() {
  const hasHydrated = useWindowsBridgeHydrated();
  const persistedStripCount = useTabsStore((s) => s.stripOrder.length);
  const homeTabEnabled = useHomeTabDrawn();
  if (!hasHydrated) {
    return (
      <TabStripSkeleton
        count={persistedStripCount}
        reserveHome={homeTabEnabled}
      />
    );
  }
  return <TabStripBody />;
}

function TabStripBody() {
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const controller = useTabStripController();
  const {
    headerItemIds,
    layoutItems,
    groups,
    customizations,
    activeItemId,
    dropIndicatorIndex,
  } = controller;
  const allTabs = controller.tabs;
  const navigate = useNavigate();
  const handleWheel = useHorizontalWheelScroll();
  const taskTabLayout = useArrangementValue("taskTabLayout");
  const { setScrollElement, hiddenTabKeys, hasOverflow, revealTab } =
    useHiddenHeaderTabs(taskTabLayout);
  const hiddenTabs = useMemo(() => {
    const left = new Set(hiddenTabKeys.left);
    const right = new Set(hiddenTabKeys.right);
    return {
      left: allTabs.filter((tab) => left.has(tabRefKey(tab))),
      right: allTabs.filter((tab) => right.has(tabRefKey(tab))),
    };
  }, [allTabs, hiddenTabKeys]);
  const handleActivateHiddenTab = useCallback(
    (tab: HeaderTab) => {
      navigateToTabIntent(navigate, tabResolveIntent(tab), undefined);
      revealTab(tabRefKey(tab));
    },
    [navigate, revealTab],
  );
  const rows = useMemo(
    () => stripRowsOf(headerItemIds, layoutItems, groups, customizations),
    [headerItemIds, layoutItems, groups, customizations],
  );
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const travellerRef = useRef<HTMLSpanElement | null>(null);
  const setScrollExtras = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node;
      setScrollElement(node);
    },
    [setScrollElement],
  );
  // Before `useStripScroller`: the slots it opens are measured and held shut
  // before the activation reveal runs, and it keeps the selection in view
  // while they grow, which that one-off reveal cannot.
  const revealSelection = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null)
      revealSelectedMember(scroller, HORIZONTAL_STRIP_AXIS);
  }, []);
  useOpenStripEntrances(revealSelection);
  const setScrollerNode = useStripScroller({
    axis: HORIZONTAL_STRIP_AXIS,
    activeItemId,
    itemCount: headerItemIds.length,
    extraRef: setScrollExtras,
  });
  // After `useStripScroller`, whose reveal has by then scrolled the
  // destination into view for the travel to measure.
  useSelectionTravel({ scrollerRef, travellerRef, activeItemId, layoutItems });
  const { ghosts, settleGhost } = useStripExitGhosts(
    scrollerRef,
    headerItemIds.join("\n"),
  );
  const ghostBefore = useMemo(() => {
    const byAnchor = new Map<string | null, StripExitGhost>();
    for (const ghost of ghosts) byAnchor.set(ghost.beforeAnchor, ghost);
    return byAnchor;
  }, [ghosts]);
  const renderGhost = (anchor: string | null): ReactNode => {
    const ghost = ghostBefore.get(anchor);
    return ghost === undefined ? null : (
      <StripExitGhostSpacer
        key={ghost.key}
        ghost={ghost}
        onSettled={settleGhost}
      />
    );
  };
  const joinGlowing = useJoinGlowStore((state) => state.glowing);
  const surfaceRef = useLayoutSurface("topBar");
  const stripRef = useCallback(
    (node: HTMLDivElement | null) => {
      tabListRef.current = node;
      surfaceRef(node);
    },
    [surfaceRef],
  );

  // On the empty landing route the strip draws nothing; the header's own
  // actions stay, so no control is lost.
  if (controller.isEmptyLanding) {
    return null;
  }

  return (
    <TabStripIndicatorScope indicators={controller.indicators}>
      <div
        ref={stripRef}
        tabIndex={-1}
        role="tablist"
        aria-label="Open tabs"
        data-testid="tab-strip"
        data-tab-layout={taskTabLayout}
        data-join-glow={joinGlowing ? "" : undefined}
        className="group/strip relative flex min-w-0 flex-1 items-end"
      >
        {/* Outside the scrollable list and before it: Home is fixed, so it
            must not scroll away with the task tabs. */}
        {controller.homeTabDrawn ? (
          <HomeStripSlot
            isActive={controller.homeIsActive}
            onActivate={controller.onHomeTab}
          />
        ) : null}
        <div className="relative flex min-w-0 max-w-full flex-[0_1_auto] items-end">
          {hasOverflow ? (
            <HiddenTabsMenu
              tabs={hiddenTabs.left}
              side="left"
              fallbackFocusRef={tabListRef}
              onActivate={handleActivateHiddenTab}
            />
          ) : null}
          {/* The task tabs are non-editable chrome and dim while a layout
              session is live (4.2). The marker is on the scroller rather
              than on the strip root, which is an ancestor of the Home
              item's region.

              The `-members` spelling dims each tab rather than the
              scroller's own box, because one of those tabs is the
              session's own chrome: the sample workspace tab, which draws
              itself as the customizing mark (L-87, L-138). `opacity` on
              this box could not be undone below it, so the one mark that
              says "you are customizing" was drawn at 45% of itself
              (L-132). */}
          <div
            // Two owners, one node: dnd-kit's trailing drop slot, and the
            // reveal above, which needs the scrolling box itself.
            ref={setScrollerNode}
            data-layout-passive-members
            data-testid="header-tab-strip-scroll"
            data-strip-axis="x"
            data-strip-edge="top"
            onWheel={handleWheel}
            // `relative` so the selection traveller is placed in the strip's
            // own scrolling content, scrolled and clipped with the tabs.
            className="no-scrollbar relative flex min-w-0 max-w-full flex-[0_1_auto] touch-pan-x items-end overflow-x-auto overscroll-x-contain [-webkit-app-region:no-drag]"
          >
            <StripSelectionTraveller ref={travellerRef} />
            {rows.map((row) => {
              const { itemId, stripIndex: index } = row;
              return (
                <Fragment key={itemId}>
                  {row.groupStart !== null ? (
                    <>
                      {renderGhost(`chip:${row.groupStart.groupId}`)}
                      <TabGroupChip
                        groupId={row.groupStart.groupId}
                        group={row.groupStart.group}
                        onClose={controller.onCloseGroup}
                      />
                    </>
                  ) : null}
                  {!row.hidden ? renderGhost(`item:${itemId}`) : null}
                  {!row.hidden ? (
                    <HeaderStripItemRenderer
                      itemId={itemId}
                      stripIndex={index}
                      offsetX={controller.offsets.get(itemId) ?? 0}
                      memberOffset={row.memberOffset}
                      isActive={itemId === activeItemId}
                      isNextActive={headerItemIds[index + 1] === activeItemId}
                      nextIsSplit={layoutItems[index + 1]?.kind === "split"}
                      isLastItem={index === headerItemIds.length - 1}
                      showDropIndicatorBefore={dropIndicatorIndex === index}
                      showDropIndicatorAfter={
                        dropIndicatorIndex === index + 1 &&
                        index === headerItemIds.length - 1
                      }
                      onClose={controller.onClose}
                      onCloseOtherTabs={controller.onCloseOtherTabs}
                      onDuplicateTab={controller.onDuplicateTab}
                      canCloseOtherTabs={controller.canCloseOtherTabs}
                      onOpenInNewWindow={controller.onOpenInNewWindow}
                      canOpenInNewWindow={controller.canOpenInNewWindow}
                      onSplitCommand={controller.onSplitCommand}
                      taskPinnedStates={controller.taskPinnedStates}
                      pendingSetPinnedEpicIds={
                        controller.pendingSetPinnedEpicIds
                      }
                      onSetTaskPinned={controller.onSetTaskPinned}
                      onTaskPinMenuOpen={controller.onTaskPinMenuOpen}
                    />
                  ) : null}
                </Fragment>
              );
            })}
            {renderGhost(null)}
          </div>
          {hasOverflow ? (
            <HiddenTabsMenu
              tabs={hiddenTabs.right}
              side="right"
              onActivate={handleActivateHiddenTab}
              fallbackFocusRef={tabListRef}
            />
          ) : null}
          {/* Placed by the strip: 4px after the last tab, centred on the row. */}
          <div className="ml-1 flex shrink-0 self-center">
            <TabStripNewButton onNewTab={controller.onNewTab} />
          </div>
        </div>
        {controller.dialogs}
      </div>
    </TabStripIndicatorScope>
  );
}

interface HeaderStripItemRendererProps {
  readonly itemId: string;
  readonly stripIndex: number;
  readonly offsetX: number;
  readonly memberOffset: number;
  // Passed as named booleans rather than packed into one positional string.
  // `memo` compares primitives, so five props cost the same as one - and a
  // packed string spread magic indices across two components, where a wrong
  // index is a silent visual bug no type check can catch.
  readonly isActive: boolean;
  readonly isNextActive: boolean;
  readonly nextIsSplit: boolean;
  readonly isLastItem: boolean;
  readonly showDropIndicatorBefore: boolean;
  readonly showDropIndicatorAfter: boolean;
  readonly onClose: (tab: HeaderTab) => void;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly canCloseOtherTabs: boolean;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly canOpenInNewWindow: boolean;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  readonly taskPinnedStates: ReadonlyMap<string, TaskPinnedState>;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly onSetTaskPinned: (
    epicId: string,
    pinned: boolean,
    displayName: string,
  ) => void;
  /** See `useRetryUnansweredTaskPinReading`: re-asks when a tab's menu opens. */
  readonly onTaskPinMenuOpen: (epicId: string) => void;
}

const HeaderStripItemRenderer = memo(function HeaderStripItemRenderer(
  props: HeaderStripItemRendererProps,
): ReactNode {
  const item = useAppearanceHeaderStripItem(props.itemId);
  const {
    isActive,
    isNextActive,
    nextIsSplit,
    isLastItem,
    showDropIndicatorBefore,
    showDropIndicatorAfter,
  } = props;
  if (item === null) return null;
  // Computed once, above the branch, because it applies to every strip item.
  // Restating it inside only the tab branch is what left a split group with no
  // trailing hairline, so the group-to-tab boundary rendered as a blank gap.
  const isSplitGroupBoundary = item.kind === "split" && nextIsSplit;
  const showSeparatorAfter =
    !isLastItem && (isSplitGroupBoundary || (!isActive && !isNextActive));
  if (item.kind === "split") {
    return (
      <SplitTabItem
        item={item}
        stripIndex={props.stripIndex}
        offsetX={props.offsetX}
        leftMemberIndex={props.memberOffset}
        rightMemberIndex={props.memberOffset + Number(item.left.kind === "tab")}
        isActive={isActive}
        showSeparatorAfter={showSeparatorAfter}
        showDropIndicatorBefore={showDropIndicatorBefore}
        showDropIndicatorAfter={showDropIndicatorAfter}
        onClose={props.onClose}
        onCloseOtherTabs={props.onCloseOtherTabs}
        onDuplicateTab={props.onDuplicateTab}
        canCloseOtherTabs={props.canCloseOtherTabs}
        onOpenInNewWindow={props.onOpenInNewWindow}
        canOpenInNewWindow={props.canOpenInNewWindow}
        onSplitCommand={props.onSplitCommand}
        taskPinnedStates={props.taskPinnedStates}
        pendingSetPinnedEpicIds={props.pendingSetPinnedEpicIds}
        onSetTaskPinned={props.onSetTaskPinned}
        onTaskPinMenuOpen={props.onTaskPinMenuOpen}
      />
    );
  }
  return (
    <HeaderStripTabItem
      itemId={item.id}
      tab={item.tab}
      index={props.memberOffset}
      stripIndex={props.stripIndex}
      offsetX={props.offsetX}
      isActive={isActive}
      showDropIndicatorBefore={showDropIndicatorBefore}
      showDropIndicatorAfter={showDropIndicatorAfter}
      showSeparatorAfter={showSeparatorAfter}
      onClose={props.onClose}
      onCloseOtherTabs={props.onCloseOtherTabs}
      onDuplicateTab={props.onDuplicateTab}
      canCloseOtherTabs={props.canCloseOtherTabs}
      onOpenInNewWindow={props.onOpenInNewWindow}
      canOpenInNewWindow={props.canOpenInNewWindow}
      onSplitCommand={props.onSplitCommand}
      taskPinnedStates={props.taskPinnedStates}
      pendingSetPinnedEpicIds={props.pendingSetPinnedEpicIds}
      onSetTaskPinned={props.onSetTaskPinned}
      onTaskPinMenuOpen={props.onTaskPinMenuOpen}
    />
  );
});

const HeaderStripTabItem = memo(function HeaderStripTabItem(props: {
  readonly itemId: string;
  readonly tab: HeaderTab;
  readonly index: number;
  readonly stripIndex: number;
  readonly offsetX: number;
  readonly isActive: boolean;
  readonly showDropIndicatorBefore: boolean;
  readonly showDropIndicatorAfter: boolean;
  readonly showSeparatorAfter: boolean;
  readonly onClose: (tab: HeaderTab) => void;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly canCloseOtherTabs: boolean;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly canOpenInNewWindow: boolean;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  readonly taskPinnedStates: ReadonlyMap<string, TaskPinnedState>;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly onSetTaskPinned: (
    epicId: string,
    pinned: boolean,
    displayName: string,
  ) => void;
  /** See `useRetryUnansweredTaskPinReading`: re-asks when a tab's menu opens. */
  readonly onTaskPinMenuOpen: (epicId: string) => void;
}): ReactNode {
  const pinRead = taskPinReadOf(
    props.tab,
    props.taskPinnedStates,
    props.pendingSetPinnedEpicIds,
  );
  const dnd = useMemo(
    () => ({
      stripItemId: props.itemId,
      index: props.stripIndex,
      isDropSlot: true,
    }),
    [props.itemId, props.stripIndex],
  );
  return (
    <TabItem
      tab={props.tab}
      index={props.index}
      dnd={dnd}
      chrome="own"
      includeMotionFrame
      offsetX={props.offsetX}
      isActive={props.isActive}
      showSeparatorAfter={props.showSeparatorAfter}
      showDropIndicatorBefore={props.showDropIndicatorBefore}
      showDropIndicatorAfter={props.showDropIndicatorAfter}
      onClose={props.onClose}
      onCloseOtherTabs={props.onCloseOtherTabs}
      onDuplicateTab={props.onDuplicateTab}
      canCloseOtherTabs={props.canCloseOtherTabs}
      onOpenInNewWindow={props.onOpenInNewWindow}
      canOpenInNewWindow={props.canOpenInNewWindow}
      onSplitCommand={props.onSplitCommand}
      taskPinnedState={pinRead.taskPinnedState}
      isTaskPinPending={pinRead.isTaskPinPending}
      onSetTaskPinned={props.onSetTaskPinned}
      onTaskPinMenuOpen={props.onTaskPinMenuOpen}
    />
  );
});
