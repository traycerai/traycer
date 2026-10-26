import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  useActiveHeaderTab,
  useHeaderStripDropGroupId,
  useHeaderStripDropIndex,
  useHeaderStripOffsets,
} from "@/components/epic-canvas/dnd/dnd-store";
import { useTabOpenInNewWindowFlow } from "@/components/layout/tabs/use-tab-open-in-new-window";
import { UnsyncedEpicMoveDialog } from "@/components/layout/dialogs/unsynced-epic-move-dialog";
import { useCloseTabFlow } from "@/components/layout/dialogs/use-close-tab-flow";
import {
  useAnySystemOverlayActive,
  useSystemTabModalActions,
} from "@/stores/tabs/use-system-tab-modal";
import {
  getHeaderTabs,
  useHeaderStripItemIds,
  useHeaderTabs,
} from "@/stores/tabs/use-header-tabs";
import { useTabsStore } from "@/stores/tabs/store";
import {
  rebindUnreachableBotTab,
  useBotTabsStore,
} from "@/stores/bots/bot-tabs-store";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useTracyEntryItemId } from "@/stores/bots/tracy-entry";
import { useHostClient } from "@/lib/host";
import { tabDuplicate, tabResolveIntent } from "@/stores/tabs/registry";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import type { StripItem } from "@/stores/tabs/layout";
import type { TabCustomizations, TabGroups } from "@/stores/tabs/tab-groups";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import {
  activatePreparedPairTabIntent,
  homeTabIntent,
  navigateToTabIntent,
} from "@/lib/tab-navigation";
import {
  useHeaderTabIndicators,
  type HeaderTabIndicators,
} from "./header-tab-presentation";
import { useHomeTabDrawn } from "./use-home-tab-drawn";
import {
  executeTabSplitCommand,
  preparePairTabsCommand,
  resolveTabSplitCommandAvailability,
  type TabSplitCommandAvailability,
  type TabSplitCommandId,
} from "@/stores/tabs/tab-split-commands";
import {
  epicPinDispatchAdmitted,
  useEpicSetPinned,
  usePendingSetPinnedEpicIds,
} from "@/hooks/epic/use-epic-set-pinned-mutation";
import {
  useEpicTaskPinnedStates,
  useRetryUnansweredTaskPinReading,
  type TaskPinnedState,
} from "@/hooks/epic/use-epic-task-pinned-states-query";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";

/**
 * Everything a tab strip does that is not layout: the projection it draws,
 * the per-tab handlers, the pin dispatch, the `tab.split.*` and `epic.close`
 * keybindings and the dialogs those flows raise. Exactly one presentation
 * mounts over it at a time, so each registration stays single. DOM ownership
 * (the scroller, the trailing drop slot, overflow measurement, wheel and
 * reveal) belongs to the presentation.
 */
/** The fixed Tracy entry as a strip presentation draws it beside Home. */
export interface TracyStripEntry {
  readonly tab: HeaderTab;
  readonly isActive: boolean;
  readonly onActivate: () => void;
}

export interface TabStripController {
  /**
   * The strip's items, its tabs and its layout, all without the fixed Tracy
   * entry, which `tracy` carries instead: it is drawn in its own slot, never
   * counted, numbered or dropped among the tabs.
   */
  readonly headerItemIds: ReadonlyArray<string>;
  readonly layoutItems: ReadonlyArray<StripItem>;
  readonly groups: TabGroups | undefined;
  readonly customizations: TabCustomizations | undefined;
  readonly tabs: ReadonlyArray<HeaderTab>;
  readonly activeItemId: string | null;
  readonly homeTabDrawn: boolean;
  readonly homeIsActive: boolean;
  readonly tracy: TracyStripEntry | null;
  /** Home off, no tabs, on the landing route: the strip has nothing to draw. */
  readonly isEmptyLanding: boolean;
  readonly dropIndicatorIndex: number | null;
  /** The group the drop under way lands in, which decides where its line sits. */
  readonly dropGroupId: string | null;
  /** The strip item being dragged, which the drop's line is placed around. */
  readonly dragSourceItemId: string | null;
  readonly offsets: ReadonlyMap<string, number>;
  readonly indicators: HeaderTabIndicators;
  readonly onClose: (tab: HeaderTab) => void;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly canCloseOtherTabs: boolean;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly canOpenInNewWindow: boolean;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  readonly taskPinnedStates: ReadonlyMap<string, TaskPinnedState>;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly onTaskPinMenuOpen: (epicId: string) => void;
  readonly onSetTaskPinned: (
    epicId: string,
    pinned: boolean,
    displayName: string,
  ) => void;
  readonly onNewTab: () => void;
  readonly onHomeTab: () => void;
  readonly onCloseGroup: (groupId: string) => void;
  /** Returned for the presentation to render, never rendered by the hook. */
  readonly dialogs: ReactNode;
}

export function useTabStripController(): TabStripController {
  const navigate = useNavigate();
  const { headerItemIds, layoutItems, allTabs, tracy } = useStripWithoutTracy();
  const groups = useTabsStore((state) => state.groups);
  const customizations = useTabsStore((state) => state.customizations);
  const openInNewWindowFlow = useTabOpenInNewWindowFlow();
  const closeTabFlow = useCloseTabFlow();
  const { close: closeModal } = useSystemTabModalActions();
  const modalActive = useAnySystemOverlayActive();
  const activeItemId = useTabsStore((state) => state.activeItemId);
  const homeTabDrawn = useHomeTabDrawn();
  // `activeItemId === null` over a populated strip means Home holds the
  // selection; over an empty one it means the same thing, since Home is the
  // only surface left to hold it.
  const homeIsActive = homeTabDrawn && activeItemId === null;
  const activePathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  // Single insertion index covering header-tab reorder AND canvas tear-off
  // hovers - both flow through the root DndContext into the drag store.
  const dropIndicatorIndex = useHeaderStripDropIndex();
  const dropGroupId = useHeaderStripDropGroupId();
  const dragSourceItemId = useActiveHeaderTab()?.stripItemId ?? null;
  // Explicit per-item displacement resolved by the drag model - the same
  // mechanism the tile strip uses. No provisional CSS `order`, no layout
  // projection, so no projection can be stranded mid-flight.
  const offsets = useHeaderStripOffsets();
  const indicators = useHeaderTabIndicators(allTabs);
  const taskPinnedStates = useEpicTaskPinnedStates(indicators.epicIds);
  const onTaskPinMenuOpen = useRetryUnansweredTaskPinReading(
    indicators.epicIds,
  );
  const pendingSetPinnedEpicIds = usePendingSetPinnedEpicIds();
  const onSetTaskPinned = useTaskPinDispatch(taskPinnedStates);

  const onNewTab = useCallback(() => {
    navigateToTabIntent(navigate, openNewEpicIntent(), undefined);
  }, [navigate]);

  const onHomeTab = useCallback(() => {
    navigateToTabIntent(navigate, homeTabIntent(), undefined);
  }, [navigate]);

  const onDuplicateTab = useCallback(
    (tab: HeaderTab) => {
      const intent = tabDuplicate(tab);
      if (intent === null) return;
      navigateToTabIntent(navigate, intent, undefined);
    },
    [navigate],
  );

  const onSplitCommand = useCallback(
    (id: TabSplitCommandId, tab: HeaderTab): void => {
      const ref: TabRef = { kind: tab.kind, id: tab.id };
      const availability = resolveTabSplitCommandAvailability(ref);
      if (id === "close-left" || id === "close-right") {
        requestCloseSplitNeighbour(
          id,
          availability,
          closeTabFlow.requestCloseTab,
        );
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
      if (id === "close-left" || id === "close-right") {
        requestCloseSplitNeighbour(
          id,
          resolveTabSplitCommandAvailability(null),
          closeTabFlow.requestCloseTab,
        );
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

  return {
    headerItemIds,
    layoutItems,
    groups,
    customizations,
    tabs: allTabs,
    activeItemId,
    homeTabDrawn,
    homeIsActive,
    tracy,
    // Home is a fixed tab, so with it drawn there is always something to
    // render: the one control that gets the user back to Home must not
    // disappear exactly when it is the only surface open.
    isEmptyLanding:
      !homeTabDrawn &&
      tracy === null &&
      allTabs.length === 0 &&
      activePathname === "/",
    dropIndicatorIndex,
    dropGroupId,
    dragSourceItemId,
    offsets,
    indicators,
    onClose: closeTabFlow.requestCloseTab,
    onCloseOtherTabs: closeTabFlow.closeOtherTabs,
    canCloseOtherTabs: headerItemIds.length > 1,
    onDuplicateTab,
    onOpenInNewWindow: openInNewWindowFlow.requestOpen,
    canOpenInNewWindow: openInNewWindowFlow.isAvailable,
    onSplitCommand,
    taskPinnedStates,
    pendingSetPinnedEpicIds,
    onSetTaskPinned,
    onTaskPinMenuOpen,
    onNewTab,
    onHomeTab,
    onCloseGroup: closeTabFlow.closeGroup,
    dialogs: (
      <>
        {closeTabFlow.unsyncedDialog}
        <UnsyncedEpicMoveDialog flow={openInNewWindowFlow.epicFlow} />
      </>
    ),
  };
}

/**
 * The strip split into its tabs and the fixed Tracy entry. The entry's item
 * is taken out of the ids and the layout alike, which are index-aligned, so
 * every row, drop slot and Alt-digit badge counts the tabs alone.
 */
function useStripWithoutTracy(): {
  readonly headerItemIds: ReadonlyArray<string>;
  readonly layoutItems: ReadonlyArray<StripItem>;
  readonly allTabs: ReadonlyArray<HeaderTab>;
  readonly tracy: TracyStripEntry | null;
} {
  const headerItemIds = useHeaderStripItemIds();
  const layoutItems = useTabsStore((state) => state.items);
  const activeItemId = useTabsStore((state) => state.activeItemId);
  const headerTabs = useHeaderTabs();
  const fixedBotId = useBotTabsStore((state) => state.fixedBotId);
  const tracyItemId = useTracyEntryItemId();
  // Without bots (unread included) a restored entry is kept out of the strip
  // and not drawn: `TracyEntryController` releases it once the read is off.
  const bots = usePreviewFeature("bots") === "on";
  const tracyTab = useMemo(
    () =>
      tracyItemId === null
        ? null
        : (headerTabs.find(
            (tab) => tab.kind === "bot" && tab.id === fixedBotId,
          ) ?? null),
    [fixedBotId, headerTabs, tracyItemId],
  );
  const tracyIsActive = tracyItemId !== null && activeItemId === tracyItemId;
  const onActivateTracy = useOpenTracyEntry(tracyTab);
  return useMemo(() => {
    if (tracyItemId === null || tracyTab === null) {
      return { headerItemIds, layoutItems, allTabs: headerTabs, tracy: null };
    }
    const tracy = bots
      ? {
          tab: tracyTab,
          isActive: tracyIsActive,
          onActivate: onActivateTracy,
        }
      : null;
    return {
      headerItemIds: headerItemIds.filter((id) => id !== tracyItemId),
      layoutItems: layoutItems.filter((item) => item.id !== tracyItemId),
      allTabs: headerTabs.filter((tab) => tab !== tracyTab),
      tracy,
    };
  }, [
    bots,
    headerItemIds,
    headerTabs,
    layoutItems,
    onActivateTracy,
    tracyIsActive,
    tracyItemId,
    tracyTab,
  ]);
}

/**
 * Opens the entry's tab as Home's bots list opens a bot: a restored tab whose
 * host this client can no longer dial first moves to this window's host.
 */
function useOpenTracyEntry(tab: HeaderTab | null): () => void {
  const navigate = useNavigate();
  const hostId = useEffectiveHostId();
  const connectable = useConnectableHostIds();
  return useCallback(() => {
    if (tab === null) return;
    if (hostId !== null) {
      rebindUnreachableBotTab(
        tab.id,
        hostId,
        connectable.resolved ? (id) => connectable.hostIds.includes(id) : null,
      );
    }
    navigateToTabIntent(navigate, tabResolveIntent(tab), undefined);
  }, [connectable.hostIds, connectable.resolved, hostId, navigate, tab]);
}

/** The one pin dispatch site for the whole tab tree, Undo included. */
function useTaskPinDispatch(
  taskPinnedStates: ReadonlyMap<string, TaskPinnedState>,
): (epicId: string, pinned: boolean, displayName: string) => void {
  const { mutate: setEpicPinned } = useEpicSetPinned();
  const hostClient = useHostClient();
  return useCallback(
    (epicId: string, pinned: boolean, displayName: string) => {
      // The same reading the menu rendered its label and availability from -
      // NOT a second derivation, which is how a control and its dispatch come
      // to disagree. A local-homed epic on a `@1.1` host is served off that
      // host's disk and spends no cloud capability, so it is admissible with
      // no verdict; everything else still needs one.
      const reading = taskPinnedStates.get(epicId);
      const isLocalHome = reading?.home === "local";
      // The epic's host, from that SAME reading. A local-homed pin is served
      // off the owning host's disk, so the write has to go there: sent to the
      // window's host instead, `epicHomeVerdict` answers not-local and the
      // request falls through to a cloud write for an epic the cloud has no row
      // for. `null` for a cloud-homed row means "follow the window", which is
      // right - any host proxies a cloud pin.
      const hostId = reading?.hostId ?? null;
      const variables = { epicId, pinned, isLocalHome, hostId };
      // Fail closed on the CAPABILITY, not just in the menu. The Undo action
      // below is a second entry into this dispatch that no menu gate can
      // reach: the toast outlives the click, so a verdict withdrawn - or a
      // host rolled back to `@1.0` - in between would let Undo spend a cloud
      // capability the session no longer holds. `epicPinDispatchAdmitted` is
      // the mutation's own gate, so this edge and `onMutate` cannot answer
      // differently; it re-reads both the verdict and the negotiation rather
      // than closing over either.
      if (!epicPinDispatchAdmitted(variables, hostClient.getActiveHostId())) {
        return;
      }
      setEpicPinned(variables, {
        onSuccess: () => {
          toast.success(pinConfirmationMessage(displayName, pinned), {
            action: {
              label: "Undo",
              onClick: () => {
                // `hostId` rides the closure exactly as `isLocalHome` does,
                // and that is what lets the pin host be per-dispatch at all:
                // this toast outlives the row's menu, so a host resolved from a
                // mounted row would be gone by now.
                const undo = { epicId, pinned: !pinned, isLocalHome, hostId };
                if (
                  !epicPinDispatchAdmitted(undo, hostClient.getActiveHostId())
                ) {
                  return;
                }
                setEpicPinned(undo);
              },
            },
          });
        },
      });
    },
    [hostClient, setEpicPinned, taskPinnedStates],
  );
}

/** Routes a split's close-left / close-right through the tab close flow. */
function requestCloseSplitNeighbour(
  id: "close-left" | "close-right",
  availability: TabSplitCommandAvailability,
  requestCloseTab: (tab: HeaderTab) => void,
): void {
  const closeRef =
    id === "close-left" ? availability.closeLeft : availability.closeRight;
  if (closeRef === null) return;
  const closeTab = getHeaderTab(closeRef);
  if (closeTab !== null) requestCloseTab(closeTab);
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
