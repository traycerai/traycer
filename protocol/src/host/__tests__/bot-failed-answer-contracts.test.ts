import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import {
  botConversationSendV10,
  botConversationSendV11,
  botSubscribeV10,
  botSubscribeV11,
} from "@traycer/protocol/host/bot/contracts";
import { botSessionActivitySchema } from "@traycer/protocol/host/bot/schemas";
import {
  conversationRequestMessageId,
  isConversationRequestMessageId,
} from "@traycer/protocol/persistence/epic/messages";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const FAILED = {
  state: "failed",
  startedAt: null,
  step: null,
  requestId: "req-1",
} as const;

const REASON = {
  summary: "Your Grok CLI version (1.0.5) is outdated.",
  code: null,
  harnessId: "grok",
  action: "none",
} as const;

describe("bot.subscribe@1.1 activity reason", () => {
  it("is the registry head, above the frozen 1.0", () => {
    const line = hostStreamRpcRegistry["bot.subscribe"][1];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[1].contract).toBe(botSubscribeV11);
    expect(line.versions[0].contract).toBe(botSubscribeV10);
  });

  it("reads an entry without a reason, as a host that predates it sends, as none", () => {
    expect(botSessionActivitySchema.parse(FAILED)).toEqual({
      ...FAILED,
      reason: null,
    });
  });

  it("keeps a reason and refuses an action it does not know", () => {
    expect(
      botSessionActivitySchema.parse({ ...FAILED, reason: REASON }).reason,
    ).toEqual(REASON);
    // A reason with no code, as a host before it sends, reads as none.
    expect(
      botSessionActivitySchema.parse({
        ...FAILED,
        reason: { summary: REASON.summary, harnessId: "grok", action: "none" },
      }).reason,
    ).toEqual(REASON);
    expect(
      botSessionActivitySchema.safeParse({
        ...FAILED,
        reason: { ...REASON, action: "update-provider" },
      }).success,
    ).toBe(false);
  });

  it("strips the reason from a 1.0 subscriber's activity frame", () => {
    const frame = {
      kind: "activity",
      target: { kind: "trunk" },
      entry: { ...FAILED, reason: REASON },
      hasBinaryPayload: false,
    };
    expect(botSubscribeV10.serverFrameSchema.parse(frame)).toEqual({
      ...frame,
      entry: FAILED,
    });
    expect(botSubscribeV11.serverFrameSchema.parse(frame)).toEqual(frame);
  });
});

describe("bot.conversation.send@1.1 retry and edit", () => {
  const line = hostRpcRegistry["bot.conversation.send"][1];
  const POST = {
    botId: BOT_ID,
    conversationId: "conv-1",
    text: "hello",
    threadId: null,
    announcementId: null,
  };

  it("is the registry head, above the frozen 1.0", () => {
    expect(line.latestMinor).toBe(1);
    expect(line.versions[1].contract).toBe(botConversationSendV11);
    expect(line.versions[0].contract).toBe(botConversationSendV10);
  });

  it("upgrades a 1.0 request to a new post: no retry, nothing replaced", () => {
    const upgrade = line.versions[1].upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.0 to 1.1 upgrade path");
    expect(
      upgrade.upgradeRequest(botConversationSendV10.requestSchema.parse(POST)),
    ).toEqual({ ...POST, redeliver: null, supersedes: null });
  });

  it("freezes 1.0 without the retry and the replaced request", () => {
    expect(
      botConversationSendV10.requestSchema.parse({
        ...POST,
        redeliver: { requestId: "req-1" },
        supersedes: "req-2",
      }),
    ).toEqual(POST);
  });

  it("defaults both on a 1.1 request that names neither", () => {
    expect(botConversationSendV11.requestSchema.parse(POST)).toEqual({
      ...POST,
      redeliver: null,
      supersedes: null,
    });
  });
});

describe("conversation request message ids", () => {
  it("names a member's request row, and nothing else", () => {
    expect(
      isConversationRequestMessageId(conversationRequestMessageId("req-1")),
    ).toBe(true);
    expect(isConversationRequestMessageId("msg-reply-1")).toBe(false);
  });
});
