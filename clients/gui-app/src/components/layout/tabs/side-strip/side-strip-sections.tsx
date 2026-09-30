import { useEffect, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useActiveHeaderTab } from "@/components/epic-canvas/dnd/dnd-store";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
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
import { SideTabGroupBlock } from "./side-tab-group-block";
import { SideTabGroupColumn } from "./side-tab-group-column";
import { SideTabGroupLabel } from "./side-tab-group-label";
import type { SideTabRowVariant } from "./side-tab-row";
import {
  SIDE_STRIP_RAIL_NEEDS_YOU_DOT_CLASS,
  SIDE_STRIP_RAIL_SECTION_SEPARATOR_CLASS,
  SIDE_TAB_HOVER_CLASS,
  SIDE_TAB_ROW_CLASS,
  SIDE_TAB_TWO_LINE_ROW_CLASS,
  SIDE_TAB_TWO_LINE_TRAILING_CLASS,
  SIDE_TAB_TITLE_CLASS,
} from "./side-strip-tokens";
import { StripNeedsYouPill } from "./strip-needs-you-pill";
import { StripRowMotion } from "./strip-row-motion";
import { StripSectionHeader } from "./strip-section-header";
import { useStripSectionFolded } from "./strip-section-fold";
import { holdInPlace, useStripSectionHolds } from "./strip-section-hold";
import { sectionStyleOf, twoLineStatusOf } from "./strip-section-row";
import {
  sectionSegmentsOf,
  sectionTaskCount,
  visualOrderOf,
  type StripPromptEntry,
  type StripSection,
  type StripSectionEntry,
  type StripSectionGroup,
  type StripTabEntry,
} from "./strip-sections";
import { useNeedsYouActivation } from "./use-needs-you-activation";
import { useNeedsYouAnnouncement } from "./use-needs-you-announcement";
import { useStripSections } from "./use-strip-sections";

/**
 * The Activity view's rows: each non-empty section under its header, its
 * tasks in the user's own order, a run of one group's tasks in that group's
 * block under a label, so a group across sections has a block in each. A
 * needs-you task with no tab in the strip follows the strip's tasks in Needs
 * you. The tabs' drawn order is published for the tab-number and next/previous
 * shortcuts, and numbers the Alt-digit badges.
 *
 * The rail draws the same sections as runs of tiles, a group's run in a column
 * of its own: a hairline between runs, Needs you marked by an amber dot, no
 * headers, so no fold, no pill, and no tile for a task with no tab (the
 * Notifications tile counts its prompt). It is this same component, so the
 * announcer, the holds and the drawn order carry across a collapse.
 *
 * A task that changes section slides there and glows, unless the pointer is on
 * its row or keyboard focus is, in which case it stays until the person leaves
 * it. Arrivals in Needs you are announced, and the "↑ N need you" pill floats
 * while that section's header is out of view.
 */
export function SideStripSections(props: {
  readonly controller: TabStripController;
  readonly handlers: SideStripHandlers;
  readonly variant: SideTabRowVariant;
  /** The list's scroller, which holds the rows' frames. */
  readonly scroller: HTMLElement | null;
  readonly needsYouAbove: boolean;
}): ReactNode {
  const { controller, handlers, variant, scroller, needsYouAbove } = props;
  const assigned = useStripSections(controller);
  const holds = useStripSectionHolds(scroller);
  const sections = useMemo(
    () => holdInPlace(assigned, holds),
    [assigned, holds],
  );
  const announcement = useNeedsYouAnnouncement(assigned);
  const slide = useMotionEnabled();
  const { keys, offsets } = useMemo(() => visualOrderOf(sections), [sections]);
  const placements = useMemo(
    () =>
      new Map(
        sections.flatMap((group) =>
          group.entries.flatMap((entry) =>
            entry.kind === "tabs"
              ? [[entry.itemId, group.section] as const]
              : [],
          ),
        ),
      ),
    [sections],
  );
  useEffect(() => {
    useTabVisualOrderStore.setState({ keys });
    return () => {
      useTabVisualOrderStore.setState({ keys: null });
    };
  }, [keys]);
  const needsYou = sections.find((group) => group.section === "needs-you");
  const drawn =
    variant === "collapsed"
      ? sections.filter((group) =>
          group.entries.some((entry) => entry.kind === "tabs"),
        )
      : sections;
  return (
    <>
      {needsYouAbove && scroller !== null && needsYou !== undefined ? (
        <StripNeedsYouPill
          scroller={scroller}
          count={sectionTaskCount(needsYou)}
        />
      ) : null}
      <StripRowMotion scroller={scroller} placements={placements} slide={slide}>
        {drawn.map((group, index) => (
          <StripSectionRows
            key={group.section}
            group={group}
            variant={variant}
            separated={index > 0}
            memberOffsets={offsets}
            controller={controller}
            handlers={handlers}
          />
        ))}
      </StripRowMotion>
      {/* Outside the tablist, which holds only tabs, headers and the rail's
          marks. A live region has to be in the page before it speaks; `id`
          makes the same words said twice two announcements. */}
      {createPortal(
        <span
          role="status"
          aria-live="polite"
          data-testid="strip-needs-you-announcement"
          className="sr-only"
        >
          <span key={announcement.id}>{announcement.text}</span>
        </span>,
        document.body,
      )}
    </>
  );
}

function StripSectionRows(props: {
  readonly group: StripSectionGroup;
  readonly variant: SideTabRowVariant;
  /** A run of the rail after another: a hairline parts them. */
  readonly separated: boolean;
  /** Tabs drawn before each item, for its Alt-digit badge. */
  readonly memberOffsets: ReadonlyMap<string, number>;
  readonly controller: TabStripController;
  readonly handlers: SideStripHandlers;
}): ReactNode {
  const { group, variant, memberOffsets, controller, handlers } = props;
  const rail = variant === "collapsed";
  const [folded] = useStripSectionFolded(group.section);
  const draggedItemId = useActiveHeaderTab()?.stripItemId ?? null;
  const tabEntries = group.entries.filter(
    (entry): entry is StripTabEntry => entry.kind === "tabs",
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
  // where they are; the header's count is still the whole section's. The rail
  // has no header to fold from, so it draws every tile.
  let shown: ReadonlyArray<StripSectionEntry> = group.entries;
  if (rail) {
    shown = tabEntries;
  } else if (folded) {
    shown = group.entries.filter(
      (entry) =>
        entry.kind === "tabs" && entry.itemId === controller.activeItemId,
    );
  }
  // A grouped task sits in its group's block or column, which carries the colour.
  const row = (entry: StripSectionEntry): ReactNode =>
    entry.kind === "tabs" ? (
      <SideStripItem
        key={entry.itemId}
        itemId={entry.itemId}
        stripIndex={entry.stripIndex}
        offset={controller.offsets.get(entry.itemId) ?? 0}
        memberOffset={memberOffsets.get(entry.itemId) ?? 0}
        isActive={entry.itemId === controller.activeItemId}
        dropIndicator={dropIndicatorOfEntry(entry, tabEntries.indexOf(entry))}
        variant={variant}
        inBlock={entry.group !== null}
        lane={group.section}
        members={entry.members}
        handlers={handlers}
      />
    ) : (
      <StripPromptRow key={entry.item.row.feedId} entry={entry} />
    );
  return (
    <>
      {rail ? (
        <RailSectionMarks section={group.section} separated={props.separated} />
      ) : (
        <StripSectionHeader
          section={group.section}
          count={sectionTaskCount(group)}
        />
      )}
      {sectionSegmentsOf(shown, group).map((segment) => {
        if (segment.kind === "entry") return row(segment.entry);
        const members = segment.entries.map((entry) => row(entry));
        return rail ? (
          <SideTabGroupColumn
            key={segment.key}
            groupId={segment.group.id}
            color={segment.group.color}
          >
            {members}
          </SideTabGroupColumn>
        ) : (
          <SideTabGroupBlock
            key={segment.key}
            groupId={segment.group.id}
            color={segment.group.color}
            collapsed={null}
            header={
              <SideTabGroupLabel
                groupId={segment.group.id}
                name={segment.group.name}
                count={segment.count}
              />
            }
          >
            {members}
          </SideTabGroupBlock>
        );
      })}
    </>
  );
}

/**
 * What parts the rail's runs of tiles: a 24px hairline before every run but
 * the first, and Needs you's amber dot over its tiles. Decoration only: the
 * tiles carry their own names.
 */
function RailSectionMarks(props: {
  readonly section: StripSection;
  readonly separated: boolean;
}): ReactNode {
  return (
    <>
      {props.separated ? (
        <span
          aria-hidden
          data-testid="side-strip-rail-section-separator"
          className={SIDE_STRIP_RAIL_SECTION_SEPARATOR_CLASS}
        />
      ) : null}
      {props.section === "needs-you" ? (
        <span
          aria-hidden
          data-testid="side-strip-rail-needs-you-dot"
          className={SIDE_STRIP_RAIL_NEEDS_YOU_DOT_CLASS}
        />
      ) : null}
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
        SIDE_TAB_TWO_LINE_ROW_CLASS,
        SIDE_TAB_HOVER_CLASS,
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            SIDE_TAB_TITLE_CLASS,
            "header-tab-title-text font-semibold",
          )}
        >
          {displayTitle(entry.item.taskTitle, "epic")}
        </span>
        {sectionStyleOf(entry.row).detail}
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center",
          SIDE_TAB_TWO_LINE_TRAILING_CLASS,
        )}
      >
        {wait?.node}
      </span>
    </button>
  );
}
