/**
 * "A row moved on the Layout page → the next `panelGroups`", for both the
 * pointer and the keyboard path.
 *
 * Every function here composes the SAME pure `moveLeftPanel*` helpers the rail
 * commits through (`resolveLeftPanelGroupsForDrop` is their other caller), so
 * the settings list can only ever produce groupings the rail could produce
 * itself. Nothing writes; the caller applies the result with
 * `applyPanelGroups`, which normalizes and drops a structurally-unchanged
 * write.
 *
 * The one thing this layer adds is reading a boundary's MEANING from where it
 * sits. On the page a group is a card, so the boundary above a card's first
 * row is a group boundary (the panel lands as its own card) while a boundary
 * between two rows inside a card is an in-group one (the panel nests at that
 * index). Dropping onto a row combines, exactly as it does on the rail.
 */
import type { LeftPanelRailDropPosition } from "@/components/epic-canvas/dnd/dnd";
import {
  moveLeftPanelToGroup,
  moveLeftPanelToGroupPosition,
  moveLeftPanelToPanelPosition,
  type LeftPanelGroup,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";

interface SidebarPanelLocation {
  readonly groupIndex: number;
  readonly panelIndex: number;
  readonly groupSize: number;
}

/** The row menu's four actions, each enabled only when it changes something. */
export interface SidebarPanelRowActions {
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly canGroupWithPrevious: boolean;
  readonly canUngroup: boolean;
}

function locatePanel(
  groups: ReadonlyArray<LeftPanelGroup>,
  panelId: LeftPanelId,
): SidebarPanelLocation | null {
  const groupIndex = groups.findIndex((group) =>
    group.panelIds.includes(panelId),
  );
  if (groupIndex < 0) return null;
  const group = groups[groupIndex];
  return {
    groupIndex,
    panelIndex: group.panelIds.indexOf(panelId),
    groupSize: group.panelIds.length,
  };
}

export function sidebarPanelRowActions(
  groups: ReadonlyArray<LeftPanelGroup>,
  panelId: LeftPanelId,
): SidebarPanelRowActions {
  const location = locatePanel(groups, panelId);
  if (location === null) {
    return {
      canMoveUp: false,
      canMoveDown: false,
      canGroupWithPrevious: false,
      canUngroup: false,
    };
  }
  const { groupIndex, panelIndex, groupSize } = location;
  const nested = groupSize > 1;
  return {
    // The very first row of the very first card, alone in it, is already as
    // high as a panel goes; every other position has somewhere to move to -
    // one row up, or out of its card into the space above it.
    canMoveUp: nested || groupIndex > 0 || panelIndex > 0,
    canMoveDown:
      nested || groupIndex < groups.length - 1 || panelIndex < groupSize - 1,
    // Only the first row of a card can join the card above: every other row is
    // already grouped with the row above it.
    canGroupWithPrevious: groupIndex > 0 && panelIndex === 0,
    canUngroup: nested,
  };
}

/**
 * Whether a before/after boundary on this row is a GROUP boundary - the outer
 * edge of its card - rather than one between two rows inside it. The resolver
 * below and the row's drop indicator both ask this, so what the user is shown
 * and what the drop does cannot drift apart.
 */
export function isSidebarPanelGroupBoundary(
  groups: ReadonlyArray<LeftPanelGroup>,
  targetPanelId: LeftPanelId,
  position: "before" | "after",
): boolean {
  const target = locatePanel(groups, targetPanelId);
  if (target === null) return true;
  return position === "before"
    ? target.panelIndex === 0
    : target.panelIndex === target.groupSize - 1;
}

/**
 * A pointer drop, resolved against the boundary the pointer is nearest to.
 * Returns the groups unchanged for a drop that lands where the panel already
 * is; callers compare with `areLeftPanelGroupsEqual` to decide whether to draw
 * an indicator for it.
 */
export function resolveSidebarPanelDrop(
  groups: ReadonlyArray<LeftPanelGroup>,
  sourcePanelId: LeftPanelId,
  targetPanelId: LeftPanelId,
  position: LeftPanelRailDropPosition,
): ReadonlyArray<LeftPanelGroup> {
  if (sourcePanelId === targetPanelId) return groups;
  if (position === "combine") {
    return moveLeftPanelToGroup(groups, sourcePanelId, targetPanelId);
  }
  if (locatePanel(groups, targetPanelId) === null) return groups;
  return isSidebarPanelGroupBoundary(groups, targetPanelId, position)
    ? moveLeftPanelToGroupPosition(
        groups,
        sourcePanelId,
        targetPanelId,
        position,
      )
    : moveLeftPanelToPanelPosition(
        groups,
        sourcePanelId,
        targetPanelId,
        position,
      );
}

/**
 * One row up: within the card while there is a row above it there, out of the
 * card at its top edge, and past the card above once it is alone in its own -
 * the outcomes the equivalent drag lands on, resolved through the same
 * helpers. The exception is a two-panel card, where both interior boundaries
 * are no-ops for its own members: a keyboard swap there has no single drag
 * that matches it, only the un-nest-then-combine pair.
 */
export function moveSidebarPanelUp(
  groups: ReadonlyArray<LeftPanelGroup>,
  panelId: LeftPanelId,
): ReadonlyArray<LeftPanelGroup> {
  const location = locatePanel(groups, panelId);
  if (location === null) return groups;
  const group = groups[location.groupIndex];
  if (location.panelIndex > 0) {
    return moveLeftPanelToPanelPosition(
      groups,
      panelId,
      group.panelIds[location.panelIndex - 1],
      "before",
    );
  }
  if (location.groupSize > 1) {
    return moveLeftPanelToGroupPosition(groups, panelId, panelId, "before");
  }
  if (location.groupIndex === 0) return groups;
  return moveLeftPanelToGroupPosition(
    groups,
    panelId,
    groups[location.groupIndex - 1].panelIds[0],
    "before",
  );
}

export function moveSidebarPanelDown(
  groups: ReadonlyArray<LeftPanelGroup>,
  panelId: LeftPanelId,
): ReadonlyArray<LeftPanelGroup> {
  const location = locatePanel(groups, panelId);
  if (location === null) return groups;
  const group = groups[location.groupIndex];
  if (location.panelIndex < location.groupSize - 1) {
    return moveLeftPanelToPanelPosition(
      groups,
      panelId,
      group.panelIds[location.panelIndex + 1],
      "after",
    );
  }
  if (location.groupSize > 1) {
    return moveLeftPanelToGroupPosition(groups, panelId, panelId, "after");
  }
  if (location.groupIndex === groups.length - 1) return groups;
  return moveLeftPanelToGroupPosition(
    groups,
    panelId,
    groups[location.groupIndex + 1].panelIds[0],
    "after",
  );
}

/** Nest: append the panel to the card above, the drag's "drop onto a row". */
export function groupSidebarPanelWithPrevious(
  groups: ReadonlyArray<LeftPanelGroup>,
  panelId: LeftPanelId,
): ReadonlyArray<LeftPanelGroup> {
  const location = locatePanel(groups, panelId);
  if (location === null || location.groupIndex === 0) return groups;
  return moveLeftPanelToGroup(
    groups,
    panelId,
    groups[location.groupIndex - 1].panelIds[0],
  );
}

/**
 * Un-nest: the panel leaves its card and becomes its own, directly below the
 * one it left. A card that loses its last other member disappears with it -
 * the helper drops a group it empties - which is what "dragging the last
 * member out un-nests" means here.
 */
export function ungroupSidebarPanel(
  groups: ReadonlyArray<LeftPanelGroup>,
  panelId: LeftPanelId,
): ReadonlyArray<LeftPanelGroup> {
  return moveLeftPanelToGroupPosition(groups, panelId, panelId, "after");
}
