import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import type { TabSplitCommandId } from "@/stores/tabs/tab-split-commands";
import type { HeaderTab } from "@/stores/tabs/types";
import { taskPinReadOf } from "../tab-strip-rows";
import type {
  HeaderTabDndConfig,
  StripTabItemInput,
} from "../use-strip-tab-item";
import type { SideTabRowVariant } from "./side-tab-row";
import type { StripSection, StripTabMember } from "./strip-sections";

/** Where a drop would land relative to one row. */
export type DropIndicator = "before" | "after" | null;

/** The insertion line on the row it lands before, or after the last row. */
export function dropIndicatorOf(
  dropIndex: number | null,
  stripIndex: number,
  lastIndex: number,
): DropIndicator {
  if (dropIndex === stripIndex) return "before";
  if (dropIndex === stripIndex + 1 && stripIndex === lastIndex) return "after";
  return null;
}

/** The controller's per-tab handlers and pin reads every row takes. */
export interface SideStripHandlers {
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
}

export interface SideStripItemProps {
  readonly itemId: string;
  readonly stripIndex: number;
  /** The drag model's displacement along y. */
  readonly offset: number;
  /** Tab members before this item; drives the Alt-digit badges. */
  readonly memberOffset: number;
  readonly isActive: boolean;
  readonly dropIndicator: DropIndicator;
  readonly variant: SideTabRowVariant;
  readonly groupLine: string | null;
  /**
   * The Activity view's section this item is in, which is also the lane it
   * drags in: a drop outside it is never offered. `null` in the Layered view.
   */
  readonly lane: StripSection | null;
  /** What each of the item's tabs draws in that section; `null` in the Layered view. */
  readonly members: ReadonlyArray<StripTabMember> | null;
  readonly handlers: SideStripHandlers;
}

/** Where one tab sits in the vertical strip, and whether it is active. */
export interface SideStripTabPlacement {
  readonly tab: HeaderTab;
  readonly index: number;
  readonly dnd: HeaderTabDndConfig;
  readonly isActive: boolean;
}

/** The per-tab hook's input for one tab in the vertical strip. */
export function stripTabItemInputOf(
  placement: SideStripTabPlacement,
  handlers: SideStripHandlers,
): StripTabItemInput {
  const pinRead = taskPinReadOf(
    placement.tab,
    handlers.taskPinnedStates,
    handlers.pendingSetPinnedEpicIds,
  );
  return {
    tab: placement.tab,
    index: placement.index,
    dnd: placement.dnd,
    isActive: placement.isActive,
    onClose: handlers.onClose,
    onCloseOtherTabs: handlers.onCloseOtherTabs,
    canCloseOtherTabs: handlers.canCloseOtherTabs,
    onDuplicateTab: handlers.onDuplicateTab,
    onOpenInNewWindow: handlers.onOpenInNewWindow,
    canOpenInNewWindow: handlers.canOpenInNewWindow,
    onSplitCommand: handlers.onSplitCommand,
    taskPinnedState: pinRead.taskPinnedState,
    isTaskPinPending: pinRead.isTaskPinPending,
    onSetTaskPinned: handlers.onSetTaskPinned,
    onTaskPinMenuOpen: handlers.onTaskPinMenuOpen,
  };
}
