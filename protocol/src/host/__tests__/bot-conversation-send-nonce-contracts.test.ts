import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";

/**
 * The send identifier a member's message carries rides
 * `bot.conversation.send@1.7`, read off the registry so the pair a peer
 * negotiates is what is held to the shape.
 */

const send = hostRpcRegistry["bot.conversation.send"][1];
const sendV16 = send.versions[6].contract;
const sendV17 = send.versions[7];

const REQUEST = {
  botId: "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1",
  conversationId: "conv-1",
  text: "Now",
};

const NONCE = "6f1c2a52-8e1d-4f43-a1f6-0b7d4c3e9a10";

describe("bot.conversation.send@1.7", () => {
  it("is the latest line, and upgrades a 1.6 request carrying no send identifier", () => {
    expect(send.latestMinor).toBe(7);
    const parsed = sendV16.requestSchema.parse(REQUEST);
    const upgraded = sendV17.upgradeFromPreviousVersion.upgradeRequest(parsed);
    expect(upgraded).toEqual(parsed);
    expect(
      sendV17.contract.requestSchema.parse(upgraded).sendNonce,
    ).toBeUndefined();
  });

  it("keeps the send identifier a client minted", () => {
    expect(
      sendV17.contract.requestSchema.parse({ ...REQUEST, sendNonce: NONCE })
        .sendNonce,
    ).toBe(NONCE);
  });

  it.each([
    ["a word", "not-a-uuid"],
    ["an empty string", ""],
    ["a UUID with a character too many", `${NONCE}0`],
  ])("refuses %s as the send identifier", (_name, sendNonce) => {
    expect(
      sendV17.contract.requestSchema.safeParse({ ...REQUEST, sendNonce })
        .success,
    ).toBe(false);
  });

  it("is frozen on 1.6 without it: a 1.6 peer never sees the key", () => {
    const parsed = sendV16.requestSchema.parse({
      ...REQUEST,
      sendNonce: NONCE,
    });
    expect(parsed).not.toHaveProperty("sendNonce");
    expect(parsed).toEqual(sendV16.requestSchema.parse(REQUEST));
  });
});
