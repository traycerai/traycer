import { describe, expect, it } from "vitest";
import type {
  BotRecord,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";
import {
  buildHomeBotRow,
  buildHomeBotsModel,
  foldTaskCheckins,
  homeBotState,
  type HomeBotState,
} from "../bots-model";

const BOT_A = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOT_B = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const BOT_C = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAX";

function environment(
  environmentId: string,
  ownerKind: EnvironmentDescriptor["ownerKind"],
  label: string,
): EnvironmentDescriptor {
  return {
    environmentId,
    ownerKind,
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label,
  };
}

function bot(
  botId: string,
  environmentId: string,
  title: string,
  archivedAt: number | null,
): BotRecord {
  return {
    botId,
    environmentId,
    createdByUserId: "user-1",
    title,
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId: "host-record",
    hostEpoch: 0,
    createdAt: 1_000,
    archivedAt,
  };
}

function trackingTask(
  taskId: string,
  nextAt: number | null,
  lastCheckinAt: number | null,
): BotTaskEntry {
  return {
    taskId,
    cadence:
      nextAt === null
        ? { kind: "on-completion" }
        : { kind: "every", seconds: 60 },
    lastCheckinAt,
    lastCheckin: null,
    nextAt,
    state: "tracking",
    endedReason: null,
  };
}

function endedTask(taskId: string, lastCheckinAt: number | null): BotTaskEntry {
  return {
    taskId,
    cadence: { kind: "none" },
    lastCheckinAt,
    lastCheckin: null,
    nextAt: null,
    state: "ended",
    endedReason: "by-bot",
  };
}

function snapshot(input: {
  readonly record: BotRecord;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly openRequestCount: number | null;
  readonly hostId: string;
  readonly isThisHost: boolean;
}): BotSubscriptionSnapshot {
  return {
    bot: input.record,
    tasks: input.tasks,
    openRequestCount: input.openRequestCount,
    boundHost: { hostId: input.hostId, epoch: 2, isThisHost: input.isThisHost },
  };
}

const PERSONAL = environment("env-personal", "user", "Personal");
const TEAM = environment("env-team", "organization", "acme");

describe("buildHomeBotsModel", () => {
  it("makes every environment a group in list order, even with zero bots", () => {
    const model = buildHomeBotsModel({
      environments: [PERSONAL, TEAM],
      bots: [],
    });
    expect(model.groups.map((g) => g.environmentId)).toEqual([
      "env-personal",
      "env-team",
    ]);
    expect(model.groups.every((g) => g.bots.length === 0)).toBe(true);
    expect(model.groups.every((g) => g.canCreate)).toBe(true);
    expect(model.groups[0]?.ownerKind).toBe("user");
    expect(model.groups[1]?.label).toBe("acme");
    expect(model.botCount).toBe(0);
  });

  it("skips archived bots", () => {
    const model = buildHomeBotsModel({
      environments: [PERSONAL],
      bots: [
        bot(BOT_A, "env-personal", "Live", null),
        bot(BOT_B, "env-personal", "Gone", 5_000),
      ],
    });
    expect(model.groups[0]?.bots.map((b) => b.botId)).toEqual([BOT_A]);
    expect(model.botCount).toBe(1);
  });

  it("keeps a bot whose environment is not listed in a trailing group labelled by its id", () => {
    const model = buildHomeBotsModel({
      environments: [PERSONAL, TEAM],
      bots: [
        bot(BOT_A, "env-left", "Orphan", null),
        bot(BOT_B, "env-team", "Member", null),
      ],
    });
    expect(model.groups.map((g) => g.environmentId)).toEqual([
      "env-personal",
      "env-team",
      "env-left",
    ]);
    const orphan = model.groups[2];
    expect(orphan.canCreate).toBe(false);
    expect(orphan.label).toBe("env-left");
    expect(orphan.ownerKind).toBeNull();
    expect(orphan.bots.map((b) => b.botId)).toEqual([BOT_A]);
    expect(model.botCount).toBe(2);
  });

  it("does not create an orphan group for an unlisted environment holding only archived bots", () => {
    const model = buildHomeBotsModel({
      environments: [PERSONAL],
      bots: [bot(BOT_A, "env-left", "Old", 9_000)],
    });
    expect(model.groups.map((g) => g.environmentId)).toEqual(["env-personal"]);
    expect(model.botCount).toBe(0);
  });

  it("sorts bots by title, then by bot id", () => {
    const model = buildHomeBotsModel({
      environments: [PERSONAL],
      bots: [
        bot(BOT_C, "env-personal", "Zed", null),
        bot(BOT_B, "env-personal", "Alpha", null),
        bot(BOT_A, "env-personal", "Alpha", null),
      ],
    });
    expect(model.groups[0]?.bots.map((b) => b.botId)).toEqual([
      BOT_A,
      BOT_B,
      BOT_C,
    ]);
  });

  it("places each bot in its own environment's group and counts them all", () => {
    const model = buildHomeBotsModel({
      environments: [PERSONAL, TEAM],
      bots: [
        bot(BOT_A, "env-team", "T", null),
        bot(BOT_B, "env-personal", "P", null),
      ],
    });
    expect(model.groups[0]?.bots.map((b) => b.botId)).toEqual([BOT_B]);
    expect(model.groups[1]?.bots.map((b) => b.botId)).toEqual([BOT_A]);
    expect(model.botCount).toBe(2);
  });
});

describe("foldTaskCheckins", () => {
  it("counts only tracking tasks, with the min nextAt and the max lastCheckinAt", () => {
    const folded = foldTaskCheckins([
      trackingTask("t1", 500, 100),
      trackingTask("t2", 300, 250),
      trackingTask("t3", null, null),
      endedTask("t4", 9_999),
    ]);
    expect(folded).toEqual({ tracking: 3, nextAt: 300, lastAt: 250 });
  });

  it("is empty for no tasks and for only ended tasks", () => {
    expect(foldTaskCheckins([])).toEqual({
      tracking: 0,
      nextAt: null,
      lastAt: null,
    });
    expect(foldTaskCheckins([endedTask("t1", 100)])).toEqual({
      tracking: 0,
      nextAt: null,
      lastAt: null,
    });
  });
});

describe("buildHomeBotRow", () => {
  const record = bot(BOT_A, "env-personal", "Record title", null);

  it("gives null live facts and the record's host before a snapshot arrives", () => {
    const row = buildHomeBotRow(record, null);
    expect(row).toEqual({
      botId: BOT_A,
      title: "Record title",
      environmentId: "env-personal",
      boundHostId: "host-record",
      harness: "claude",
      model: "opus",
      openRequestCount: null,
      tasksTracking: null,
      nextCheckinAt: null,
      lastCheckinAt: null,
      boundHere: null,
    });
  });

  it("takes the snapshot's host, request hint and folded tasks when one arrives", () => {
    const fresher: BotRecord = {
      ...record,
      title: "Fresh title",
      model: "sonnet",
    };
    const row = buildHomeBotRow(
      record,
      snapshot({
        record: fresher,
        tasks: [
          trackingTask("t1", 700, 40),
          trackingTask("t2", 600, 90),
          endedTask("t3", 5_000),
        ],
        openRequestCount: 3,
        hostId: "host-snapshot",
        isThisHost: true,
      }),
    );
    expect(row.boundHostId).toBe("host-snapshot");
    expect(row.boundHere).toBe(true);
    expect(row.openRequestCount).toBe(3);
    expect(row.tasksTracking).toBe(2);
    expect(row.nextCheckinAt).toBe(600);
    expect(row.lastCheckinAt).toBe(90);
    expect(row.title).toBe("Fresh title");
    expect(row.model).toBe("sonnet");
    expect(row.botId).toBe(BOT_A);
  });

  it("reports zero tracked tasks and a null open-request hint from a snapshot without them", () => {
    const row = buildHomeBotRow(
      record,
      snapshot({
        record,
        tasks: [],
        openRequestCount: null,
        hostId: "host-snapshot",
        isThisHost: false,
      }),
    );
    expect(row.tasksTracking).toBe(0);
    expect(row.nextCheckinAt).toBeNull();
    expect(row.lastCheckinAt).toBeNull();
    expect(row.openRequestCount).toBeNull();
    expect(row.boundHere).toBe(false);
  });

  describe("which read is fresher", () => {
    const listed: BotRecord = {
      ...record,
      title: "List title",
      boundHostId: "host-c",
      hostEpoch: 3,
    };

    function snapshotAt(
      hostEpoch: number,
      title: string,
      hostId: string,
    ): BotSubscriptionSnapshot {
      return snapshot({
        record: { ...record, title, boundHostId: hostId, hostEpoch },
        tasks: [],
        openRequestCount: 0,
        hostId,
        isThisHost: false,
      });
    }

    it("takes the list record's host and title when the snapshot is at a lower epoch (a stale stream)", () => {
      const row = buildHomeBotRow(
        listed,
        snapshotAt(2, "Stale title", "host-a"),
      );
      expect(row.boundHostId).toBe("host-c");
      expect(row.title).toBe("List title");
    });

    it("takes the snapshot's host and title when it is at a higher epoch", () => {
      const row = buildHomeBotRow(
        listed,
        snapshotAt(4, "Snapshot title", "host-d"),
      );
      expect(row.boundHostId).toBe("host-d");
      expect(row.title).toBe("Snapshot title");
    });

    it("takes the snapshot on a tie, being the live reading", () => {
      const row = buildHomeBotRow(
        listed,
        snapshotAt(3, "Snapshot title", "host-b"),
      );
      expect(row.boundHostId).toBe("host-b");
      expect(row.title).toBe("Snapshot title");
    });

    it("keeps the snapshot's live facts even when the record wins the host", () => {
      const row = buildHomeBotRow(
        listed,
        snapshot({
          record: { ...record, hostEpoch: 2, boundHostId: "host-a" },
          tasks: [trackingTask("t1", 700, 40)],
          openRequestCount: 5,
          hostId: "host-a",
          isThisHost: true,
        }),
      );
      expect(row.boundHostId).toBe("host-c");
      expect(row.openRequestCount).toBe(5);
      expect(row.tasksTracking).toBe(1);
      expect(row.boundHere).toBe(true);
    });
  });
});

describe("homeBotState", () => {
  const OWN = "host-own";
  const TEAMMATE = "host-teammate";
  const SANDBOX = "host-sandbox";
  // A personal environment has no machines beyond the reader's own.
  const PERSONAL_ENV: ReadonlySet<string> = new Set();

  function state(
    overrides: Partial<Parameters<typeof homeBotState>[0]>,
  ): HomeBotState {
    return homeBotState({
      working: false,
      boundHostId: OWN,
      directoryHostIds: new Set([OWN]),
      connectableHostIds: new Set([OWN]),
      connectableResolved: true,
      environmentHostIds: PERSONAL_ENV,
      environmentOwnerKind: "user",
      personalHostIds: new Set(),
      ...overrides,
    });
  }

  it("is paused for a bot no host runs, even while it looks busy", () => {
    expect(state({ boundHostId: null })).toBe("paused");
    expect(state({ boundHostId: null, working: true })).toBe("paused");
  });

  it("is working while the bot's agents run", () => {
    expect(state({ working: true })).toBe("working");
    // Working wins over an unreachable host: activity is evidence it runs.
    expect(state({ working: true, connectableHostIds: new Set() })).toBe(
      "working",
    );
  });

  it("is idle on one of the reader's own hosts that can be dialled", () => {
    expect(state({})).toBe("idle");
  });

  it("is paused on one of the reader's own hosts that cannot be dialled now", () => {
    expect(state({ connectableHostIds: new Set() })).toBe("paused");
  });

  it("is paused for a personal environment's bot bound to a host outside the directory", () => {
    expect(
      state({
        boundHostId: TEAMMATE,
        environmentHostIds: PERSONAL_ENV,
      }),
    ).toBe("paused");
  });

  it("is idle for a team environment's sandbox: in the environment's list, not the reader's directory", () => {
    expect(
      state({
        boundHostId: SANDBOX,
        environmentHostIds: new Set([SANDBOX]),
      }),
    ).toBe("idle");
  });

  it("is idle for a team environment whose machine list has not answered", () => {
    expect(state({ boundHostId: TEAMMATE, environmentHostIds: null })).toBe(
      "idle",
    );
  });

  it("is paused for another member's laptop once the team list is known and does not carry it", () => {
    expect(
      state({
        boundHostId: TEAMMATE,
        environmentHostIds: new Set([SANDBOX]),
      }),
    ).toBe("paused");
  });

  it("trusts the reader's own directory over the environment list", () => {
    // Own host, not dialable: paused whether or not the team list names it.
    expect(
      state({
        connectableHostIds: new Set(),
        environmentHostIds: new Set([OWN]),
      }),
    ).toBe("paused");
    expect(
      state({ connectableHostIds: new Set(), environmentHostIds: null }),
    ).toBe("paused");
  });

  it("is idle for an own-host bot while the host directory has not answered", () => {
    // The directory and connectable sets are empty for want of an answer.
    const unanswered = {
      directoryHostIds: new Set<string>(),
      connectableHostIds: new Set<string>(),
    };
    expect(state({ ...unanswered, connectableResolved: false })).toBe("idle");
    expect(state({ ...unanswered, connectableResolved: true })).toBe("paused");
    // The directory said the host exists but is not dialable: resolved, paused.
    expect(
      state({ connectableHostIds: new Set(), connectableResolved: true }),
    ).toBe("paused");
    expect(
      state({ connectableHostIds: new Set(), connectableResolved: false }),
    ).toBe("idle");
  });

  it("is idle for a personal-environment bot outside the directory while the directory has not answered", () => {
    const unanswered = {
      boundHostId: TEAMMATE,
      environmentHostIds: PERSONAL_ENV,
      directoryHostIds: new Set<string>(),
      connectableHostIds: new Set<string>(),
    };
    expect(state({ ...unanswered, connectableResolved: false })).toBe("idle");
    expect(state({ ...unanswered, connectableResolved: true })).toBe("paused");
  });

  describe("a team's bots run on the team's machines only", () => {
    const TEAM_ENV_HOSTS: ReadonlySet<string> = new Set([SANDBOX]);

    it("is paused for a team bot bound to one of the reader's personal hosts, even when it can be dialled", () => {
      expect(
        state({
          environmentOwnerKind: "organization",
          personalHostIds: new Set([OWN]),
        }),
      ).toBe("paused");
    });

    it("is paused for that binding even while the bot looks busy", () => {
      expect(
        state({
          working: true,
          environmentOwnerKind: "organization",
          personalHostIds: new Set([OWN]),
        }),
      ).toBe("paused");
    });

    it("is idle for a personal environment's bot on the same dialable personal host", () => {
      expect(
        state({
          environmentOwnerKind: "user",
          personalHostIds: new Set([OWN]),
        }),
      ).toBe("idle");
    });

    it.each([false, true])(
      "is idle for a team bot, never working or paused, while the registry has not answered (working: %s)",
      (working) => {
        expect(
          state({
            working,
            environmentOwnerKind: "organization",
            personalHostIds: null,
          }),
        ).toBe("idle");
      },
    );

    it("keeps a personal environment's working bot working while the registry has not answered", () => {
      expect(
        state({
          working: true,
          environmentOwnerKind: "user",
          personalHostIds: null,
        }),
      ).toBe("working");
    });

    it("is idle for a team bot on a dialable sandbox, which is not a personal host", () => {
      expect(
        state({
          boundHostId: SANDBOX,
          directoryHostIds: new Set([OWN, SANDBOX]),
          connectableHostIds: new Set([OWN, SANDBOX]),
          environmentHostIds: TEAM_ENV_HOSTS,
          environmentOwnerKind: "organization",
          personalHostIds: new Set([OWN]),
        }),
      ).toBe("idle");
    });
  });

  it("keeps an unbound bot paused and a working bot working before the directory answers", () => {
    expect(state({ boundHostId: null, connectableResolved: false })).toBe(
      "paused",
    );
    expect(state({ working: true, connectableResolved: false })).toBe(
      "working",
    );
  });
});
