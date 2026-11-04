import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";

/**
 * A call's first words ride `bot.conversation.send@1.3` (`origin`, `spoken`),
 * and its thread lists with `kind` on `bot.thread.list@1.2`. Both are read off
 * the registry, so the pair a peer negotiates is what is held to the shape.
 */

const send = hostRpcRegistry["bot.conversation.send"][1];
const sendV12 = send.versions[2].contract;
const sendV13 = send.versions[3].contract;
const list = hostRpcRegistry["bot.thread.list"][1];
const listV11 = list.versions[1].contract;
const listV12 = list.versions[2].contract;

const REQUEST = {
  botId: "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1",
  conversationId: "conv-1",
  text: "hello bot",
};

const SUMMARY = {
  threadId: "thread-1",
  conversationId: "conv-1",
  sessionChatId: "session-1",
  anchor: null,
  replyCount: 0,
  lastReplyAt: null,
  openRequestCount: 1,
  costUsd: null,
};

function listing(summary: Record<string, unknown>): Record<string, unknown> {
  return { threads: [summary], trunkCostUsd: null, threadAnchors: null };
}

describe("bot.conversation.send@1.3", () => {
  it("keeps a call's origin and its spoken words", () => {
    expect(
      sendV13.requestSchema.parse({ ...REQUEST, origin: "call", spoken: true }),
    ).toMatchObject({ origin: "call", spoken: true });
  });

  it("refuses an origin other than call", () => {
    for (const origin of ["post", "", null, true]) {
      expect(
        sendV13.requestSchema.safeParse({ ...REQUEST, origin }).success,
      ).toBe(false);
    }
  });

  it("is frozen on 1.2 without them: a 1.2 peer drops both", () => {
    const parsed = sendV12.requestSchema.parse({
      ...REQUEST,
      origin: "call",
      spoken: true,
    });

    expect(parsed).not.toHaveProperty("origin");
    expect(parsed).not.toHaveProperty("spoken");
  });

  it("upgrades a 1.2 request to one that opens no call and speaks nothing", () => {
    const upgrade = send.versions[3].upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.2 to 1.3 upgrade path");

    const upgraded = upgrade.upgradeRequest(
      sendV12.requestSchema.parse(REQUEST),
    );

    expect(upgraded).not.toHaveProperty("origin");
    expect(upgraded).not.toHaveProperty("spoken");
    expect(sendV13.requestSchema.safeParse(upgraded).success).toBe(true);
  });
});

describe("bot.thread.list@1.2", () => {
  it("keeps a call thread's kind", () => {
    expect(
      listV12.responseSchema.parse(listing({ ...SUMMARY, kind: "call" }))
        .threads[0],
    ).toMatchObject({ kind: "call" });
  });

  it("refuses a kind other than call", () => {
    for (const kind of ["post", "", null]) {
      expect(
        listV12.responseSchema.safeParse(listing({ ...SUMMARY, kind })).success,
      ).toBe(false);
    }
  });

  it("is frozen on 1.1 without it: a 1.1 peer drops the kind", () => {
    const parsed = listV11.responseSchema.parse(
      listing({ ...SUMMARY, kind: "call" }),
    );

    expect(parsed.threads[0]).not.toHaveProperty("kind");
  });
});
