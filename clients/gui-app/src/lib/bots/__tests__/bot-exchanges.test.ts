import { describe, expect, it } from "vitest";
import {
  botExchangesOf,
  exchangeLogOf,
  exchangePairsOf,
  type BotExchange,
} from "@/lib/bots/bot-exchanges";
import {
  BOT_ID,
  DOCS_BOT_ID,
  FEED_HOST_ID,
  RELEASE_BOT_ID,
  THREAD_SESSION_ID,
  SENT_MIRROR,
  TRUNK_CHAT_ID,
  feedEvent,
  receivedBy,
  type FeedOrigin,
} from "@/lib/bots/__tests__/bot-exchange-test-support";

/**
 * A message row as the host writes each side: the receiving task's row names
 * the receiving session as its origin chat; the sending task's mirror has none.
 */
function message(input: {
  readonly id: number;
  readonly timestamp: number;
  readonly sender: string;
  readonly receiver: string;
  readonly peer: string | null;
  readonly responseId: string | null;
  readonly inReplyTo: string | null;
  readonly side: "sent" | "received";
}) {
  return feedEvent({
    origin: originOf(input),
    id: input.id,
    kind: "a2a_message",
    timestamp: input.timestamp,
    sender: input.sender,
    receiver: input.receiver,
    text: `message ${input.id}`,
    responseId: input.responseId,
    inReplyTo: input.inReplyTo,
    peerEpicId: input.peer,
  });
}

function originOf(input: {
  readonly id: number;
  readonly receiver: string;
  readonly side: "sent" | "received";
}): FeedOrigin {
  return input.side === "sent"
    ? SENT_MIRROR
    : receivedBy(input.receiver, `receipt-${input.id}`);
}

describe("botExchangesOf", () => {
  it("keeps only message rows whose far end is another bot", () => {
    const events = [
      message({
        id: 1,
        timestamp: 100,
        sender: TRUNK_CHAT_ID,
        receiver: "trunk-release",
        peer: RELEASE_BOT_ID,
        responseId: "r-1",
        inReplyTo: null,
        side: "sent",
      }),
      // A same-task row has no far end at all.
      message({
        id: 2,
        timestamp: 110,
        sender: TRUNK_CHAT_ID,
        receiver: "task-agent",
        peer: null,
        responseId: "r-2",
        inReplyTo: null,
        side: "sent",
      }),
      // A task's id is not a bot's: an agent of another task.
      message({
        id: 3,
        timestamp: 120,
        sender: TRUNK_CHAT_ID,
        receiver: "task-agent",
        peer: "epic-7f3a",
        responseId: "r-3",
        inReplyTo: null,
        side: "sent",
      }),
      // Looks like a bot id but is not the shape of one.
      message({
        id: 4,
        timestamp: 130,
        sender: TRUNK_CHAT_ID,
        receiver: "task-agent",
        peer: "bot_short",
        responseId: "r-4",
        inReplyTo: null,
        side: "sent",
      }),
      // The bot's own id as the far end is the bot talking to itself.
      message({
        id: 5,
        timestamp: 140,
        sender: TRUNK_CHAT_ID,
        receiver: THREAD_SESSION_ID,
        peer: BOT_ID,
        responseId: "r-5",
        inReplyTo: null,
        side: "sent",
      }),
      // A broker notice about an exchange is not a message of it.
      feedEvent({
        id: 6,
        kind: "a2a_notice",
        timestamp: 150,
        sender: "trunk-release",
        receiver: TRUNK_CHAT_ID,
        text: "No reply",
        responseId: "r-1",
        inReplyTo: null,
        peerEpicId: RELEASE_BOT_ID,
        origin: receivedBy(TRUNK_CHAT_ID, "receipt-6"),
      }),
      message({
        id: 7,
        timestamp: 160,
        sender: "trunk-docs",
        receiver: TRUNK_CHAT_ID,
        peer: DOCS_BOT_ID,
        responseId: "r-7",
        inReplyTo: null,
        side: "received",
      }),
    ];

    expect(
      botExchangesOf(events, BOT_ID).map((exchange) => [
        exchange.peerBotId,
        exchange.text,
      ]),
    ).toEqual([
      [RELEASE_BOT_ID, "message 1"],
      [DOCS_BOT_ID, "message 7"],
    ]);
  });

  it("reads the direction and the bot's own session from the row's origin", () => {
    const events = [
      message({
        id: 1,
        timestamp: 100,
        sender: TRUNK_CHAT_ID,
        receiver: "trunk-release",
        peer: RELEASE_BOT_ID,
        responseId: "r-1",
        inReplyTo: null,
        side: "sent",
      }),
      message({
        id: 2,
        timestamp: 110,
        sender: THREAD_SESSION_ID,
        receiver: "trunk-release",
        peer: RELEASE_BOT_ID,
        responseId: "r-2",
        inReplyTo: null,
        side: "sent",
      }),
      message({
        id: 3,
        timestamp: 120,
        sender: "trunk-release",
        receiver: THREAD_SESSION_ID,
        peer: RELEASE_BOT_ID,
        responseId: "r-2",
        inReplyTo: "r-2",
        side: "received",
      }),
      // A terminal session receives a message the same way a chat does.
      feedEvent({
        id: 4,
        kind: "a2a_message",
        timestamp: 130,
        sender: "trunk-docs",
        receiver: "terminal-session",
        text: "message 4",
        responseId: "r-4",
        inReplyTo: null,
        peerEpicId: DOCS_BOT_ID,
        origin: {
          originKind: "tui_session",
          originChatId: "terminal-session",
          originRefId: "receipt-4",
        },
      }),
    ];

    expect(
      botExchangesOf(events, BOT_ID).map((exchange) => [
        exchange.direction,
        exchange.ownAgentId,
      ]),
    ).toEqual([
      ["sent", TRUNK_CHAT_ID],
      ["sent", THREAD_SESSION_ID],
      ["received", THREAD_SESSION_ID],
      ["received", "terminal-session"],
    ]);
  });

  it("keeps a sent mirror from a session the GUI does not know as sent from that session", () => {
    const [exchange] = botExchangesOf(
      [
        message({
          id: 1,
          timestamp: 100,
          sender: "session-of-a-resumed-thread",
          receiver: "trunk-release",
          peer: RELEASE_BOT_ID,
          responseId: "r-1",
          inReplyTo: null,
          side: "sent",
        }),
      ],
      BOT_ID,
    );

    expect(exchange).toMatchObject({
      direction: "sent",
      ownAgentId: "session-of-a-resumed-thread",
    });
  });

  it("leaves out a row whose origin is neither side's, rather than guessing", () => {
    const wrongKind = feedEvent({
      id: 1,
      kind: "a2a_message",
      timestamp: 100,
      sender: TRUNK_CHAT_ID,
      receiver: "trunk-release",
      text: "message 1",
      responseId: "r-1",
      inReplyTo: null,
      peerEpicId: RELEASE_BOT_ID,
      origin: {
        originKind: "gui_block",
        originChatId: TRUNK_CHAT_ID,
        originRefId: null,
      },
    });
    const otherChat = feedEvent({
      id: 2,
      kind: "a2a_message",
      timestamp: 110,
      sender: "trunk-release",
      receiver: TRUNK_CHAT_ID,
      text: "message 2",
      responseId: "r-2",
      inReplyTo: null,
      peerEpicId: RELEASE_BOT_ID,
      origin: {
        originKind: "gui_message",
        originChatId: THREAD_SESSION_ID,
        originRefId: "receipt-2",
      },
    });

    expect(botExchangesOf([wrongKind, otherChat], BOT_ID)).toEqual([]);
  });

  it("keys a row by its cloud id, or by its host and row id before it has one", () => {
    const plain = message({
      id: 12,
      timestamp: 100,
      sender: TRUNK_CHAT_ID,
      receiver: "trunk-release",
      peer: RELEASE_BOT_ID,
      responseId: null,
      inReplyTo: null,
      side: "sent",
    });
    const cloud = { ...plain, id: 13, eventId: "cloud-event-13" };

    expect(
      botExchangesOf([plain, cloud], BOT_ID).map((exchange) => exchange.key),
    ).toEqual([`${FEED_HOST_ID}:12`, "cloud-event-13"]);
  });
});

function exchange(
  key: string,
  peerBotId: string,
  fields: Pick<BotExchange, "direction" | "responseId" | "inReplyTo">,
): BotExchange {
  return {
    key,
    timestamp: Number(key.slice(1)),
    peerBotId,
    ownAgentId: TRUNK_CHAT_ID,
    senderAgentId: fields.direction === "sent" ? TRUNK_CHAT_ID : "trunk-peer",
    text: key,
    ...fields,
  };
}

describe("exchangePairsOf", () => {
  it("counts each other bot's messages, in the order the run first reached it", () => {
    const run = [
      exchange("m1", RELEASE_BOT_ID, {
        direction: "sent",
        responseId: "r",
        inReplyTo: null,
      }),
      exchange("m2", DOCS_BOT_ID, {
        direction: "sent",
        responseId: "d",
        inReplyTo: null,
      }),
      exchange("m3", DOCS_BOT_ID, {
        direction: "received",
        responseId: "d",
        inReplyTo: "d",
      }),
    ];

    expect(exchangePairsOf(run)).toEqual([
      { peerBotId: RELEASE_BOT_ID, count: 1 },
      { peerBotId: DOCS_BOT_ID, count: 2 },
    ]);
  });
});

describe("exchangeLogOf", () => {
  it("lists one pair's messages oldest first and names the request a reply answers", () => {
    const request = exchange("m1", RELEASE_BOT_ID, {
      direction: "sent",
      responseId: "thread-a",
      inReplyTo: null,
    });
    const otherPair = exchange("m2", DOCS_BOT_ID, {
      direction: "received",
      responseId: "thread-a",
      inReplyTo: "thread-a",
    });
    // A message of the same side on the thread is not what a reply answers.
    const followUp = exchange("m3", RELEASE_BOT_ID, {
      direction: "sent",
      responseId: "thread-a",
      inReplyTo: "thread-a",
    });
    const reply = exchange("m4", RELEASE_BOT_ID, {
      direction: "received",
      responseId: "thread-a",
      inReplyTo: "thread-a",
    });
    const unanswered = exchange("m5", RELEASE_BOT_ID, {
      direction: "received",
      responseId: "thread-b",
      inReplyTo: "thread-never-seen",
    });

    const log = exchangeLogOf(
      [request, otherPair, followUp, reply, unanswered],
      RELEASE_BOT_ID,
    );

    expect(
      log.map((entry) => [entry.exchange.key, entry.replyTo?.key]),
    ).toEqual([
      ["m1", undefined],
      ["m3", undefined],
      ["m4", "m3"],
      ["m5", undefined],
    ]);
  });
});
