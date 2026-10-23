import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { botListV10, botListV11 } from "@traycer/protocol/host/bot/contracts";

const BOT_A = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOT_B = "bot_01BX5ZZKBKACTAV9WEVGEMMVRZ";

const BOT_ROW = {
  botId: BOT_A,
  environmentId: "env-1",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "model-a",
  effort: null,
  profile: null,
  directive: null,
  appConversationChatId: null,
  trunkChatId: "chat-1",
  boundHostId: "host-1",
  hostEpoch: 0,
  createdAt: 1_000,
  archivedAt: null,
};

const entry = hostRpcRegistry["bot.list"][1];

describe("bot.list@1.1 main bot ids", () => {
  it("is the registry head, above the frozen 1.0", () => {
    expect(entry.latestMinor).toBe(1);
    expect(entry.versions[1].contract).toBe(botListV11);
    expect(entry.versions[0].contract).toBe(botListV10);
  });

  it("upgrades a 1.0 response to a null map, which says nothing about which bot is main", () => {
    const upgrade = entry.versions[1].upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.0 to 1.1 upgrade path");
    const v10Response = botListV10.responseSchema.parse({ bots: [BOT_ROW] });

    expect(upgrade.upgradeResponse(v10Response)).toEqual({
      bots: [BOT_ROW],
      mainBotIds: null,
    });
  });

  it("freezes 1.0 at the rows alone, dropping a map it never carried", () => {
    expect(
      botListV10.responseSchema.parse({
        bots: [BOT_ROW],
        mainBotIds: { "env-1": BOT_A },
      }),
    ).toEqual({ bots: [BOT_ROW] });
  });

  it("requires mainBotIds, accepting a map or null", () => {
    expect(
      botListV11.responseSchema.safeParse({ bots: [BOT_ROW] }).success,
    ).toBe(false);
    expect(
      botListV11.responseSchema.parse({ bots: [BOT_ROW], mainBotIds: null }),
    ).toEqual({ bots: [BOT_ROW], mainBotIds: null });
    expect(
      botListV11.responseSchema.parse({
        bots: [BOT_ROW],
        mainBotIds: { "env-1": BOT_A, "env-2": BOT_B },
      }).mainBotIds,
    ).toEqual({ "env-1": BOT_A, "env-2": BOT_B });
  });

  it("rejects a main bot id that is not a bot id and an empty environment key", () => {
    for (const mainBotIds of [{ "env-1": "not-a-bot" }, { "": BOT_A }]) {
      expect(
        botListV11.responseSchema.safeParse({ bots: [], mainBotIds }).success,
      ).toBe(false);
    }
  });
});

describe("bot.list rows' app conversation", () => {
  it("reads a row from a host that predates the field as naming no conversation", () => {
    const olderRow = Object.fromEntries(
      Object.entries(BOT_ROW).filter(
        ([key]) => key !== "appConversationChatId",
      ),
    );
    const [row] = botListV11.responseSchema.parse({
      bots: [olderRow],
      mainBotIds: null,
    }).bots;

    expect(row?.appConversationChatId).toBeNull();
  });

  it("keeps the conversation a row names", () => {
    const [row] = botListV11.responseSchema.parse({
      bots: [{ ...BOT_ROW, appConversationChatId: "conversation-app" }],
      mainBotIds: null,
    }).bots;

    expect(row?.appConversationChatId).toBe("conversation-app");
  });
});
