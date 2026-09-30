/**
 * `stripTaskRowOf` is the assignment table of the sectioned sidebar; the
 * strip's entries and their order are `use-strip-sections.test.tsx`'s.
 */
import { describe, expect, it } from "vitest";
import type { AgentActivityCoverage } from "@/lib/agent-activity";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import {
  selectNeedsYouItems,
  type NeedsYouItem,
} from "@/stores/notifications/needs-you-items";
import {
  EMPTY_NOTIFICATION_INDICATOR_STATE,
  type NotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";
import type { SideTabLiveAgents } from "../agent-meter";
import {
  promptEntriesOf,
  stripTaskRowOf,
  type StripSection,
} from "../strip-sections";

function indicator(
  flags: Partial<NotificationIndicatorState>,
): NotificationIndicatorState {
  return { ...EMPTY_NOTIFICATION_INDICATOR_STATE, ...flags };
}

function liveAgents(
  turn: number,
  background: number,
  coverage: AgentActivityCoverage,
): SideTabLiveAgents {
  return { turn, background, coverage };
}

function agents(turn: number, background: number): SideTabLiveAgents {
  return liveAgents(turn, background, "covered");
}

function promptRow(
  feedId: string,
  createdAt: number,
  epicId: string | null,
  kind: "approval" | "interview",
): MergedNotificationRow {
  return {
    feedId,
    source: "host",
    sourceId: feedId,
    createdAt,
    readAt: null,
    title: `Task of ${feedId}`,
    body: "",
    payload:
      kind === "interview"
        ? {
            kind: "interview",
            epicId: epicId ?? "unused",
            chatId: `chat-${feedId}`,
            interviewBlockId: undefined,
          }
        : {
            kind: "approval",
            epicId: epicId ?? undefined,
            chatId: `chat-${feedId}`,
            approvalId: feedId,
            sessionId: undefined,
            artifactId: undefined,
          },
    hostKind:
      kind === "interview" ? "interview.requested" : "approval.requested",
    appLocalKind: null,
    globalEntry: null,
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    sourceRef: feedId,
    originHostId: "host-a",
    providerPackAttribution: null,
    category: "task",
  };
}

/** Items newest first, the order the strip's one needs-you read gives. */
function items(rows: ReadonlyArray<MergedNotificationRow>): NeedsYouItem[] {
  return [...selectNeedsYouItems(rows, (row) => `Agent ${row.feedId}`)];
}

const NO_TIMES = { done: null, failed: null };

describe("stripTaskRowOf", () => {
  const CASES: ReadonlyArray<
    readonly [
      string,
      Partial<NotificationIndicatorState>,
      SideTabLiveAgents,
      StripSection,
    ]
  > = [
    [
      "a pending approval",
      { pendingApproval: true },
      agents(0, 0),
      "needs-you",
    ],
    [
      "a pending question",
      { pendingInterview: true },
      agents(0, 0),
      "needs-you",
    ],
    [
      "a pending approval over a running agent",
      { pendingApproval: true },
      agents(2, 0),
      "needs-you",
    ],
    [
      "a pending approval over an unread failure",
      { pendingApproval: true, unreadFailure: true },
      agents(0, 0),
      "needs-you",
    ],
    ["an unread failure", { unreadFailure: true }, agents(0, 0), "to-review"],
    ["an unread done", { unreadDone: true }, agents(0, 0), "to-review"],
    [
      "an unread done over a running agent",
      { unreadDone: true },
      agents(1, 0),
      "to-review",
    ],
    ["a running agent", {}, agents(1, 0), "working"],
    ["background work alone", {}, agents(0, 1), "working"],
    [
      "a pending fork, which is the host's business",
      { pendingFork: true },
      agents(0, 0),
      "idle",
    ],
    ["nothing at all", {}, agents(0, 0), "idle"],
    [
      "nothing on a plane that misses a machine",
      {},
      liveAgents(0, 0, "unserved"),
      "idle",
    ],
  ];

  it.each(CASES)("puts %s in %s", (_name, flags, live, section) => {
    expect(
      stripTaskRowOf({
        indicator: indicator(flags),
        agents: live,
        needsYou: [],
        reviewTimes: NO_TIMES,
      }).section,
    ).toBe(section);
  });

  it("names the reason the indicator gives when no prompt row is loaded, a reply first", () => {
    const row = stripTaskRowOf({
      indicator: indicator({ pendingApproval: true, pendingInterview: true }),
      agents: agents(0, 0),
      needsYou: [],
      reviewTimes: NO_TIMES,
    });

    expect(row).toEqual({
      section: "needs-you",
      reason: "reply",
      agentTitle: null,
      count: 0,
      createdAt: null,
    });
  });

  it("describes a task with several prompts by the oldest one and their count", () => {
    const row = stripTaskRowOf({
      indicator: indicator({ pendingApproval: true, pendingInterview: true }),
      agents: agents(0, 0),
      needsYou: items([
        promptRow("newest", 3_000, "epic-1", "interview"),
        promptRow("middle", 2_000, "epic-1", "approval"),
        promptRow("oldest", 1_000, "epic-1", "approval"),
      ]),
      reviewTimes: NO_TIMES,
    });

    expect(row).toEqual({
      section: "needs-you",
      reason: "approval",
      agentTitle: "Agent oldest",
      count: 3,
      createdAt: 1_000,
    });
  });

  it("times a failed task by its failure, not by a later done, and a done one by its done", () => {
    const reviewTimes = { done: 9_000, failed: 4_000 };

    expect(
      stripTaskRowOf({
        indicator: indicator({ unreadFailure: true, unreadDone: true }),
        agents: agents(0, 0),
        needsYou: [],
        reviewTimes,
      }),
    ).toEqual({ section: "to-review", outcome: "failed", at: 4_000 });
    expect(
      stripTaskRowOf({
        indicator: indicator({ unreadDone: true }),
        agents: agents(0, 0),
        needsYou: [],
        reviewTimes,
      }),
    ).toEqual({ section: "to-review", outcome: "done", at: 9_000 });
  });
});

describe("promptEntriesOf", () => {
  it("makes one entry per task with no row, each by its oldest prompt, then one per prompt naming no task", () => {
    const entries = promptEntriesOf(
      items([
        promptRow("orphan-new", 5_000, "epic-orphan", "approval"),
        promptRow("epic-less", 4_000, null, "approval"),
        promptRow("orphan-old", 1_000, "epic-orphan", "interview"),
      ]),
      new Set(),
    );

    expect(
      entries.map(({ item, row }) => ({
        feedId: item.row.feedId,
        reason: row.reason,
        count: row.count,
      })),
    ).toEqual([
      { feedId: "orphan-old", reason: "reply", count: 2 },
      { feedId: "epic-less", reason: "approval", count: 1 },
    ]);
  });
});
