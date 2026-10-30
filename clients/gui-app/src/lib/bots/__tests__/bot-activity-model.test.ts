import { describe, expect, it } from "vitest";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotSessionActivity } from "@traycer/protocol/host/bot/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import {
  stoppedPostOf,
  stoppedSessionsOf,
  type BotStoppedSession,
} from "@/lib/bots/bot-activity-model";

const CHANNEL_ID = "conversation-channel";

function failed(requestId: string | null): BotSessionActivity {
  return {
    state: "failed",
    startedAt: null,
    step: null,
    requestId,
    reason: null,
  };
}

function stopped(
  target: BotStoppedSession["target"],
  requestId: string,
): BotStoppedSession {
  return { target, session: failed(requestId), requestId };
}

/** A thread hanging off the post written for `anchorRequestId`. */
function thread(anchorRequestId: string): BotThreadSummary {
  return {
    threadId: "thread-a",
    conversationId: CHANNEL_ID,
    sessionChatId: "session-thread-a",
    anchor: {
      messageId: conversationRequestMessageId(anchorRequestId),
      requestId: anchorRequestId,
      senderUserId: "user-1",
      sentAt: 1_000,
      resolvedAt: null,
    },
    replyCount: 1,
    lastReplyAt: 2_000,
    openRequestCount: 0,
    costUsd: null,
  };
}

describe("stoppedSessionsOf", () => {
  it("lists the trunk first, then each thread, skipping a stopped session that names no request", () => {
    const sessions = stoppedSessionsOf({
      trunk: failed("req-trunk"),
      threads: {
        "thread-a": { ...failed("req-a"), state: "parked" },
        "thread-b": failed(null),
        "thread-c": { ...failed("req-c"), state: "idle" },
      },
    });

    expect(sessions.map((entry) => [entry.target, entry.requestId])).toEqual([
      [{ kind: "trunk" }, "req-trunk"],
      [{ kind: "thread", threadId: "thread-a" }, "req-a"],
    ]);
  });
});

describe("stoppedPostOf", () => {
  it("anchors the trunk's post in the channel, as the box that starts a thread until one hangs off it", () => {
    const messageId = conversationRequestMessageId("req-trunk");
    const session = stopped({ kind: "trunk" }, "req-trunk");

    expect(stoppedPostOf(session, [], CHANNEL_ID)).toEqual({
      messageId,
      sentIn: CHANNEL_ID,
      threadId: null,
      anchor: {
        conversationId: CHANNEL_ID,
        messageId,
        startsThread: true,
      },
    });
    expect(
      stoppedPostOf(session, [thread("req-trunk")], CHANNEL_ID).anchor
        ?.startsThread,
    ).toBe(false);
    expect(stoppedPostOf(session, [], null).anchor).toBeNull();
  });

  it("sends a thread's reply in the thread and the post its thread opens on in the channel", () => {
    const listed = [thread("req-opener")];
    const reply = stoppedPostOf(
      stopped({ kind: "thread", threadId: "thread-a" }, "req-reply"),
      listed,
      CHANNEL_ID,
    );
    const opener = stoppedPostOf(
      stopped({ kind: "thread", threadId: "thread-a" }, "req-opener"),
      listed,
      CHANNEL_ID,
    );

    expect(reply.sentIn).toBe("thread-a");
    expect(reply.threadId).toBe("thread-a");
    expect(opener.sentIn).toBe(CHANNEL_ID);
    expect(opener.threadId).toBeNull();
    expect(opener.anchor).toEqual({
      conversationId: CHANNEL_ID,
      messageId: conversationRequestMessageId("req-opener"),
      startsThread: false,
    });
  });

  it("knows nothing of a thread the list does not have", () => {
    const post = stoppedPostOf(
      stopped({ kind: "thread", threadId: "thread-gone" }, "req-x"),
      [thread("req-opener")],
      CHANNEL_ID,
    );

    expect(post).toEqual({
      messageId: conversationRequestMessageId("req-x"),
      sentIn: null,
      threadId: null,
      anchor: null,
    });
  });
});
