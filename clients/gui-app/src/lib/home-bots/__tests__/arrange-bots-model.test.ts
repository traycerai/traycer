import { describe, expect, it } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import { arrangeBotsModel } from "../arrange-bots-model";
import { buildHomeBotsModel, type HomeBotsModel } from "../bots-model";

function environment(
  environmentId: string,
  ownerKind: EnvironmentDescriptor["ownerKind"],
): EnvironmentDescriptor {
  return {
    environmentId,
    ownerKind,
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label: environmentId,
  };
}

function bot(botId: string, environmentId: string): BotRecord {
  return {
    botId,
    environmentId,
    createdByUserId: "user-1",
    // The model sorts a group's bots by title, so the ids are the order.
    title: botId,
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId: "host-record",
    hostEpoch: 0,
    createdAt: 1_000,
    archivedAt: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: null,
  };
}

/** Model order: env-a (a1 a2 a3), env-b (b1 b2), env-c (no bot). */
const MODEL: HomeBotsModel = buildHomeBotsModel({
  environments: [
    environment("env-a", "user"),
    environment("env-b", "organization"),
    environment("env-c", "organization"),
  ],
  mainBotIds: null,
  bots: [
    bot("a1", "env-a"),
    bot("a2", "env-a"),
    bot("a3", "env-a"),
    bot("b1", "env-b"),
    bot("b2", "env-b"),
  ],
});

function sectionIds(model: HomeBotsModel): ReadonlyArray<string> {
  return model.groups.map((group) => group.environmentId);
}

function botIds(model: HomeBotsModel, environmentId: string): string[] {
  const group = model.groups.find(
    (entry) => entry.environmentId === environmentId,
  );
  if (group === undefined) throw new Error(`no group ${environmentId}`);
  return group.bots.map((entry) => entry.botId);
}

describe("arrangeBotsModel", () => {
  it("applies a partial order: named sections and channels first, the rest in model order", () => {
    const arranged = arrangeBotsModel(MODEL, {
      sectionOrder: ["env-c"],
      channelOrder: { "env-a": ["a3"] },
    });

    expect(sectionIds(arranged)).toEqual(["env-c", "env-a", "env-b"]);
    expect(botIds(arranged, "env-a")).toEqual(["a3", "a1", "a2"]);
    expect(botIds(arranged, "env-b")).toEqual(["b1", "b2"]);
    expect(arranged.botCount).toBe(MODEL.botCount);
  });

  it("ignores ids the model does not carry, and keeps a section or bot the order omits", () => {
    const arranged = arrangeBotsModel(MODEL, {
      sectionOrder: ["env-gone", "env-b"],
      channelOrder: {
        "env-a": ["a-gone", "a2"],
        "env-gone": ["x1"],
      },
    });

    expect(sectionIds(arranged)).toEqual(["env-b", "env-a", "env-c"]);
    expect(botIds(arranged, "env-a")).toEqual(["a2", "a1", "a3"]);
  });

  it("returns the model's own order for an empty arrangement", () => {
    const arranged = arrangeBotsModel(MODEL, {
      sectionOrder: [],
      channelOrder: {},
    });

    expect(sectionIds(arranged)).toEqual(sectionIds(MODEL));
    expect(botIds(arranged, "env-a")).toEqual(botIds(MODEL, "env-a"));
  });
});
