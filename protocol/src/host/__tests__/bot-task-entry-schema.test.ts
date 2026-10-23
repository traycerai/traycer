import { describe, expect, it } from "vitest";
import {
  botSubscribeServerFrameSchema,
  botTaskEntrySchema,
  type BotTaskEntry,
  type BotTaskLastCheckin,
} from "@traycer/protocol/host/bot/schemas";

const TRACKING_EVERY: BotTaskEntry = {
  taskId: "task-1",
  cadence: { kind: "every", seconds: 1800 },
  lastCheckinAt: 1_760_000_000_000,
  lastCheckin: null,
  nextAt: 1_760_001_800_000,
  state: "tracking",
  endedReason: null,
};

const TRACKING_ON_COMPLETION: BotTaskEntry = {
  taskId: "task-2",
  cadence: { kind: "on-completion" },
  lastCheckinAt: null,
  lastCheckin: null,
  nextAt: null,
  state: "tracking",
  endedReason: null,
};

function issuePaths(entry: BotTaskEntry): string[] {
  const parsed = botTaskEntrySchema.safeParse(entry);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => issue.path.join("."));
}

describe("host bot.subscribe botTaskEntrySchema invariants", () => {
  it("accepts a tracking every entry with a due time", () => {
    expect(botTaskEntrySchema.safeParse(TRACKING_EVERY).success).toBe(true);
  });

  it("accepts a tracking on-completion entry with no due time", () => {
    expect(botTaskEntrySchema.safeParse(TRACKING_ON_COMPLETION).success).toBe(
      true,
    );
  });

  it("accepts a tracking every entry whose due time is null", () => {
    expect(
      botTaskEntrySchema.safeParse({ ...TRACKING_EVERY, nextAt: null }).success,
    ).toBe(true);
  });

  it("accepts an entry the bot ended, with its reason and no due time", () => {
    expect(
      botTaskEntrySchema.safeParse({
        ...TRACKING_ON_COMPLETION,
        cadence: { kind: "none" },
        state: "ended",
        endedReason: "by-bot",
      }).success,
    ).toBe(true);
  });

  it("accepts every ended reason on an ended entry", () => {
    for (const endedReason of [
      "by-bot",
      "deleted",
      "archived",
      "completed",
    ] as const) {
      expect(
        botTaskEntrySchema.safeParse({
          ...TRACKING_EVERY,
          nextAt: null,
          state: "ended",
          endedReason,
        }).success,
      ).toBe(true);
    }
  });

  it("refuses a tracking entry that carries an ended reason", () => {
    const entry: BotTaskEntry = { ...TRACKING_EVERY, endedReason: "by-bot" };

    expect(botTaskEntrySchema.safeParse(entry).success).toBe(false);
    expect(issuePaths(entry)).toEqual(["endedReason"]);
  });

  it("refuses an ended entry that has no ended reason", () => {
    const entry: BotTaskEntry = {
      ...TRACKING_EVERY,
      nextAt: null,
      state: "ended",
      endedReason: null,
    };

    expect(botTaskEntrySchema.safeParse(entry).success).toBe(false);
    expect(issuePaths(entry)).toEqual(["endedReason"]);
  });

  it("refuses an on-completion entry that has a due time", () => {
    const entry: BotTaskEntry = { ...TRACKING_ON_COMPLETION, nextAt: 5 };

    expect(botTaskEntrySchema.safeParse(entry).success).toBe(false);
    expect(issuePaths(entry)).toEqual(["nextAt"]);
  });

  it("refuses a none entry that has a due time", () => {
    const entry: BotTaskEntry = {
      ...TRACKING_ON_COMPLETION,
      cadence: { kind: "none" },
      nextAt: 5,
      state: "ended",
      endedReason: "by-bot",
    };

    expect(botTaskEntrySchema.safeParse(entry).success).toBe(false);
    expect(issuePaths(entry)).toEqual(["nextAt"]);
  });

  it("refuses an ended entry that still has a due time on a non-periodic cadence", () => {
    const entry: BotTaskEntry = {
      ...TRACKING_ON_COMPLETION,
      nextAt: 5,
      state: "ended",
      endedReason: "completed",
    };

    expect(issuePaths(entry)).toEqual(["nextAt"]);
  });

  it("reports both contradictions of an entry that has both", () => {
    const entry: BotTaskEntry = {
      ...TRACKING_ON_COMPLETION,
      nextAt: 5,
      endedReason: "by-bot",
    };

    expect(issuePaths(entry).sort()).toEqual(["endedReason", "nextAt"]);
  });

  it("still refuses an empty task id before it reaches the invariants", () => {
    expect(
      botTaskEntrySchema.safeParse({ ...TRACKING_EVERY, taskId: "" }).success,
    ).toBe(false);
  });
});

function snapshotFrame(
  tasks: readonly BotTaskEntry[],
  openRequestCount: number | null,
): {
  readonly kind: "snapshot";
  readonly bot: object;
  readonly tasks: readonly BotTaskEntry[];
  readonly openRequestCount: number | null;
  readonly boundHost: object;
  readonly hasBinaryPayload: false;
} {
  return {
    kind: "snapshot",
    bot: {
      botId: "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1",
      environmentId: "env-1",
      createdByUserId: "owner-1",
      title: "Nightly triage",
      harness: "claude",
      model: "claude-opus-5-5",
      effort: null,
      profile: null,
      trunkChatId: "trunk-1",
      boundHostId: "host-1",
      hostEpoch: 0,
      createdAt: 1_760_000_000_000,
      archivedAt: null,
      directive: null,
      appConversationChatId: null,
    },
    tasks,
    openRequestCount,
    boundHost: { hostId: "host-1", epoch: 0, isThisHost: true },
    hasBinaryPayload: false,
  };
}

describe("the bot.subscribe snapshot frame's task list", () => {
  it("accepts a snapshot whose tasks are consistent", () => {
    expect(
      botSubscribeServerFrameSchema.safeParse(
        snapshotFrame([TRACKING_EVERY, TRACKING_ON_COMPLETION], 0),
      ).success,
    ).toBe(true);
  });

  it("refuses a snapshot that lists a contradictory task", () => {
    expect(
      botSubscribeServerFrameSchema.safeParse(
        snapshotFrame([{ ...TRACKING_EVERY, endedReason: "by-bot" }], 0),
      ).success,
    ).toBe(false);
    expect(
      botSubscribeServerFrameSchema.safeParse(
        snapshotFrame([{ ...TRACKING_ON_COMPLETION, nextAt: 5 }], 0),
      ).success,
    ).toBe(false);
  });

  it("accepts a snapshot whose open-request count is null", () => {
    expect(
      botSubscribeServerFrameSchema.safeParse(
        snapshotFrame([TRACKING_EVERY], null),
      ).success,
    ).toBe(true);
  });

  it("still refuses a negative or fractional open-request count", () => {
    for (const count of [-1, 1.5]) {
      expect(
        botSubscribeServerFrameSchema.safeParse(
          snapshotFrame([TRACKING_EVERY], count),
        ).success,
      ).toBe(false);
    }
  });

  it("carries a task's last check-in through the frame", () => {
    const parsed = botSubscribeServerFrameSchema.safeParse(
      snapshotFrame([{ ...TRACKING_EVERY, lastCheckin: LAST_CHECKIN }], 2),
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.kind !== "snapshot") return;
    expect(parsed.data.tasks[0]?.lastCheckin).toEqual(LAST_CHECKIN);
  });
});

const LAST_CHECKIN: BotTaskLastCheckin = {
  deliveredAt: 1_760_000_900_000,
  since: 1_760_000_000_000,
  through: 1_760_000_800_000,
  sections: {
    agentsStarted: {
      available: true,
      rows: [
        {
          agentId: "agent-1",
          title: "Fix the build",
          harnessId: "claude",
          model: "claude-opus-5-5",
          reasoningEffort: null,
          startedAt: 1_760_000_100_000,
          creatorAgentId: null,
          isTerminal: false,
        },
      ],
      omitted: 0,
      creatorsBeyondCap: false,
    },
    backgroundEvents: {
      rows: [
        {
          kind: "shell-exited",
          at: 1_760_000_200_000,
          shellId: "shell-1",
          description: "bun test",
          agentId: "agent-1",
          agentTitle: "Fix the build",
          exitCode: 0,
          signal: null,
        },
        {
          kind: "shell-interrupted",
          at: 1_760_000_300_000,
          shellId: "shell-2",
          description: "dev server",
          agentId: "agent-1",
          agentTitle: null,
        },
        {
          kind: "shell-output-delivered",
          at: 1_760_000_400_000,
          shellId: "shell-3",
          description: null,
          agentId: "agent-1",
          agentTitle: "Fix the build",
        },
        {
          kind: "forward-notice-delivered",
          at: 1_760_000_500_000,
          forwardId: "forward-1",
          agentId: "agent-1",
          agentTitle: "Fix the build",
        },
      ],
      omitted: 3,
    },
    tickets: {
      rows: [
        {
          artifactId: "artifact-1",
          title: "Ship it",
          path: "epics/task-1/artifacts/tickets/ship-it/index.md",
          move: "closed",
        },
      ],
      omitted: 0,
      firstCheckin: true,
    },
    cost: {
      available: true,
      window: {
        knownCostUsd: 1.5,
        turnCount: 4,
        completeness: { measured: 3, partial: 1, absent: 0 },
        unpricedTurnCount: 1,
        perAgent: [
          {
            agentId: "agent-1",
            agentTitle: "Fix the build",
            knownCostUsd: 1.5,
            turnCount: 4,
          },
        ],
        perAgentOmitted: 0,
        perModel: [
          {
            harnessId: "claude",
            model: "claude-opus-5-5",
            knownCostUsd: 1.5,
            turnCount: 4,
          },
        ],
        perModelOmitted: 2,
      },
      total: {
        knownCostUsd: 3,
        turnCount: 9,
        completeness: { measured: 9, partial: 0, absent: 0 },
        unpricedTurnCount: 0,
      },
    },
    stillRunning: {
      state: "running",
      reason: "working",
      agents: [{ agentId: "agent-1", agentTitle: null, tier: "turn" }],
      agentsOmitted: 0,
      shells: [
        {
          shellId: "shell-4",
          description: "watcher",
          agentId: "agent-1",
          agentTitle: "Fix the build",
        },
      ],
      shellsOmitted: 0,
    },
  },
};

describe("botTaskEntrySchema lastCheckin", () => {
  it("accepts an entry carrying a full last check-in", () => {
    expect(
      botTaskEntrySchema.safeParse({
        ...TRACKING_EVERY,
        lastCheckin: LAST_CHECKIN,
      }).success,
    ).toBe(true);
  });

  it("accepts an unavailable cost with null figures", () => {
    const entry: BotTaskEntry = {
      ...TRACKING_EVERY,
      lastCheckin: {
        ...LAST_CHECKIN,
        sections: {
          ...LAST_CHECKIN.sections,
          cost: { available: false, window: null, total: null },
        },
      },
    };

    expect(botTaskEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("refuses an entry without the lastCheckin field", () => {
    const { lastCheckin: _omitted, ...withoutField } = TRACKING_EVERY;

    expect(botTaskEntrySchema.safeParse(withoutField).success).toBe(false);
  });

  it("refuses a last check-in that is missing a section", () => {
    const { stillRunning: _omitted, ...sections } = LAST_CHECKIN.sections;

    expect(
      botTaskEntrySchema.safeParse({
        ...TRACKING_EVERY,
        lastCheckin: { ...LAST_CHECKIN, sections },
      }).success,
    ).toBe(false);
  });

  it("refuses a last check-in with a background row of an unknown kind", () => {
    const sections = {
      ...LAST_CHECKIN.sections,
      backgroundEvents: {
        rows: [
          {
            kind: "shell-vanished",
            at: 1,
            shellId: "shell-1",
            agentId: "agent-1",
            agentTitle: null,
          },
        ],
        omitted: 0,
      },
    };

    expect(
      botTaskEntrySchema.safeParse({
        ...TRACKING_EVERY,
        lastCheckin: { ...LAST_CHECKIN, sections },
      }).success,
    ).toBe(false);
  });

  it("refuses a ticket row with an unknown move", () => {
    const sections = {
      ...LAST_CHECKIN.sections,
      tickets: {
        rows: [
          {
            artifactId: "artifact-1",
            title: "Ship it",
            path: "epics/task-1/artifacts/tickets/ship-it/index.md",
            move: "reopened",
          },
        ],
        omitted: 0,
        firstCheckin: false,
      },
    };

    expect(
      botTaskEntrySchema.safeParse({
        ...TRACKING_EVERY,
        lastCheckin: { ...LAST_CHECKIN, sections },
      }).success,
    ).toBe(false);
  });

  describe("the still-running section's reason", () => {
    /** The entry with its last check-in's still-running section replaced by `fields` over the fixture's. */
    function withStillRunning(fields: Record<string, unknown>): unknown {
      return {
        ...TRACKING_EVERY,
        lastCheckin: {
          ...LAST_CHECKIN,
          sections: {
            ...LAST_CHECKIN.sections,
            stillRunning: { ...LAST_CHECKIN.sections.stillRunning, ...fields },
          },
        },
      };
    }

    it.each([
      ["running", "working"],
      ["running", "owed-release-work"],
      ["running", "no-agent-yet"],
      ["running", "resumed-while-composing"],
      ["unknown", "check-failed"],
      ["idle", null],
    ])("accepts state %s with reason %s", (state, reason) => {
      expect(
        botTaskEntrySchema.safeParse(withStillRunning({ state, reason }))
          .success,
      ).toBe(true);
    });

    it.each([
      ["running", "check-failed"],
      ["running", null],
      ["unknown", "working"],
      ["unknown", null],
      ["idle", "working"],
      ["idle", "check-failed"],
    ])("refuses state %s with reason %s", (state, reason) => {
      expect(
        botTaskEntrySchema.safeParse(withStillRunning({ state, reason }))
          .success,
      ).toBe(false);
    });

    it("refuses a reason it does not know", () => {
      expect(
        botTaskEntrySchema.safeParse(withStillRunning({ reason: "stalled" }))
          .success,
      ).toBe(false);
    });

    it("refuses a still-running section with no reason field", () => {
      const { reason: _omitted, ...withoutReason } =
        LAST_CHECKIN.sections.stillRunning;

      expect(
        botTaskEntrySchema.safeParse({
          ...TRACKING_EVERY,
          lastCheckin: {
            ...LAST_CHECKIN,
            sections: {
              ...LAST_CHECKIN.sections,
              stillRunning: withoutReason,
            },
          },
        }).success,
      ).toBe(false);
    });
  });
});
