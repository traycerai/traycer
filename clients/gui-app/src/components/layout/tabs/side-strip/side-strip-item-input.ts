import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import type { TabSplitCommandId } from "@/stores/tabs/tab-split-commands";
import type { HeaderTab } from "@/stores/tabs/types";
import { taskPinReadOf } from "../tab-strip-rows";
import type {
  HeaderTabDndConfig,
  StripTabItemInput,
} from "../use-strip-tab-item";
import type { SideTabRowVariant } from "./side-tab-row";

/** Where a drop would land relative to one row. */
export type DropIndicator = "before" | "after" | null;

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
