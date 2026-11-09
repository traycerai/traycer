import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  botListV10,
  botListV11,
  botListV12,
  botReadV10,
  botReadV11,
  botUpdateAppearanceV10,
} from "@traycer/protocol/host/bot/contracts";

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
  replyMode: "direct" as const,
  trunkChatId: "chat-1",
  boundHostId: "host-1",
  hostEpoch: 0,
  createdAt: 1_000,
  archivedAt: null,
};

const entry = hostRpcRegistry["bot.list"][1];

describe("bot.list@1.1 main bot ids", () => {
  it("keeps 1.1 and 1.0 registered below the head", () => {
    expect(entry.latestMinor).toBe(2);
    expect(entry.versions[2].contract).toBe(botListV12);
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

  it("reads a row from a host that predates the reply mode as answering in threads", () => {
    const olderRow = Object.fromEntries(
      Object.entries(BOT_ROW).filter(([key]) => key !== "replyMode"),
    );
    const [row] = botListV11.responseSchema.parse({
      bots: [olderRow],
      mainBotIds: null,
    }).bots;

    expect(row?.replyMode).toBe("thread");
  });

  it("keeps the conversation a row names", () => {
    const [row] = botListV11.responseSchema.parse({
      bots: [{ ...BOT_ROW, appConversationChatId: "conversation-app" }],
      mainBotIds: null,
    }).bots;

    expect(row?.appConversationChatId).toBe("conversation-app");
  });
});

const APPEARANCE = {
  mark: { kind: "creature", family: "ears", seed: 7 },
  swatch: 3,
  background: 20,
} as const;

describe("bot appearance on the wire", () => {
  const listEntry = hostRpcRegistry["bot.list"][1];
  const readEntry = hostRpcRegistry["bot.read"][1];

  it("carries the appearance on bot.list@1.2 and bot.read@1.1 rows", () => {
    expect(
      botListV12.responseSchema.parse({
        bots: [{ ...BOT_ROW, appearance: APPEARANCE }],
        mainBotIds: null,
      }).bots[0]?.appearance,
    ).toEqual(APPEARANCE);
    expect(
      botReadV11.responseSchema.parse({
        bot: { ...BOT_ROW, appearance: APPEARANCE },
      }).bot.appearance,
    ).toEqual(APPEARANCE);
  });

  it("reads a row without an appearance as naming none", () => {
    expect(
      botListV12.responseSchema.parse({ bots: [BOT_ROW], mainBotIds: null })
        .bots[0]?.appearance,
    ).toBeUndefined();
  });

  it("strips the appearance for a 1.1 list caller and a 1.0 read caller", () => {
    const listRow = botListV11.responseSchema.parse({
      bots: [{ ...BOT_ROW, appearance: APPEARANCE }],
      mainBotIds: null,
    }).bots[0];
    const readRow = botReadV10.responseSchema.parse({
      bot: { ...BOT_ROW, appearance: APPEARANCE },
    }).bot;

    expect(listRow).toEqual(BOT_ROW);
    expect(readRow).toEqual(BOT_ROW);
  });

  it("upgrades 1.1 to 1.2 and read 1.0 to 1.1 as identities", () => {
    const listUpgrade = listEntry.versions[2].upgradeFromPreviousVersion;
    const readUpgrade = readEntry.versions[1].upgradeFromPreviousVersion;
    if (listUpgrade === null || readUpgrade === null) {
      throw new Error("expected upgrade paths");
    }
    const listResponse = { bots: [BOT_ROW], mainBotIds: { "env-1": BOT_A } };
    const readResponse = { bot: BOT_ROW };

    expect(listUpgrade.upgradeResponse(listResponse)).toEqual(listResponse);
    expect(readUpgrade.upgradeResponse(readResponse)).toEqual(readResponse);
  });

  it("refuses an appearance with a swatch or seed out of range", () => {
    for (const bad of [
      { ...APPEARANCE, swatch: 24 },
      { ...APPEARANCE, background: -1 },
      { ...APPEARANCE, swatch: 1.5 },
      {
        ...APPEARANCE,
        mark: { kind: "creature", family: "ears", seed: 65_536 },
      },
      {
        ...APPEARANCE,
        mark: { kind: "picture", blobRef: "a".repeat(64) },
      },
    ]) {
      expect(
        botReadV11.responseSchema.safeParse({
          bot: { ...BOT_ROW, appearance: bad },
        }).success,
      ).toBe(false);
    }
  });
});

describe("bot.updateAppearance request", () => {
  const request = botUpdateAppearanceV10.requestSchema;

  it("keeps an absent field absent and a null field null", () => {
    expect(request.parse({ botId: BOT_A })).toEqual({ botId: BOT_A });
    expect(
      request.parse({
        botId: BOT_A,
        mark: null,
        swatch: null,
        background: null,
      }),
    ).toEqual({ botId: BOT_A, mark: null, swatch: null, background: null });
  });

  it("accepts a creature and the swatch bounds", () => {
    expect(
      request.parse({
        botId: BOT_A,
        mark: { kind: "creature", family: "crest", seed: 65_535 },
        swatch: 0,
        background: 23,
      }).background,
    ).toBe(23);
  });

  it("refuses an out-of-range swatch or seed, an unknown family and a picture", () => {
    for (const bad of [
      { swatch: 24 },
      { background: 24 },
      { swatch: -1 },
      { mark: { kind: "creature", family: "none", seed: 65_536 } },
      { mark: { kind: "creature", family: "none", seed: -1 } },
      { mark: { kind: "creature", family: "wings", seed: 1 } },
      { mark: { kind: "picture", blobRef: "a".repeat(64) } },
    ]) {
      expect(request.safeParse({ botId: BOT_A, ...bad }).success).toBe(false);
    }
  });
});
