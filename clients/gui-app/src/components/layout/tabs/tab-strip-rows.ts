import type { StripItem } from "@/stores/tabs/layout";
import {
  stripItemGroupId,
  type TabCustomizations,
  type TabGroup,
  type TabGroups,
} from "@/stores/tabs/tab-groups";
import type { HeaderTab } from "@/stores/tabs/types";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";

/** A tab group that begins at this strip item. */
export interface StripRowGroupStart {
  readonly groupId: string;
  readonly group: TabGroup;
}

/** One strip item as every presentation walks it, independent of layout. */
export interface StripRow {
  readonly itemId: string;
  /** The item's index in the strip: its drop slot and reorder position. */
  readonly stripIndex: number;
  /** Tab members before this item; a split counts each tab half. */
  readonly memberOffset: number;
  /** Set on the first item of a group, where the group header draws. */
  readonly groupStart: StripRowGroupStart | null;
  /** The group this item belongs to, on every member of it. */
  readonly group: StripRowGroupStart | null;
  /** A member of a collapsed group, drawn under its header only. */
  readonly hidden: boolean;
}

/**
 * Walks the strip's items once, pairing each with its group boundary, its
 * collapsed state and the member offset the Alt-digit badges count from.
 * `headerItemIds` and `layoutItems` are index-aligned.
 */
export function stripRowsOf(
  headerItemIds: ReadonlyArray<string>,
  layoutItems: ReadonlyArray<StripItem>,
  groups: TabGroups | undefined,
  customizations: TabCustomizations | undefined,
): ReadonlyArray<StripRow> {
  const rows: Array<StripRow> = [];
  let memberOffset = 0;
  let previousGroupId: string | null = null;
  headerItemIds.forEach((itemId, stripIndex) => {
    const layoutItem = layoutItems.at(stripIndex);
    const groupId =
      layoutItem === undefined
        ? null
        : stripItemGroupId(layoutItem, customizations);
    const group = groupId === null ? undefined : groups?.[groupId];
    const firstInGroup = groupId !== null && previousGroupId !== groupId;
    const membership =
      groupId !== null && group !== undefined ? { groupId, group } : null;
    rows.push({
      itemId,
      stripIndex,
      memberOffset,
      groupStart: firstInGroup ? membership : null,
      group: membership,
      hidden: group?.collapsed === true,
    });
    previousGroupId = groupId;
    memberOffset += layoutItem === undefined ? 0 : tabMemberCount(layoutItem);
  });
  return rows;
}

function tabMemberCount(item: StripItem): number {
  if (item.kind === "tab") return 1;
  return Number(item.left.kind === "tab") + Number(item.right.kind === "tab");
}

/** The pin facts one tab reads from the strip's batched pin state. */
export interface TaskPinRead {
  readonly taskPinnedState: TaskPinnedState | null;
  readonly isTaskPinPending: boolean;
}

export function taskPinReadOf(
  tab: HeaderTab,
  taskPinnedStates: ReadonlyMap<string, TaskPinnedState>,
  pendingSetPinnedEpicIds: ReadonlySet<string>,
): TaskPinRead {
  if (tab.kind !== "epic") {
    return { taskPinnedState: null, isTaskPinPending: false };
  }
  return {
    taskPinnedState: taskPinnedStates.get(tab.epicId) ?? null,
    isTaskPinPending: pendingSetPinnedEpicIds.has(tab.epicId),
  };
}
