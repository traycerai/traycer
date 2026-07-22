import { v4 as uuidv4 } from "uuid";
import {
  findStripItemForRef,
  flattenLayoutRefs,
  type PersistedTabStripLayout,
  type SplitSideName,
  type SplitStripItem,
  type StripItem,
} from "@/stores/tabs/layout";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { useTabsStore } from "@/stores/tabs/store";
import { tabSurfaceDescriptor } from "@/stores/tabs/registry";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  isTabCloseLocked,
  isTabStructurallyLocked,
} from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";

export const TAB_SPLIT_COMMANDS = {
  add: {
    id: "add",
    label: "Add tab to new split view",
  },
  pair: {
    id: "pair",
    label: "New split view with current tab",
  },
  swap: {
    id: "swap",
    label: "Swap sides",
  },
  separate: {
    id: "separate",
    label: "Separate split view",
  },
  closeLeft: {
    id: "close-left",
    label: "Close left view",
  },
  closeRight: {
    id: "close-right",
    label: "Close right view",
  },
} as const;

export type TabSplitCommandId =
  (typeof TAB_SPLIT_COMMANDS)[keyof typeof TAB_SPLIT_COMMANDS]["id"];

export interface TabSplitCommandAvailability {
  readonly add: boolean;
  readonly pair: boolean;
  readonly swap: boolean;
  readonly separate: boolean;
  readonly closeLeft: TabRef | null;
  readonly closeRight: TabRef | null;
}

export interface PreparedPairTabsCommand {
  readonly command: {
    readonly left: TabRef;
    readonly right: TabRef;
    readonly focusedRef: TabRef;
    readonly splitId: string;
    readonly leftRatio: number;
  };
  readonly focusedRef: TabRef;
}

/**
 * Resolves against the live store every time it is invoked. This is shared by
 * context menus and command-palette handlers, which prevents a stale menu
 * render from authorizing a structural mutation after focus changed.
 */
export function resolveTabSplitCommandAvailability(
  invokedRef: TabRef | null,
): TabSplitCommandAvailability {
  const state = useTabsStore.getState();
  const layout = layoutFromState();
  const focused = selectHostFocusedRef(state);
  const focusedItem = itemForRef(layout, focused);
  const invokedItem = itemForRef(layout, invokedRef);
  const targetSplit = splitForCommand(focusedItem, invokedItem);
  const canAdd = canAddCurrent(focused, focusedItem, invokedRef);
  const canPair = canPairCurrent(focused, focusedItem, invokedRef, invokedItem);
  const activeSplitUnlocked = splitIsUnlocked(layout, targetSplit);

  return {
    add: canAdd,
    pair: canPair,
    swap: activeSplitUnlocked,
    separate: activeSplitUnlocked,
    closeLeft: closableSide(targetSplit, "left"),
    closeRight: closableSide(targetSplit, "right"),
  };
}

/**
 * The caller must hand this command to the navigation controller's prepared
 * pair seam. Keeping construction here makes menu availability and execution
 * sample the same live state without letting a background-tab menu mutate the
 * current tab.
 */
export function preparePairTabsCommand(
  invokedRef: TabRef | null,
): PreparedPairTabsCommand | null {
  const availability = resolveTabSplitCommandAvailability(invokedRef);
  const focused = selectHostFocusedRef(useTabsStore.getState());
  if (!availability.pair || focused === null || invokedRef === null) {
    return null;
  }
  return {
    command: {
      left: focused,
      right: invokedRef,
      focusedRef: invokedRef,
      splitId: `split:${uuidv4()}`,
      leftRatio: 0.5,
    },
    focusedRef: invokedRef,
  };
}

export function executeTabSplitCommand(
  id: Exclude<TabSplitCommandId, "close-left" | "close-right">,
  invokedRef: TabRef | null,
): boolean {
  const availability = resolveTabSplitCommandAvailability(invokedRef);
  const state = useTabsStore.getState();
  const focused = selectHostFocusedRef(state);
  if (id === "add") return executeAddCommand(availability.add, focused);
  if (id === "pair") {
    return executePairCommand(availability.pair, focused, invokedRef);
  }
  return executeGroupCommand(id, availability, invokedRef);
}

function layoutFromState(): PersistedTabStripLayout {
  const state = useTabsStore.getState();
  return {
    version: 2 as const,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
  };
}

function itemForRef(
  layout: PersistedTabStripLayout,
  ref: TabRef | null,
): StripItem | null {
  return ref === null ? null : findStripItemForRef(layout, ref);
}

function splitForCommand(
  focusedItem: StripItem | null,
  invokedItem: StripItem | null,
): SplitStripItem | null {
  if (invokedItem?.kind === "split") return invokedItem;
  return focusedItem?.kind === "split" ? focusedItem : null;
}

function canAddCurrent(
  focused: TabRef | null,
  focusedItem: StripItem | null,
  invokedRef: TabRef | null,
): boolean {
  return (
    focused !== null &&
    (invokedRef === null || refsMatch(focused, invokedRef)) &&
    focusedItem?.kind === "tab" &&
    canStructurallySplit(focused)
  );
}

function canPairCurrent(
  focused: TabRef | null,
  focusedItem: StripItem | null,
  invokedRef: TabRef | null,
  invokedItem: StripItem | null,
): boolean {
  if (focused === null || invokedRef === null) return false;
  if (focused.kind === invokedRef.kind && focused.id === invokedRef.id) {
    return false;
  }
  return (
    focusedItem?.kind === "tab" &&
    invokedItem?.kind === "tab" &&
    canStructurallySplit(focused) &&
    canStructurallySplit(invokedRef)
  );
}

function splitIsUnlocked(
  layout: PersistedTabStripLayout,
  split: SplitStripItem | null,
): boolean {
  return (
    split !== null &&
    flattenLayoutRefs({ ...layout, items: [split] }).every(
      (ref) => !isTabStructurallyLocked(ref),
    )
  );
}

function executeAddCommand(allowed: boolean, focused: TabRef | null): boolean {
  if (!allowed || focused === null) return false;
  return tabCommandCoordinator.createEmptySplit({
    ref: focused,
    splitId: `split:${uuidv4()}`,
    populatedSide: "left",
    focusedSide: "right",
    leftRatio: 0.5,
  });
}

function executePairCommand(
  allowed: boolean,
  focused: TabRef | null,
  invokedRef: TabRef | null,
): boolean {
  if (!allowed || focused === null || invokedRef === null) return false;
  return tabCommandCoordinator.pairTabs({
    left: focused,
    right: invokedRef,
    focusedRef: invokedRef,
    splitId: `split:${uuidv4()}`,
    leftRatio: 0.5,
  });
}

function refsMatch(left: TabRef, right: TabRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function executeGroupCommand(
  id: "swap" | "separate",
  availability: TabSplitCommandAvailability,
  invokedRef: TabRef | null,
): boolean {
  const layout = layoutFromState();
  const focused = selectHostFocusedRef(useTabsStore.getState());
  const targetSplit = splitForCommand(
    itemForRef(layout, focused),
    itemForRef(layout, invokedRef),
  );
  if (targetSplit === null) return false;
  if (id === "swap") {
    return availability.swap
      ? tabCommandCoordinator.swapSplitSides(targetSplit.id)
      : false;
  }
  return availability.separate
    ? tabCommandCoordinator.separateSplit(targetSplit.id)
    : false;
}

function canStructurallySplit(ref: TabRef): boolean {
  return (
    !isTabStructurallyLocked(ref) &&
    tabSurfaceDescriptor(ref.kind).splitEligibility === "eligible"
  );
}

function closableSide(
  split: SplitStripItem | null,
  side: SplitSideName,
): TabRef | null {
  if (split === null) return null;
  const candidate = side === "left" ? split.left : split.right;
  if (candidate.kind !== "tab" || isTabCloseLocked(candidate.ref)) return null;
  return candidate.ref;
}
