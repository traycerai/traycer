import { useCallback, useEffect, useMemo } from "react";
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
import { useHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { useTabsStore } from "@/stores/tabs/store";
import { tabDuplicate, tabMatchesPath } from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";
import { openNewEpicDraft } from "@/lib/commands/actions/new-epic";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { TabStripSkeleton } from "@/components/layout/tabs/tab-strip-skeleton";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import { draftTabIntent, navigateToTabIntent } from "@/lib/tab-navigation";
import { TabItem } from "@/components/layout/tabs/tab-strip-item";
import { TabStripNewButton } from "@/components/layout/tabs/tab-strip-new-button";
import { useHorizontalWheelScroll } from "@/hooks/use-horizontal-wheel-scroll";
import { useHostNotificationIndicators } from "@/hooks/notifications/use-host-notification-indicators-query";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
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
  const allTabs = useHeaderTabs();
  const navigate = useNavigate();
  const openInNewWindowFlow = useTabOpenInNewWindowFlow();
  const closeTabFlow = useCloseTabFlow();
  const { close: closeModal } = useSystemTabModalActions();
  const modalActive = useAnySystemOverlayActive();
  const handleWheel = useHorizontalWheelScroll();
  // Single insertion index covering header-tab reorder AND canvas tear-off
  // hovers - both flow through the root DndContext into the drag store.
  const dropIndicatorIndex = useHeaderStripDropIndex();

  const activePathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  const isLandingPage = activePathname === "/";
  const activeTabs = useMemo(
    () => allTabs.map((tab) => isTabActive(tab, activePathname)),
    [activePathname, allTabs],
  );
  const indicatorEpicIds = useMemo(
    () => allTabs.flatMap((tab) => (tab.kind === "epic" ? [tab.epicId] : [])),
    [allTabs],
  );
  const notificationIndicators = useHostNotificationIndicators({
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
      index: allTabs.length,
      isTrailing: true,
    }),
    [allTabs.length],
  );
  const { setNodeRef: trailingSlotRef } = useDroppable({
    id: HEADER_TAB_TRAILING_SLOT_DROP_ID,
    data: trailingSlotData,
  });

  const handleNewTab = useCallback(() => {
    const draftId = openNewEpicDraft();
    navigateToTabIntent(navigate, draftTabIntent(draftId));
  }, [navigate]);

  const handleDuplicateTab = useCallback(
    (tab: HeaderTab) => {
      const intent = tabDuplicate(tab);
      if (intent === null) return;
      navigateToTabIntent(navigate, intent);
    },
    [navigate],
  );

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

  const canCloseOtherTabs = allTabs.length > 1;

  return (
    <NotificationIndicatorsProvider indicators={notificationIndicators.data}>
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
              {allTabs.map((tab, index) => {
                const isLastTab = index === allTabs.length - 1;
                const isActive = activeTabs[index];
                const isNextActive = activeTabs[index + 1];
                const showDropIndicatorBefore = dropIndicatorIndex === index;
                const showDropIndicatorAfter =
                  dropIndicatorIndex === index + 1 && isLastTab;
                return (
                  <TabItem
                    key={refKey(tab.kind, tab.id)}
                    tab={tab}
                    index={index}
                    isActive={isActive}
                    showSeparatorAfter={
                      !isLastTab && !isActive && !isNextActive
                    }
                    showDropIndicatorBefore={showDropIndicatorBefore}
                    showDropIndicatorAfter={showDropIndicatorAfter}
                    onClose={closeTabFlow.requestCloseTab}
                    onCloseOtherTabs={closeTabFlow.closeOtherTabs}
                    onDuplicateTab={handleDuplicateTab}
                    canCloseOtherTabs={canCloseOtherTabs}
                    onOpenInNewWindow={openInNewWindowFlow.requestOpen}
                    canOpenInNewWindow={openInNewWindowFlow.isAvailable}
                    taskPinned={
                      tab.kind === "epic"
                        ? (taskPinnedStates.get(tab.epicId) ?? null)
                        : null
                    }
                    isTaskPinPending={
                      tab.kind === "epic" &&
                      pendingSetPinnedEpicIds.has(tab.epicId)
                    }
                    onSetTaskPinned={handleSetTaskPinned}
                  />
                );
              })}
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

function isTabActive(tab: HeaderTab, pathname: string): boolean {
  return tabMatchesPath(tab, pathname);
}

function refKey(kind: HeaderTab["kind"], id: string): string {
  return `${kind}:${id}`;
}

function pinConfirmationMessage(displayName: string, pinned: boolean): string {
  return pinned
    ? `Pinned “${displayName}” to the top of History`
    : `Unpinned “${displayName}” from History`;
}
