import { describe, expect, it } from "vitest";
import type { BotActivity } from "@traycer/protocol/host/bot/schemas";
import type { EpicAgentActivity } from "@/lib/agent-activity";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { MIX_TUNING } from "../mix-tuning";
import {
  agentTurnsInFlight,
  botTurnsInFlight,
  feedSignalsOfRows,
  nextDoneExpiry,
  soundtrackViewOfLocation,
} from "../signals";

const NOW = 1_700_000_000_000;
const WINDOW = MIX_TUNING.doneWindowMs;

type Row = Pick<
  MergedNotificationRow,
  "source" | "severity" | "readAt" | "botAnswer" | "createdAt"
>;

function rowOf(overrides: Partial<Row>): Row {
  return {
    source: "host",
    severity: "done",
    readAt: null,
    botAnswer: false,
    createdAt: NOW,
    ...overrides,
  };
}

function activityOf(turn: readonly string[]): EpicAgentActivity {
  return { working: new Set<string>(), turn: new Set(turn) };
}

describe("soundtrackViewOfLocation", () => {
  it.each([
    { pathname: "/", view: "home" },
    { pathname: "/draft/draft-1", view: "home" },
    { pathname: "/epics", view: "home" },
    { pathname: "/epics/epic-1/tab-1", view: "task" },
    { pathname: "/bot", view: "bot" },
    { pathname: "/bot/bot-1", view: "bot" },
    { pathname: "/settings/general", view: "settings" },
  ])("reads $pathname as $view", ({ pathname, view }) => {
    expect(soundtrackViewOfLocation(pathname, false)).toBe(view);
  });

  it("puts the settings overlay in front of the page beneath it", () => {
    expect(soundtrackViewOfLocation("/epics/epic-1/tab-1", true)).toBe(
      "settings",
    );
  });
});

describe("feedSignalsOfRows", () => {
  it("counts a blocking or failure row while it is unread, and not once it is read", () => {
    const rows = [
      rowOf({ severity: "needs_action" }),
      rowOf({ severity: "needs_action", readAt: NOW }),
      rowOf({ severity: "failure" }),
      rowOf({ severity: "failure" }),
      rowOf({ severity: "failure", readAt: NOW }),
    ];
    expect(feedSignalsOfRows(rows, NOW)).toEqual({
      blocking: 1,
      failure: 2,
      done: 0,
    });
  });

  it("leaves out an unread row of the global feed, which never asks for attention", () => {
    const rows = [rowOf({ source: "global", severity: "needs_action" })];
    expect(feedSignalsOfRows(rows, NOW).blocking).toBe(0);
  });

  it("counts a done row inside the window, read or not, and not one outside it", () => {
    const rows = [
      rowOf({ createdAt: NOW - 1000 }),
      rowOf({ createdAt: NOW - WINDOW + 1, readAt: NOW }),
      rowOf({ createdAt: NOW - WINDOW }),
      rowOf({ createdAt: NOW - WINDOW - 5000 }),
    ];
    expect(feedSignalsOfRows(rows, NOW).done).toBe(2);
  });

  it("counts a done row a little ahead of this clock and not one far ahead of it", () => {
    const rows = [
      rowOf({ createdAt: NOW + 5000 }),
      rowOf({ createdAt: NOW + WINDOW }),
      rowOf({ createdAt: NOW + 60 * 60_000 }),
    ];
    expect(feedSignalsOfRows(rows, NOW).done).toBe(1);
  });
});

describe("nextDoneExpiry", () => {
  it("is when the done row nearest to leaving stops counting", () => {
    const rows = [
      rowOf({ createdAt: NOW - 10_000 }),
      rowOf({ createdAt: NOW - 70_000 }),
      rowOf({ severity: "failure", createdAt: NOW - 80_000 }),
    ];
    expect(nextDoneExpiry(rows, NOW)).toBe(NOW - 70_000 + WINDOW);
  });

  it("is null while none counts, whether too old or too far ahead", () => {
    const rows = [
      rowOf({ createdAt: NOW - WINDOW }),
      rowOf({ createdAt: NOW + WINDOW }),
    ];
    expect(nextDoneExpiry(rows, NOW)).toBeNull();
    expect(nextDoneExpiry([], NOW)).toBeNull();
  });
});

describe("agentTurnsInFlight", () => {
  it("counts turns and not working agents, and an agent two hosts report once", () => {
    const byHost = new Map([
      [
        "host-a",
        {
          byEpic: new Map([
            ["epic-1", activityOf(["agent-1", "agent-2"])],
            [
              "epic-2",
              { working: new Set(["agent-9"]), turn: new Set<string>() },
            ],
          ]),
        },
      ],
      [
        "host-b",
        { byEpic: new Map([["epic-1", activityOf(["agent-2", "agent-3"])]]) },
      ],
    ]);
    expect(agentTurnsInFlight(byHost)).toBe(3);
  });
});

describe("botTurnsInFlight", () => {
  const session = (state: "idle" | "replying" | "parked" | "failed") => ({
    state,
    startedAt: null,
    step: null,
    requestId: null,
    reason: null,
  });

  it("counts the trunk and every thread that is replying, and no other state", () => {
    const activity: BotActivity = {
      trunk: session("replying"),
      threads: {
        a: session("replying"),
        b: session("idle"),
        c: session("failed"),
        d: session("parked"),
        e: session("replying"),
      },
    };
    expect(botTurnsInFlight(activity)).toBe(3);
  });

  it("is zero with no reading, or a trunk no host has written", () => {
    expect(botTurnsInFlight(null)).toBe(0);
    expect(botTurnsInFlight({ trunk: null, threads: {} })).toBe(0);
  });
});
