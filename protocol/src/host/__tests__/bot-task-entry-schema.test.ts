import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  botSubscribeServerFrameSchema,
  botSurfaceActionStateSchema,
  botTaskEntrySchema,
  type BotInputNeeded,
  type BotSurfaceActionState,
  type BotActivity,
  type BotSessionActivity,
  type BotTaskCheckinRecord,
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
  createdByUserId: null,
  spun: null,
  label: null,
  originRequestId: null,
  createdByChatId: null,
  checkins: null,
  inputNeeded: null,
};

const TRACKING_ON_COMPLETION: BotTaskEntry = {
  taskId: "task-2",
  cadence: { kind: "on-completion" },
  lastCheckinAt: null,
  lastCheckin: null,
  nextAt: null,
  state: "tracking",
  endedReason: null,
  createdByUserId: null,
  spun: null,
  label: null,
  originRequestId: null,
  createdByChatId: null,
  checkins: null,
  inputNeeded: null,
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
  readonly conversationsRevision: number | null;
  readonly boundHost: object;
  readonly activity: BotActivity | null;
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
      replyMode: "thread",
    },
    tasks,
    openRequestCount,
    conversationsRevision: 0,
    boundHost: { hostId: "host-1", epoch: 0, isThisHost: true },
    activity: null,
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

describe("botTaskEntrySchema createdByUserId", () => {
  it("carries the member who set the task up", () => {
    const parsed = botTaskEntrySchema.parse({
      ...TRACKING_EVERY,
      createdByUserId: "member-1",
    });

    expect(parsed.createdByUserId).toBe("member-1");
  });

  it("reads an entry from a host that predates the field as naming nobody", () => {
    const { createdByUserId: _omitted, ...withoutField } = TRACKING_EVERY;

    expect(botTaskEntrySchema.parse(withoutField).createdByUserId).toBeNull();
  });
});

describe("bot.subscribe@1.3 task provenance", () => {
  const line = hostStreamRpcRegistry["bot.subscribe"][1];
  const PROVENANCE = {
    spun: true,
    label: "Nightly triage",
    originRequestId: "req-1",
    createdByChatId: "thread-1",
  } as const;
  const UNKNOWN_PROVENANCE = {
    spun: null,
    label: null,
    originRequestId: null,
    createdByChatId: null,
  } as const;

  function snapshotWith(tasks: ReadonlyArray<object>): object {
    return {
      ...snapshotFrame([], null),
      tasks,
      notificationSubscriptions: null,
    };
  }

  it("reads an entry from a host that predates the fields as unknown provenance", () => {
    const {
      spun: _spun,
      label: _label,
      originRequestId: _origin,
      createdByChatId: _creator,
      ...withoutFields
    } = TRACKING_EVERY;

    expect(botTaskEntrySchema.parse(withoutFields)).toEqual({
      ...TRACKING_EVERY,
      ...UNKNOWN_PROVENANCE,
    });
  });

  it("carries the provenance to a 1.3 subscriber and strips it below 1.3", () => {
    const frame = snapshotWith([{ ...TRACKING_EVERY, ...PROVENANCE }]);

    const {
      checkins: _checkins,
      inputNeeded: _inputNeeded,
      ...v13Entry
    } = TRACKING_EVERY;
    const v13 = line.versions[3].contract.serverFrameSchema.parse(frame);
    expect(v13.kind === "snapshot" ? v13.tasks : null).toEqual([
      { ...v13Entry, ...PROVENANCE },
    ]);
    const {
      spun: _spun,
      label: _label,
      originRequestId: _origin,
      createdByChatId: _creator,
      ...v12Entry
    } = v13Entry;
    for (const minor of [0, 1, 2] as const) {
      const parsed =
        line.versions[minor].contract.serverFrameSchema.parse(frame);
      expect(parsed.kind === "snapshot" ? parsed.tasks : null).toEqual([
        v12Entry,
      ]);
    }
  });
});

describe("bot.subscribe@1.4 check-in history", () => {
  const line = hostStreamRpcRegistry["bot.subscribe"][1];
  const HISTORY: BotTaskCheckinRecord[] = [
    {
      kind: "missed",
      dueAt: 1_760_000_000_000,
      missedThrough: 1_760_001_800_000,
      reason: "no-host-reported",
      caughtUpAt: 1_760_003_000_000,
    },
    {
      kind: "received",
      receivedAt: 1_759_999_000_000,
      hostId: "host-1",
      hostName: "laptop",
      outcome: "still-running",
      agentsStarted: 2,
      ticketsOpened: 1,
      ticketsClosed: 0,
      backgroundEvents: 3,
      turn: { chatId: "trunk-1", turnId: "turn-1" },
    },
  ];
  const WATCH = {
    target: { kind: "trunk" },
    attentionOnly: true,
    everySeconds: null,
  } as const;

  function snapshotWith(
    tasks: ReadonlyArray<object>,
    watches: ReadonlyArray<object>,
  ): object {
    return {
      ...snapshotFrame([], null),
      tasks,
      notificationSubscriptions: watches,
    };
  }

  it("carries the history and a watch's start to a 1.4 subscriber", () => {
    const frame = snapshotWith(
      [{ ...TRACKING_EVERY, checkins: HISTORY }],
      [{ ...WATCH, since: 1_759_000_000_000 }],
    );

    const { inputNeeded: _inputNeeded, ...v14Entry } = TRACKING_EVERY;
    const latest = line.versions[4].contract.serverFrameSchema.parse(frame);
    expect(latest.kind === "snapshot" ? latest.tasks : null).toEqual([
      { ...v14Entry, checkins: HISTORY },
    ]);
    expect(
      latest.kind === "snapshot" ? latest.notificationSubscriptions : null,
    ).toEqual([{ ...WATCH, since: 1_759_000_000_000 }]);
  });

  it("strips both for a 1.3 and a 1.2 subscriber", () => {
    const frame = snapshotWith(
      [{ ...TRACKING_EVERY, checkins: HISTORY }],
      [{ ...WATCH, since: 1_759_000_000_000 }],
    );

    for (const minor of [2, 3] as const) {
      const parsed =
        line.versions[minor].contract.serverFrameSchema.parse(frame);
      if (parsed.kind !== "snapshot") throw new Error("not a snapshot");
      expect(parsed.tasks[0]).not.toHaveProperty("checkins");
      expect(parsed.notificationSubscriptions).toEqual([WATCH]);
    }
  });

  it("reads an entry and a watch from a host that predates them as unknown", () => {
    const {
      checkins: _omitted,
      inputNeeded: _later,
      ...withoutHistory
    } = TRACKING_EVERY;
    const parsed = botSubscribeServerFrameSchema.parse(
      snapshotWith([withoutHistory], [WATCH]),
    );

    if (parsed.kind !== "snapshot") throw new Error("not a snapshot");
    expect(parsed.tasks[0]?.checkins).toBeNull();
    expect(parsed.notificationSubscriptions?.[0]?.since).toBeNull();
  });

  it("refuses a missed record with a reason it does not know", () => {
    expect(
      botTaskEntrySchema.safeParse({
        ...TRACKING_EVERY,
        checkins: [{ ...HISTORY[0], reason: "host-asleep" }],
      }).success,
    ).toBe(false);
  });
});

describe("bot.subscribe@1.5 open surfaces and card actions", () => {
  const line = hostStreamRpcRegistry["bot.subscribe"][1];
  const OPEN: BotInputNeeded[] = [
    {
      hostId: "host-1",
      hostName: "laptop",
      agentChatId: "chat-1",
      surfaceId: "block-1",
      surface: {
        kind: "question",
        blockId: "block-1",
        questions: [
          {
            questionId: "q-1",
            text: "Which branch?",
            options: ["main", "dev"],
            allowsFreeText: true,
          },
        ],
        askedAt: 1_760_000_000_000,
      },
      reportedAt: 1_760_000_000_500,
      acceptsActions: true,
    },
    {
      hostId: "host-2",
      hostName: "pod",
      agentChatId: "chat-2",
      surfaceId: "approval-1",
      surface: {
        kind: "approval",
        approvalId: "approval-1",
        tool: "Bash",
        summary: "npm publish",
        tier: "hard",
        requiresPerson: true,
        askedAt: 1_760_000_000_000,
      },
      reportedAt: 1_760_000_000_600,
      acceptsActions: false,
    },
  ];
  const ACTIONS: BotSurfaceActionState[] = [
    { actionId: "action-1", messageId: "m-1", state: "sending", code: null },
    {
      actionId: "action-2",
      messageId: "m-2",
      state: "refused",
      code: "NOT_SUPPORTED",
    },
  ];

  function snapshotWithOpen(): object {
    return {
      ...snapshotFrame([], null),
      tasks: [{ ...TRACKING_EVERY, inputNeeded: OPEN }],
      surfaceActions: ACTIONS,
    };
  }

  it("carries a task's open surfaces and the subscriber's actions to a 1.5 subscriber", () => {
    expect(line.latestMinor).toBe(5);
    const latest =
      line.versions[5].contract.serverFrameSchema.parse(snapshotWithOpen());
    if (latest.kind !== "snapshot") throw new Error("not a snapshot");
    expect(latest.tasks[0]?.inputNeeded).toEqual(OPEN);
    expect(latest.surfaceActions).toEqual(ACTIONS);
  });

  it("strips both for a 1.4 subscriber", () => {
    const parsed =
      line.versions[4].contract.serverFrameSchema.parse(snapshotWithOpen());
    if (parsed.kind !== "snapshot") throw new Error("not a snapshot");
    expect(parsed.tasks[0]).not.toHaveProperty("inputNeeded");
    expect(parsed).not.toHaveProperty("surfaceActions");
  });

  it("reads a host that predates them as unknown", () => {
    const { inputNeeded: _omitted, ...withoutOpen } = TRACKING_EVERY;
    const parsed = botSubscribeServerFrameSchema.parse({
      ...snapshotFrame([], null),
      tasks: [withoutOpen],
    });
    if (parsed.kind !== "snapshot") throw new Error("not a snapshot");
    expect(parsed.tasks[0]?.inputNeeded).toBeNull();
    expect(parsed.surfaceActions).toBeNull();
  });

  it("refuses a refusal code it does not know", () => {
    expect(
      botSurfaceActionStateSchema.safeParse({
        actionId: "a",
        messageId: "m",
        state: "refused",
        code: "SOMETHING_ELSE",
      }).success,
    ).toBe(false);
  });
});

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

const REPLYING: BotSessionActivity = {
  state: "replying",
  startedAt: 1_760_000_000_000,
  step: "Ran bun test",
  requestId: "req-1",
  reason: null,
};

describe("the bot.subscribe activity", () => {
  it("carries the trunk and each thread's session in the snapshot", () => {
    const parsed = botSubscribeServerFrameSchema.safeParse({
      ...snapshotFrame([], 0),
      activity: {
        trunk: REPLYING,
        threads: {
          "thread-1": {
            state: "failed",
            startedAt: null,
            step: null,
            requestId: "req-2",
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.kind !== "snapshot") return;
    expect(parsed.data.activity?.threads["thread-1"]?.state).toBe("failed");
  });

  it("replaces one entry, or removes it, in an activity frame", () => {
    for (const frame of [
      {
        kind: "activity",
        target: { kind: "thread", threadId: "thread-1" },
        entry: REPLYING,
        hasBinaryPayload: false,
      },
      {
        kind: "activity",
        target: { kind: "trunk" },
        entry: null,
        hasBinaryPayload: false,
      },
    ]) {
      expect(botSubscribeServerFrameSchema.safeParse(frame).success).toBe(true);
    }
  });

  it("refuses a thread target with no thread id, and a state it does not know", () => {
    expect(
      botSubscribeServerFrameSchema.safeParse({
        kind: "activity",
        target: { kind: "thread" },
        entry: REPLYING,
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
    expect(
      botSubscribeServerFrameSchema.safeParse({
        kind: "activity",
        target: { kind: "trunk" },
        entry: { ...REPLYING, state: "thinking" },
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
  });
});
