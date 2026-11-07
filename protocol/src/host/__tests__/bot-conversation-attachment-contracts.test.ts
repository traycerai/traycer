import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  BOT_CONVERSATION_ATTACHMENT_MAX_BYTES,
  BOT_CONVERSATION_ATTACHMENTS_MAX,
  BOT_CONVERSATION_IMAGES_ONLY_TEXT,
} from "@traycer/protocol/host/bot/conversation-schemas";

/**
 * A member's images ride `bot.conversation.send@1.4`, read off the registry
 * so the pair a peer negotiates is what is held to the shape.
 */

const send = hostRpcRegistry["bot.conversation.send"][1];
const sendV13 = send.versions[3].contract;
const sendV14 = send.versions[4].contract;

const REQUEST = {
  botId: "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1",
  conversationId: "conv-1",
  text: "hello bot",
};

const IMAGE = {
  b64content: "iVBORw0KGgo=",
  mediaType: "image/png",
  fileName: "shot.png",
  size: 8,
};

describe("bot.conversation.send@1.4", () => {
  it("is the latest line, and upgrades a 1.3 request carrying no images", () => {
    expect(send.latestMinor).toBe(4);
    const parsed = sendV13.requestSchema.parse(REQUEST);
    const upgraded =
      send.versions[4].upgradeFromPreviousVersion.upgradeRequest(parsed);
    expect(upgraded).toEqual(parsed);
    expect(sendV14.requestSchema.parse(upgraded).attachments).toBeUndefined();
  });

  it("keeps an image beside the text a message of images alone sends", () => {
    expect(
      sendV14.requestSchema.parse({
        ...REQUEST,
        text: BOT_CONVERSATION_IMAGES_ONLY_TEXT,
        attachments: [IMAGE],
      }),
    ).toMatchObject({ attachments: [IMAGE] });
  });

  it("refuses what the bot's store does not take, and an empty or long list", () => {
    const refused = [
      [{ ...IMAGE, mediaType: "image/svg+xml" }],
      [{ ...IMAGE, size: BOT_CONVERSATION_ATTACHMENT_MAX_BYTES + 1 }],
      [{ ...IMAGE, fileName: "" }],
      [],
      Array.from({ length: BOT_CONVERSATION_ATTACHMENTS_MAX + 1 }, () => IMAGE),
    ];
    for (const attachments of refused) {
      expect(
        sendV14.requestSchema.safeParse({ ...REQUEST, attachments }).success,
      ).toBe(false);
    }
  });

  it("is frozen on 1.3 without them: a 1.3 peer drops the images and needs text", () => {
    const parsed = sendV13.requestSchema.parse({
      ...REQUEST,
      attachments: [IMAGE],
    });
    expect(parsed).not.toHaveProperty("attachments");
    expect(
      sendV13.requestSchema.safeParse({ ...REQUEST, text: "" }).success,
    ).toBe(false);
  });
});
