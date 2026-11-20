import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";

/**
 * The message a member chose to reply to rides `bot.conversation.send@1.6`,
 * read off the registry so the pair a peer negotiates is what is held to the
 * shape.
 */

const send = hostRpcRegistry["bot.conversation.send"][1];
const sendV15 = send.versions[5].contract;
const sendV16 = send.versions[6].contract;

const REQUEST = {
  botId: "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1",
  conversationId: "conv-1",
  text: "Now",
};

describe("bot.conversation.send@1.6", () => {
  it("is the latest line, and upgrades a 1.5 request replying to no message", () => {
    expect(send.latestMinor).toBe(6);
    const parsed = sendV15.requestSchema.parse(REQUEST);
    const upgraded =
      send.versions[6].upgradeFromPreviousVersion.upgradeRequest(parsed);
    expect(upgraded).toEqual(parsed);
    expect(sendV16.requestSchema.parse(upgraded).replyTo).toBeUndefined();
  });

  it("keeps the message a member replies to", () => {
    expect(
      sendV16.requestSchema.parse({ ...REQUEST, replyTo: "message-1" }).replyTo,
    ).toBe("message-1");
  });

  it.each([
    ["an empty message id", ""],
    ["a message id over 255 characters", "m".repeat(256)],
  ])("refuses %s", (_name, replyTo) => {
    expect(
      sendV16.requestSchema.safeParse({ ...REQUEST, replyTo }).success,
    ).toBe(false);
  });

  it("is frozen on 1.5 without it: a 1.5 peer never sees the key", () => {
    const parsed = sendV15.requestSchema.parse({
      ...REQUEST,
      replyTo: "message-1",
    });
    expect(parsed).not.toHaveProperty("replyTo");
    expect(parsed).toEqual(sendV15.requestSchema.parse(REQUEST));
  });
});
