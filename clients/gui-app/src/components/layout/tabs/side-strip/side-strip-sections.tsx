import { useEffect, useMemo, type ReactNode } from "react";
import { useActiveHeaderTab } from "@/components/epic-canvas/dnd/dnd-store";
import { displayTitle } from "@/lib/display-title";
import { cn } from "@/lib/utils";
import { useTabVisualOrderStore } from "@/stores/tabs/tab-visual-order-store";
import type { TabStripController } from "../tab-strip-controller";
import {
  dropIndicatorOf,
  type DropIndicator,
  type SideStripHandlers,
} from "./side-strip-item-input";
import { SideStripItem } from "./side-strip-item";
import {
  SIDE_TAB_HOVER_CLASS,
  SIDE_TAB_ROW_CLASS,
  SIDE_TAB_SECTION_ROW_CLASS,
  SIDE_TAB_TITLE_CLASS,
} from "./side-strip-tokens";
import { StripSectionHeader } from "./strip-section-header";
import { useStripSectionFolded } from "./strip-section-fold";
import { sectionStyleOf, twoLineStatusOf } from "./strip-section-row";
import {
  visualOrderOf,
  type StripPromptEntry,
  type StripSectionEntry,
  type StripSectionGroup,
  type StripTabEntry,
} from "./strip-sections";
import { useNeedsYouActivation } from "./use-needs-you-activation";
import { useStripSections } from "./use-strip-sections";

/**
 * The Activity view's rows: each non-empty section under its header, its
 * tasks in the user's own order, every tab group flattened. A needs-you task
 * with no tab in the strip follows the strip's tasks in Needs you. The tabs'
 * drawn order is published for the tab-number and next/previous shortcuts,
 * and numbers the Alt-digit badges.
 */
export function SideStripSections(props: {
  readonly controller: TabStripController;
  readonly handlers: SideStripHandlers;
}): ReactNode {
  const { controller, handlers } = props;
  const sections = useStripSections(controller);
  const { keys, offsets } = useMemo(() => visualOrderOf(sections), [sections]);
  useEffect(() => {
    useTabVisualOrderStore.setState({ keys });
    return () => {
      useTabVisualOrderStore.setState({ keys: null });
    };
  }, [keys]);
  return sections.map((group) => (
    <StripSectionRows
      key={group.section}
      group={group}
      memberOffsets={offsets}
      controller={controller}
      handlers={handlers}
    />
  ));
}

function StripSectionRows(props: {
  readonly group: StripSectionGroup;
  /** Tabs drawn before each item, for its Alt-digit badge. */
  readonly memberOffsets: ReadonlyMap<string, number>;
  readonly controller: TabStripController;
  readonly handlers: SideStripHandlers;
}): ReactNode {
  const { group, memberOffsets, controller, handlers } = props;
  const [folded] = useStripSectionFolded(group.section);
  const draggedItemId = useActiveHeaderTab()?.stripItemId ?? null;
  const tabEntries = group.entries.filter(
    (entry): entry is StripTabEntry => entry.kind === "tabs",
  );
  const taskCount = group.entries.reduce(
    (count, entry) =>
      count + (entry.kind === "tabs" ? entry.members.length : 1),
    0,
  );
  // A tab dragged inside this section reorders among its tabs, so its drop
  // index counts them and no other section shows a line. Any other drag (a tile
  // dropped on the strip) lands by strip index.
  const dropIndicatorOfEntry = (
    entry: StripTabEntry,
    position: number,
  ): DropIndicator => {
    if (draggedItemId === null) {
      return dropIndicatorOf(
        controller.dropIndicatorIndex,
        entry.stripIndex,
        controller.headerItemIds.length - 1,
      );
    }
    return tabEntries.some((tab) => tab.itemId === draggedItemId)
      ? dropIndicatorOf(
          controller.dropIndicatorIndex,
          position,
          tabEntries.length - 1,
        )
      : null;
  };
  // A folded section keeps the current task's row, so the person still sees
  // where they are; the header's count is still the whole section's.
  const shown = folded
    ? group.entries.filter(
        (entry) =>
          entry.kind === "tabs" && entry.itemId === controller.activeItemId,
      )
    : group.entries;
  return (
    <>
      <StripSectionHeader section={group.section} count={taskCount} />
      {shown.map((entry: StripSectionEntry) =>
        entry.kind === "tabs" ? (
          <SideStripItem
            key={entry.itemId}
            itemId={entry.itemId}
            stripIndex={entry.stripIndex}
            offset={controller.offsets.get(entry.itemId) ?? 0}
            memberOffset={memberOffsets.get(entry.itemId) ?? 0}
            isActive={entry.itemId === controller.activeItemId}
            dropIndicator={dropIndicatorOfEntry(
              entry,
              tabEntries.indexOf(entry),
            )}
            variant="expanded"
            groupLine={entry.groupColor}
            lane={group.section}
            members={entry.members}
            handlers={handlers}
          />
        ) : (
          <StripPromptRow key={entry.item.row.feedId} entry={entry} />
        ),
      )}
    </>
  );
}

/**
 * A needs-you task with no tab in the strip, drawn as a Needs you row of its
 * own. It opens the chat on its pending card through the notification's own
 * activation; nothing is approved or answered here.
 */
function StripPromptRow(props: {
  readonly entry: StripPromptEntry;
}): ReactNode {
  const { entry } = props;
  const onActivate = useNeedsYouActivation();
  const wait = twoLineStatusOf(entry.row, null);
  return (
    <button
      type="button"
      data-testid="strip-needs-you-prompt"
      data-notification-id={entry.item.row.feedId}
      data-needs-you-reason={entry.item.reason}
      onClick={() => {
        onActivate(entry.item.row);
      }}
      className={cn(
        "group/side-tab flex items-center text-start text-foreground outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 [-webkit-app-region:no-drag]",
        SIDE_TAB_ROW_CLASS,
        SIDE_TAB_SECTION_ROW_CLASS.twoLine,
        SIDE_TAB_HOVER_CLASS,
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn(SIDE_TAB_TITLE_CLASS, "truncate font-semibold")}>
          {displayTitle(entry.item.taskTitle, "epic")}
        </span>
        {sectionStyleOf(entry.row).detail}
      </span>
      <span className="mt-1 flex shrink-0 items-center self-start">
        {wait?.node}
      </span>
    </button>
  );
}
