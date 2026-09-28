import type { ReactNode } from "react";
import { Rows2 } from "lucide-react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import type { SortableListItem } from "@/components/layout-editor/inspector/sortable-list";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import { regionFacts } from "@/components/layout-editor/regions/region-facts";
import {
  railPanelToStackBelow,
  removeRailDivider,
  stackRailPanelWithBelow,
  unstackRail,
  unstackRailPanel,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import { leftPanelIdForRailRegion, railStackMembers } from "@/lib/layout/rail";
import { expandJoinedPanelSections } from "@/stores/epics/left-panel-store";
import {
  regionValuesHidden,
  type LayoutValues,
} from "@/lib/layout/layout-values";
import type { RailRegionId, RegionId } from "@/lib/layout/region-id";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * What a sortable list's rows are BUILT from, apart from the components that
 * draw them: one row per region, divider or provider, in the order the
 * arrangement holds them.
 *
 * Separate from `order-group-list.tsx` because both hosts build rows and only
 * one of them is that component: the page's surface cards ask for the same
 * items for a list no drag reorders (L-95), and a builder module is also what
 * keeps the three copies of {@link BARE_ROW} down to one.
 */

/**
 * What the area form adds to a row of one of these lists: its one display
 * control, its revert, and a disclosure that opens its details
 * in place (L-95, L-89). One seam rather than five props, so the form
 * decorates a row without the list learning what an area is.
 */
export interface SortableRowDecoration {
  readonly hint: string | null;
  /** The row's ONE state control (L-121). */
  readonly control: ReactNode;
  /** The row's revert, drawn after its name. */
  readonly revert: ReactNode;
  readonly detail: ReactNode;
  readonly open: boolean;
  readonly onToggleOpen: (() => void) | null;
}

export type SortableRowDecorator = (id: string) => SortableRowDecoration;

/**
 * An undecorated row: what a host that decorates nothing leaves behind.
 *
 * Every builder below spreads the decoration FIRST and sets its own fields
 * after it (R1-21). The two key sets are disjoint today, so the order is
 * invisible - which is the point: a field added to
 * {@link SortableRowDecoration} that happens to share a builder's name would
 * otherwise overwrite what the builder had just decided, silently.
 */
export const BARE_ROW: SortableRowDecoration = {
  hint: null,
  control: null,
  revert: null,
  detail: null,
  open: false,
  onToggleOpen: null,
};

/** What every builder below sets unless it has a reason not to. */
const PLAIN_ROW = {
  glyph: null,
  divider: false,
  movable: true,
  onRemove: null,
  removeLabel: null,
  onStack: null,
  stackMembers: null,
} as const;

/**
 * Regions as rows, for a caller that has a list of them rather than an order
 * group - the Top bar, Chat and Status bar cards, whose regions sit in no list
 * a drag can reorder but are still rows of the same shape (L-95).
 */
export function regionRowItems<Id extends RegionId>(
  regionIds: ReadonlyArray<Id>,
  values: LayoutValues,
  decorate: SortableRowDecorator | null,
): ReadonlyArray<SortableListItem<Id>> {
  return regionIds.map((regionId) => regionRowItem(regionId, values, decorate));
}

export function regionRowItem<Id extends RegionId>(
  regionId: Id,
  values: LayoutValues,
  decorate: SortableRowDecorator | null,
): SortableListItem<Id> {
  const facts = regionFacts(regionId);
  return {
    ...(decorate === null ? BARE_ROW : decorate(regionId)),
    ...PLAIN_ROW,
    id: regionId,
    label: facts.name,
    icon: facts.icon,
    dimmed: regionValuesHidden(values[regionId]),
  };
}

/**
 * A rail PANEL as a row, with the one verb a rail row has that no other list's
 * row does: joining it to the panel below (L-168, L-181).
 *
 * Offered on the last panel of a stack (or a panel standing alone) whose next
 * entry is a panel, while the two stacks together stay within the cap. The
 * join moves no panel: the order before and after the press is identical,
 * which is the promise the list's gestures make (L-170). A button that refuses
 * every press is worse than no button, so where the join cannot be taken the
 * row offers none.
 */
export function railPanelOrderItem(
  regionId: RailRegionId,
  arrangement: LayoutArrangement,
  values: LayoutValues,
  decorate: SortableRowDecorator | null,
): SortableListItem<string> {
  const row = regionRowItem<RegionId>(regionId, values, decorate);
  const below = railPanelToStackBelow(arrangement.rail, regionId);
  return {
    ...row,
    onStack:
      below === null
        ? null
        : () => {
            writeArrangement(stackRailPanelWithBelow(arrangement, regionId));
            // A member joining a stack opens with its section showing (L-170):
            // a flag left over from a stack the user took apart has had no
            // control that could clear it since, so it must not come back.
            expandJoinedPanelSections(
              leftPanelIdForRailRegion(regionId),
              leftPanelIdForRailRegion(below),
            );
          },
  };
}

/**
 * A stack as a first-class row (L-168, L-181): it lists every member with its
 * own Unstack, and its Remove takes the whole stack apart, each exactly as a
 * divider's Remove is one write and one undo step.
 *
 * Not draggable, which is the one way it differs from a divider row: the
 * stack is not a member the user places, so it moves when its panels do and
 * the row offers no gesture that would write nothing.
 */
export function stackOrderItem(
  entryId: string,
  arrangement: LayoutArrangement,
): SortableListItem<string> {
  return {
    ...BARE_ROW,
    ...PLAIN_ROW,
    id: entryId,
    label: "Stack",
    icon: Rows2,
    movable: false,
    dimmed: false,
    onRemove: () => {
      writeArrangement(unstackRail(arrangement, entryId));
    },
    removeLabel: "Remove stack",
    stackMembers: (railStackMembers(entryId) ?? []).map((member) => ({
      id: member,
      label: regionFacts(member).name,
      onUnstack: () => {
        writeArrangement(unstackRailPanel(arrangement, member));
      },
    })),
  };
}

/**
 * A divider as a first-class row: draggable, and removable (L-155).
 *
 * "Divider" is the only name the user ever sees for it, and the row's Remove
 * button takes its accessible name from this label.
 */
export function dividerOrderItem(
  entryId: string,
  arrangement: LayoutArrangement,
): SortableListItem<string> {
  return {
    ...BARE_ROW,
    ...PLAIN_ROW,
    id: entryId,
    label: "Divider",
    icon: null,
    divider: true,
    dimmed: false,
    onRemove: () => {
      writeArrangement(removeRailDivider(arrangement, entryId));
    },
  };
}

/**
 * Usage providers as list rows, in the order given, each with its own logo.
 *
 * One builder for both of the Providers card's lists: the configured ones a
 * drag reorders, and the rest under Show all providers.
 */
export function providerOrderItems(
  providerIds: ReadonlyArray<RateLimitProviderId>,
  arrangement: LayoutArrangement,
  decorate: SortableRowDecorator | null,
): ReadonlyArray<SortableListItem<RateLimitProviderId>> {
  return providerIds.map((providerId) => ({
    ...(decorate === null ? BARE_ROW : decorate(providerId)),
    ...PLAIN_ROW,
    id: providerId,
    label: providerDisplayName(providerId),
    icon: null,
    glyph: <HarnessIcon harnessId={providerIdToGuiHarnessId(providerId)} />,
    dimmed: arrangement.hiddenProviders.includes(providerId),
  }));
}
