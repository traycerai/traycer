import { memo, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { LayoutGroup } from "motion/react";
import { useDroppable } from "@dnd-kit/core";
import { toast } from "sonner";
import {
  HEADER_TAB_SLOT_DND_TYPE,
  HEADER_TAB_TRAILING_SLOT_DROP_ID,
  type HeaderTabSlotDropData,
} from "@/components/layout/tabs/header-tab-dnd";
import { useHeaderStripDropIndex } from "@/components/epic-canvas/dnd/dnd-store";
import { useTabOpenInNewWindowFlow } from "@/components/layout/tabs/use-tab-open-in-new-window";
import { UnsyncedEpicMoveDialog } from "@/components/layout/dialogs/unsynced-epic-move-dialog";
import { useCloseTabFlow } from "@/components/layout/dialogs/use-close-tab-flow";
import {
  useAnySystemOverlayActive,
  useSystemTabModalActions,
} from "@/stores/tabs/use-system-tab-modal";
import {
  getHeaderTabs,
  useHeaderStripItem,
  useHeaderStripItemIds,
  useHeaderTabs,
} from "@/stores/tabs/use-header-tabs";
import { useTabsStore } from "@/stores/tabs/store";
import { tabDuplicate, tabResolveIntent } from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";
import type { TabRef } from "@/stores/tabs/types";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { TabStripSkeleton } from "@/components/layout/tabs/tab-strip-skeleton";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { TabItem } from "@/components/layout/tabs/tab-strip-item";
import { SplitTabItem } from "@/components/layout/tabs/split-tab-item";
import { TabStripNewButton } from "@/components/layout/tabs/tab-strip-new-button";
import { useHorizontalWheelScroll } from "@/hooks/use-horizontal-wheel-scroll";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import {
  executeTabSplitCommand,
  preparePairTabsCommand,
  resolveTabSplitCommandAvailability,
  type TabSplitCommandId,
} from "@/stores/tabs/tab-split-commands";
import { activatePreparedPairTabIntent } from "@/lib/tab-navigation";
import type { StripItem } from "@/stores/tabs/layout";
import {
  useEpicSetPinned,
  usePendingSetPinnedEpicIds,
} from "@/hooks/epic/use-epic-set-pinned-mutation";
import { useEpicTaskPinnedStates } from "@/hooks/epic/use-epic-task-pinned-states-query";

export function TabStrip() {
  const hasHydrated = useWindowsBridgeHydrated();
  const persistedStripCount = useTabsStore((s) => s.stripOrder.length);
  if (!hasHydrated) {
    return <TabStripSkeleton count={persistedStripCount} />;
  }
  return <TabStripBody />;
}

function TabStripBody() {
  const headerItemIds = useHeaderStripItemIds();
  const layoutItems = useTabsStore((state) => state.items);
  const allTabs = useHeaderTabs();
  const navigate = useNavigate();
  const openInNewWindowFlow = useTabOpenInNewWindowFlow();
  const closeTabFlow = useCloseTabFlow();
  const { close: closeModal } = useSystemTabModalActions();
  const modalActive = useAnySystemOverlayActive();
  const handleWheel = useHorizontalWheelScroll();
  const activeItemId = useTabsStore((state) => state.activeItemId);
  const activePathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  // Single insertion index covering header-tab reorder AND canvas tear-off
  // hovers - both flow through the root DndContext into the drag store.
  const dropIndicatorIndex = useHeaderStripDropIndex();

  const isLandingPage = activePathname === "/";
  const indicatorEpicIds = useMemo(
    () => allTabs.flatMap((tab) => (tab.kind === "epic" ? [tab.epicId] : [])),
    [allTabs],
  );
  const notificationIndicators = useNotificationIndicators({
    // Epic ids only, so the app-wide active host is the right one to ask: an
    // Epic is a shared cloud entity, not a host-owned record.
    hostId: null,
    epicIds: indicatorEpicIds,
    chatIds: [],
    enabled: indicatorEpicIds.length > 0,
  });
  const taskPinnedStates = useEpicTaskPinnedStates(indicatorEpicIds);
  const pendingSetPinnedEpicIds = usePendingSetPinnedEpicIds();
  const { mutate: setEpicPinned } = useEpicSetPinned();
  const handleSetTaskPinned = useCallback(
    (epicId: string, pinned: boolean, displayName: string) => {
      setEpicPinned(
        { epicId, pinned },
        {
          onSuccess: () => {
            toast.success(pinConfirmationMessage(displayName, pinned), {
              action: {
                label: "Undo",
                onClick: () => {
                  setEpicPinned({ epicId, pinned: !pinned });
                },
              },
            });
          },
        },
      );
    },
    [setEpicPinned],
  );

  // Trailing slot: the strip's empty space after the last tab accepts drops
  // at index `allTabs.length` (both reorder and tear-off).
  const trailingSlotData = useMemo<HeaderTabSlotDropData>(
    () => ({
      kind: HEADER_TAB_SLOT_DND_TYPE,
      index: headerItemIds.length,
      isTrailing: true,
    }),
    [headerItemIds.length],
  );
  const { setNodeRef: trailingSlotRef } = useDroppable({
    id: HEADER_TAB_TRAILING_SLOT_DROP_ID,
    data: trailingSlotData,
  });

  const handleNewTab = useCallback(() => {
    navigateToTabIntent(navigate, openNewEpicIntent(), undefined);
  }, [navigate]);

  const handleDuplicateTab = useCallback(
    (tab: HeaderTab) => {
      const intent = tabDuplicate(tab);
      if (intent === null) return;
      navigateToTabIntent(navigate, intent, undefined);
    },
    [navigate],
  );

  const handleSplitCommand = useCallback(
    (id: TabSplitCommandId, tab: HeaderTab): void => {
      const ref: TabRef = { kind: tab.kind, id: tab.id };
      const availability = resolveTabSplitCommandAvailability(ref);
      if (id === "close-left" || id === "close-right") {
        const closeRef =
          id === "close-left"
            ? availability.closeLeft
            : availability.closeRight;
        if (closeRef === null) return;
        const closeTab = getHeaderTab(closeRef);
        if (closeTab !== null) closeTabFlow.requestCloseTab(closeTab);
        return;
      }
      if (id === "pair") {
        const prepared = preparePairTabsCommand(ref);
        if (prepared === null) return;
        activatePreparedPairTabIntent(
          navigate,
          prepared.command,
          tabResolveIntent(tab),
          undefined,
        );
        return;
      }
      executeTabSplitCommand(id, ref);
    },
    [closeTabFlow, navigate],
  );

  const executeActiveSplitCommand = useCallback(
    (id: TabSplitCommandId): void => {
      const availability = resolveTabSplitCommandAvailability(null);
      if (id === "close-left" || id === "close-right") {
        const closeRef =
          id === "close-left"
            ? availability.closeLeft
            : availability.closeRight;
        if (closeRef === null) return;
        const closeTab = getHeaderTab(closeRef);
        if (closeTab !== null) closeTabFlow.requestCloseTab(closeTab);
        return;
      }
      executeTabSplitCommand(id, null);
    },
    [closeTabFlow],
  );

  useEffect(() => {
    const unregisterAdd = registerDynamicActionHandler("tab.split.add", () => {
      executeActiveSplitCommand("add");
    });
    const unregisterSwap = registerDynamicActionHandler(
      "tab.split.swap",
      () => {
        executeActiveSplitCommand("swap");
      },
    );
    const unregisterSeparate = registerDynamicActionHandler(
      "tab.split.separate",
      () => {
        executeActiveSplitCommand("separate");
      },
    );
    const unregisterCloseLeft = registerDynamicActionHandler(
      "tab.split.close-left",
      () => {
        executeActiveSplitCommand("close-left");
      },
    );
    const unregisterCloseRight = registerDynamicActionHandler(
      "tab.split.close-right",
      () => {
        executeActiveSplitCommand("close-right");
      },
    );
    return () => {
      unregisterAdd();
      unregisterSwap();
      unregisterSeparate();
      unregisterCloseLeft();
      unregisterCloseRight();
    };
  }, [executeActiveSplitCommand]);

  // The strip mounts inside every signed-in route, so it's the right
  // home for the universal "close active strip tab" chord. Registers
  // a dynamic handler for `epic.close` (default ⇧⌘W) so the chord
  // closes the active strip tab regardless of kind - epic, draft,
  // history, or settings - by routing through the close-flow. The
  // system-tab modal takes precedence: if it's open, the chord closes
  // the modal first instead of the underlying strip tab.
  const closeActiveStripTab = closeTabFlow.closeActiveTab;
  useEffect(() => {
    return registerDynamicActionHandler("epic.close", () => {
      if (modalActive) {
        closeModal();
        return;
      }
      closeActiveStripTab();
    });
  }, [closeActiveStripTab, closeModal, modalActive]);

  if (allTabs.length === 0 && isLandingPage) {
    return null;
  }

  const canCloseOtherTabs = headerItemIds.length > 1;

  return (
    <NotificationIndicatorsProvider indicators={notificationIndicators}>
      <div
        role="tablist"
        aria-label="Open tabs"
        data-testid="tab-strip"
        className="relative flex min-w-0 flex-1 items-end"
      >
        <div className="relative flex min-w-0 max-w-full flex-[0_1_auto] items-end">
          <LayoutGroup id="header-tabs">
            <div
              ref={trailingSlotRef}
              data-testid="header-tab-strip-scroll"
              onWheel={handleWheel}
              className="no-scrollbar flex min-w-0 max-w-full flex-[0_1_auto] touch-pan-x items-end overflow-x-auto overscroll-x-contain"
            >
              {headerItemIds.map((itemId, index) => (
                <HeaderStripItemRenderer
                  key={itemId}
                  itemId={itemId}
                  stripIndex={index}
                  memberOffset={memberOffsetBefore(layoutItems, index)}
                  isActive={itemId === activeItemId}
                  isNextActive={headerItemIds[index + 1] === activeItemId}
                  nextIsSplit={layoutItems[index + 1]?.kind === "split"}
                  isLastItem={index === headerItemIds.length - 1}
                  showDropIndicatorBefore={dropIndicatorIndex === index}
                  showDropIndicatorAfter={
                    dropIndicatorIndex === index + 1 &&
                    index === headerItemIds.length - 1
                  }
                  onClose={closeTabFlow.requestCloseTab}
                  onCloseOtherTabs={closeTabFlow.closeOtherTabs}
                  onDuplicateTab={handleDuplicateTab}
                  canCloseOtherTabs={canCloseOtherTabs}
                  onOpenInNewWindow={openInNewWindowFlow.requestOpen}
                  canOpenInNewWindow={openInNewWindowFlow.isAvailable}
                  onSplitCommand={handleSplitCommand}
                  taskPinnedStates={taskPinnedStates}
                  pendingSetPinnedEpicIds={pendingSetPinnedEpicIds}
                  onSetTaskPinned={handleSetTaskPinned}
                />
              ))}
            </div>
          </LayoutGroup>
          <TabStripNewButton onNewTab={handleNewTab} />
        </div>
        {closeTabFlow.unsyncedDialog}
        <UnsyncedEpicMoveDialog flow={openInNewWindowFlow.epicFlow} />
      </div>
    </NotificationIndicatorsProvider>
  );
}

interface HeaderStripItemRendererProps {
  readonly itemId: string;
  readonly stripIndex: number;
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
  readonly taskPinnedStates: ReadonlyMap<string, boolean>;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly onSetTaskPinned: (
    epicId: string,
    pinned: boolean,
    displayName: string,
  ) => void;
}

const HeaderStripItemRenderer = memo(function HeaderStripItemRenderer(
  props: HeaderStripItemRendererProps,
): ReactNode {
  const item = useHeaderStripItem(props.itemId);
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
      />
    );
  }
  return (
    <HeaderStripTabItem
      itemId={item.id}
      tab={item.tab}
      index={props.memberOffset}
      stripIndex={props.stripIndex}
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
    />
  );
});

const HeaderStripTabItem = memo(function HeaderStripTabItem(props: {
  readonly itemId: string;
  readonly tab: HeaderTab;
  readonly index: number;
  readonly stripIndex: number;
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
  readonly taskPinnedStates: ReadonlyMap<string, boolean>;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly onSetTaskPinned: (
    epicId: string,
    pinned: boolean,
    displayName: string,
  ) => void;
}): ReactNode {
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
      taskPinned={
        props.tab.kind === "epic"
          ? (props.taskPinnedStates.get(props.tab.epicId) ?? null)
          : null
      }
      isTaskPinPending={
        props.tab.kind === "epic" &&
        props.pendingSetPinnedEpicIds.has(props.tab.epicId)
      }
      onSetTaskPinned={props.onSetTaskPinned}
    />
  );
});

function memberOffsetBefore(
  items: ReadonlyArray<StripItem>,
  index: number,
): number {
  return items.slice(0, index).reduce((total, item) => {
    if (item.kind === "tab") return total + 1;
    return (
      total +
      Number(item.left.kind === "tab") +
      Number(item.right.kind === "tab")
    );
  }, 0);
}

function getHeaderTab(ref: TabRef): HeaderTab | null {
  return (
    getHeaderTabs().find((tab) => tab.kind === ref.kind && tab.id === ref.id) ??
    null
  );
}

function pinConfirmationMessage(displayName: string, pinned: boolean): string {
  return pinned
    ? `Pinned “${displayName}” to the top of History`
    : `Unpinned “${displayName}” from History`;
}
