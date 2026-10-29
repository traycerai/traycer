import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { botSessionActivitySchema } from "@traycer/protocol/host/bot/schemas";

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
  const subscribeLine = hostStreamRpcRegistry["bot.subscribe"][1];
  const latestSubscribe =
    subscribeLine.versions[subscribeLine.latestMinor].contract;
  const frozenSubscribe = subscribeLine.versions[0].contract;

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
    expect(frozenSubscribe.serverFrameSchema.parse(frame)).toEqual({
      ...frame,
      entry: FAILED,
    });
    expect(latestSubscribe.serverFrameSchema.parse(frame)).toEqual(frame);
  });
});

describe("bot.conversation.send@1.1 retry and edit", () => {
  const line = hostRpcRegistry["bot.conversation.send"][1];
  const retrySend = line.versions[1].contract;
  const frozenSend = line.versions[0].contract;
  const POST = {
    botId: BOT_ID,
    conversationId: "conv-1",
    text: "hello",
    threadId: null,
    announcementId: null,
  };

  it("upgrades a 1.0 request to a new post: no retry, nothing replaced", () => {
    const upgrade = line.versions[1].upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.0 to 1.1 upgrade path");
    expect(
      upgrade.upgradeRequest(frozenSend.requestSchema.parse(POST)),
    ).toEqual({ ...POST, redeliver: null, supersedes: null });
  });

  it("freezes 1.0 without the retry and the replaced request", () => {
    expect(
      frozenSend.requestSchema.parse({
        ...POST,
        redeliver: { requestId: "req-1" },
        supersedes: "req-2",
      }),
    ).toEqual(POST);
  });

  it("defaults both on a 1.1 request that names neither", () => {
    expect(retrySend.requestSchema.parse(POST)).toEqual({
      ...POST,
      redeliver: null,
      supersedes: null,
    });
  });
});

describe("bot.conversation.send@1.2 a question card's answer", () => {
  const line = hostRpcRegistry["bot.conversation.send"][1];
  const latestSend = line.versions[line.latestMinor].contract;
  const retrySend = line.versions[1].contract;
  const POST = {
    botId: BOT_ID,
    conversationId: "conv-1",
    text: "Now",
    threadId: null,
    announcementId: null,
    redeliver: null,
    supersedes: null,
  };
  const ANSWER = {
    questionMessageId: "bot-question:req-q",
    questionIndex: 0,
    skipped: false,
  };

  it("is the latest minor", () => {
    expect(line.latestMinor).toBe(2);
  });

  it("upgrades a 1.1 request to one that answers no question", () => {
    const upgrade = line.versions[2].upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.1 to 1.2 upgrade path");
    expect(upgrade.upgradeRequest(retrySend.requestSchema.parse(POST))).toEqual(
      { ...POST, answer: null },
    );
  });

  it("freezes 1.1 without the answer, so a request projected onto a 1.1 host loses it", () => {
    expect(retrySend.requestSchema.parse({ ...POST, answer: ANSWER })).toEqual(
      POST,
    );
  });

  it("keeps the answer on a 1.2 request, and defaults it on one that names none", () => {
    expect(latestSend.requestSchema.parse({ ...POST, answer: ANSWER })).toEqual(
      { ...POST, answer: ANSWER },
    );
    expect(latestSend.requestSchema.parse(POST)).toEqual({
      ...POST,
      answer: null,
    });
  });
});
