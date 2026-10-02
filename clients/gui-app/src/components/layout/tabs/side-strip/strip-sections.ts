import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import {
  groupNeedsYouByEpic,
  type NeedsYouItem,
  type NeedsYouReason,
} from "@/stores/notifications/needs-you-items";
import { tabRefKey } from "@/stores/tabs/layout";
import type { HeaderTab } from "@/stores/tabs/types";
import type { SideTabLiveAgents } from "./agent-meter";
import { railBadgeOf } from "./rail-badge-kind";
import type { StripItemGroup } from "./strip-item-tabs";

/** What a task needs from the person, most urgent first. */
export type StripSection = "needs-you" | "to-review" | "working" | "idle";

/** Each section's name, as its header and the layout editor's pictures read it. */
export const STRIP_SECTION_LABEL: Readonly<Record<StripSection, string>> = {
  "needs-you": "Needs you",
  "to-review": "To review",
  working: "Working",
  idle: "Idle",
};

/** The Activity view's sections in the order it draws them. */
const STRIP_SECTIONS: ReadonlyArray<StripSection> = [
  "needs-you",
  "to-review",
  "working",
  "idle",
];

/** The one word a request asks of the person. */
export const NEEDS_YOU_VERB: Readonly<Record<NeedsYouReason, string>> = {
  approval: "Approve",
  reply: "Reply",
};

/** How an unread task finished. */
export type ReviewOutcome = "done" | "failed";

/**
 * The prompts waiting on the person in one task: the oldest one's reason,
 * agent and time, and how many there are. `createdAt` is `null` when the
 * indicator says the task is waiting but no prompt row is loaded for it.
 */
export interface NeedsYouRow {
  readonly section: "needs-you";
  readonly reason: NeedsYouReason;
  readonly agentTitle: string | null;
  readonly count: number;
  readonly createdAt: number | null;
}

/** An unread outcome; `at` is its latest unread notification row's time. */
export interface ToReviewRow {
  readonly section: "to-review";
  readonly outcome: ReviewOutcome;
  readonly at: number | null;
}

/** A task with a live agent: the tiers the trailing glyph or meter draws. */
export interface WorkingRow {
  readonly section: "working";
  readonly agents: SideTabLiveAgents;
}

/** Nothing live and nothing unread; `agents.coverage` says whether idle is known. */
export interface IdleRow {
  readonly section: "idle";
  readonly agents: SideTabLiveAgents;
}

/** What one task's row needs to draw, by the section it is in. */
export type StripTaskRow = NeedsYouRow | ToReviewRow | WorkingRow | IdleRow;

/** The times of a task's latest unread notification row of each outcome. */
export type ReviewTimes = Readonly<Record<ReviewOutcome, number | null>>;

/** The oldest prompt, whose request the person has waited on longest. */
function oldestNeedsYouItem(
  items: ReadonlyArray<NeedsYouItem>,
): NeedsYouItem | null {
  if (items.length === 0) return null;
  return items.reduce((oldest, item) =>
    item.createdAt <= oldest.createdAt ? item : oldest,
  );
}

export function needsYouRowOf(
  items: ReadonlyArray<NeedsYouItem>,
  fallback: NeedsYouReason,
): NeedsYouRow {
  const oldest = oldestNeedsYouItem(items);
  return {
    section: "needs-you",
    reason: oldest?.reason ?? fallback,
    agentTitle: oldest?.agentTitle ?? null,
    count: items.length,
    createdAt: oldest?.createdAt ?? null,
  };
}

/**
 * The section a task is in, by its most urgent state, with the data its row
 * draws: waiting on the person, then an unread failure or done, then a live
 * agent, else idle.
 */
export function stripTaskRowOf(input: {
  readonly indicator: NotificationIndicatorState;
  readonly agents: SideTabLiveAgents;
  readonly needsYou: ReadonlyArray<NeedsYouItem>;
  readonly reviewTimes: ReviewTimes;
}): StripTaskRow {
  const badge = railBadgeOf(input.indicator);
  switch (badge) {
    case "reply":
    case "approval":
      return needsYouRowOf(input.needsYou, badge);
    case "failed":
      return {
        section: "to-review",
        outcome: "failed",
        at: input.reviewTimes.failed,
      };
    case "unread":
      return {
        section: "to-review",
        outcome: "done",
        at: input.reviewTimes.done,
      };
    case null:
      return input.agents.turn + input.agents.background > 0
        ? { section: "working", agents: input.agents }
        : { section: "idle", agents: input.agents };
  }
}

/** The more urgent of two sections, which a split pair is placed by. */
export function moreUrgentSection(
  a: StripSection,
  b: StripSection,
): StripSection {
  return STRIP_SECTIONS.indexOf(a) <= STRIP_SECTIONS.indexOf(b) ? a : b;
}

/** One tab of an entry, read on its own. */
export interface StripTabMember {
  readonly tab: HeaderTab;
  readonly row: StripTaskRow;
}

/** One tab, or the two halves of a split pair. */
export interface StripTabEntry {
  readonly kind: "tabs";
  /** The strip item's id: the entry's key and its drag unit. */
  readonly itemId: string;
  /** The item's index in the strip. */
  readonly stripIndex: number;
  /** The more urgent half's section. */
  readonly section: StripSection;
  /** The tab group the item is in; `null` for an ungrouped item. */
  readonly group: StripItemGroup | null;
  readonly members: ReadonlyArray<StripTabMember>;
}

/** A task with no row in the strip whose prompts are waiting on the person. */
export interface StripPromptEntry {
  readonly kind: "prompt";
  readonly section: "needs-you";
  /** The oldest prompt: its `row` opens the chat, its `taskTitle` names it. */
  readonly item: NeedsYouItem;
  readonly row: NeedsYouRow;
}

export type StripSectionEntry = StripTabEntry | StripPromptEntry;

export interface StripSectionGroup {
  readonly section: StripSection;
  readonly entries: ReadonlyArray<StripSectionEntry>;
}

/** What a section draws in order: an entry of no group, or one group's run of tasks. */
export type SectionSegment =
  | { readonly kind: "entry"; readonly entry: StripSectionEntry }
  | {
      readonly kind: "group";
      /** The run's first item, which keys it. */
      readonly key: string;
      readonly group: StripItemGroup;
      readonly entries: Array<StripTabEntry>;
    };

/**
 * The entries a section draws, each run of one group's tasks in a segment of
 * its own.
 */
export function sectionSegmentsOf(
  shown: ReadonlyArray<StripSectionEntry>,
): ReadonlyArray<SectionSegment> {
  const segments: Array<SectionSegment> = [];
  for (const entry of shown) {
    const last = segments.at(-1);
    if (entry.kind !== "tabs" || entry.group === null) {
      segments.push({ kind: "entry", entry });
    } else if (last?.kind === "group" && last.group.id === entry.group.id) {
      last.entries.push(entry);
    } else {
      const { group } = entry;
      segments.push({
        kind: "group",
        key: entry.itemId,
        group,
        entries: [entry],
      });
    }
  }
  return segments;
}

/**
 * How many tasks a section lists: a split pair once, as it is one row, and a
 * task with no row once. Every count of a section in the sidebar is this one.
 */
export function sectionTaskCount(group: StripSectionGroup): number {
  return group.entries.length;
}

/** How many tasks need the person: the Needs you section's count, 0 without one. */
export function needsYouTaskCountOf(
  sections: ReadonlyArray<StripSectionGroup>,
): number {
  const needsYou = sections.find((group) => group.section === "needs-you");
  return needsYou === undefined ? 0 : sectionTaskCount(needsYou);
}

/**
 * The Needs you entries for prompts whose task has no row in the strip: one
 * per task, then any prompt that names no task on its own.
 */
export function promptEntriesOf(
  rowless: ReadonlyArray<NeedsYouItem>,
): ReadonlyArray<StripPromptEntry> {
  const byEpic = groupNeedsYouByEpic(rowless);
  const named = new Set([...byEpic.values()].flat());
  const groups = [
    ...byEpic.values(),
    ...rowless.filter((item) => !named.has(item)).map((item) => [item]),
  ];
  return groups.flatMap((items): ReadonlyArray<StripPromptEntry> => {
    const oldest = oldestNeedsYouItem(items);
    return oldest === null
      ? []
      : [
          {
            kind: "prompt",
            section: "needs-you",
            item: oldest,
            row: needsYouRowOf(items, oldest.reason),
          },
        ];
  });
}

/** What one tab of a sectioned strip draws; `null` while the strip is not sectioned. */
export function memberRowOf(
  members: ReadonlyArray<StripTabMember> | null,
  tab: HeaderTab | null,
): StripTaskRow | null {
  if (members === null || tab === null) return null;
  return (
    members.find(
      (member) => member.tab.kind === tab.kind && member.tab.id === tab.id,
    )?.row ?? null
  );
}

/**
 * The strip's tabs in the order the sections draw them: each tab's key, and
 * how many tabs come before each item, which the Alt-digit badges count from.
 */
export function visualOrderOf(sections: ReadonlyArray<StripSectionGroup>): {
  readonly keys: ReadonlyArray<string>;
  readonly offsets: ReadonlyMap<string, number>;
} {
  const keys: string[] = [];
  const offsets = new Map<string, number>();
  for (const { entries } of sections) {
    for (const entry of entries) {
      if (entry.kind !== "tabs") continue;
      offsets.set(entry.itemId, keys.length);
      keys.push(...entry.members.map((member) => tabRefKey(member.tab)));
    }
  }
  return { keys, offsets };
}

/**
 * The entries grouped by section in the fixed order, each keeping the order
 * it came in; an empty section is left out.
 */
export function groupEntriesBySection(
  entries: ReadonlyArray<StripSectionEntry>,
): ReadonlyArray<StripSectionGroup> {
  return STRIP_SECTIONS.flatMap((section) => {
    const inSection = entries.filter((entry) => entry.section === section);
    return inSection.length === 0 ? [] : [{ section, entries: inSection }];
  });
}
