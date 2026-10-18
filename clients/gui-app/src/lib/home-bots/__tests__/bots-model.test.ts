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
