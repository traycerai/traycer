import { describe, expect, it } from "vitest";
import {
  botSendRequestId,
  botThreadIdFor,
} from "@traycer/protocol/persistence/epic/messages";

/**
 * The ids a bot's send derives, which the app and the host compute alike:
 * the request id from the send's destination, sender and nonce, and the id of
 * the thread a post opens from the bot and the post.
 */

const TUPLE = {
  botId: "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1",
  conversationId: "conv-1",
  threadId: null,
  announcementId: null,
  senderUserId: "user-1",
  nonce: "6f1c2a52-8e1d-4f43-a1f6-0b7d4c3e9a10",
};

describe("botSendRequestId", () => {
  it("is deterministic, and a UUID", () => {
    const id = botSendRequestId(TUPLE);
    expect(id).toBe(botSendRequestId({ ...TUPLE }));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it.each([
    ["the bot", { botId: "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V2" }],
    ["the conversation", { conversationId: "conv-2" }],
    ["the thread", { threadId: "thread-1" }],
    ["the announcement", { announcementId: "announcement-1" }],
    ["the sender", { senderUserId: "user-2" }],
    ["the nonce", { nonce: "0a1b2c3d-8e1d-4f43-a1f6-0b7d4c3e9a10" }],
  ])("differs when %s differs", (_name, change) => {
    expect(botSendRequestId({ ...TUPLE, ...change })).not.toBe(
      botSendRequestId(TUPLE),
    );
  });

  it("names another request when a colon moves between two adjacent fields", () => {
    expect(
      botSendRequestId({ ...TUPLE, conversationId: "a:b", threadId: "c" }),
    ).not.toBe(
      botSendRequestId({ ...TUPLE, conversationId: "a", threadId: "b:c" }),
    );
  });

  it("is the id the app and the host have always derived for a fixed identity: a change of namespace, tuple order or encoding moves it", () => {
    expect(botSendRequestId(TUPLE)).toBe(
      "cb64741c-8ccd-55ba-81fc-c806793ba1b0",
    );
  });

  it("tells a thread from an announcement of the same id", () => {
    expect(
      botSendRequestId({ ...TUPLE, threadId: "x", announcementId: null }),
    ).not.toBe(
      botSendRequestId({ ...TUPLE, threadId: null, announcementId: "x" }),
    );
  });

  it("tells an absent thread from an empty one", () => {
    expect(botSendRequestId({ ...TUPLE, threadId: null })).not.toBe(
      botSendRequestId({ ...TUPLE, threadId: "" }),
    );
  });
});

// The values the host's own `botThreadIdFor` returns today, pinned so the
// shared function never moves a thread id: a UUID v5 of
// `bot-thread:<botId>:<anchorMessageId>` under the host's fixed namespace.
describe("botThreadIdFor", () => {
  it.each([
    [
      "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1",
      "conversation-request:6f1c2a52-0000-4000-8000-000000000001",
      "7a9abc09-f492-5c00-81b8-cd70ce069c89",
    ],
    [
      "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1",
      "announcement-1",
      "5c720ab7-c5ce-5d19-9b7e-a5723e5a9a0b",
    ],
    [
      "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "post-1",
      "2dc0ce9c-bb63-5097-91a6-b797a504001c",
    ],
  ])("returns the host's id for %s and %s", (botId, anchor, expected) => {
    expect(botThreadIdFor(botId, anchor)).toBe(expected);
  });
});
