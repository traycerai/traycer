import { describe, expect, it } from "vitest";
import { ChatStreamClient } from "../chat-stream-client";
import {
  noopCallbacks,
  rangeEnvelope,
  snapshotEnvelope,
  stubClientAtVersion,
} from "./chat-stream-client-test-support";

/**
 * T356. `AssistantMessage.feedbackDraft` and `tool_call.feedbackDraftOrigin`
 * ride `chat.subscribe@1.45`. The shared stream client decodes a windowed
 * session with the live open union, so a consumer on a negotiated 1.45 session
 * must be handed both through each callback a transcript row reaches it by:
 * the snapshot's tail and a `range` response. What an older peer's frames hold
 * is pinned by the protocol freeze tests, not by this client.
 */

const STAMP = {
  category: "tool_problem",
  toolName: "traycer_run_shell",
  goal: "Restart a shell with a new working directory.",
  observed: "The process kept the old directory.",
  suggestion: null,
  suggestDiagnostics: false,
  state: "pending",
  decidedAt: null,
  failureReason: null,
};

const ORIGIN = {
  kind: "channel",
  botId: "bot-1",
  hostEpoch: 3,
  conversationId: "conv-1",
  initiatingMessageId: "msg-1",
  initiatingRequestId: "req-1",
};

const PROJECTION = {
  source: {
    hostId: "host-1",
    epicId: "epic-1",
    chatId: "chat-1",
    blockId: "block-1",
  },
  draft: STAMP,
};

function assistantRow(): Record<string, unknown> {
  return {
    role: "assistant",
    messageId: "assistant-1",
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: "Claude",
    },
    blocks: [
      {
        type: "tool_call",
        blockId: "block-1",
        status: "completed",
        timestamp: 5,
        toolName: "traycer_draft_feedback",
        error: null,
        feedbackDraft: STAMP,
        feedbackDraftOrigin: ORIGIN,
      },
    ],
    startedAt: 1,
    timestamp: 6,
    turnId: "turn-1",
    usage: null,
    feedbackDraft: PROJECTION,
  };
}

function openClient() {
  const { wsStreamClient, session } = stubClientAtVersion({
    major: 1,
    minor: 45,
  });
  const heard: { tail: unknown[]; range: unknown[] } = { tail: [], range: [] };
  const client = new ChatStreamClient({
    wsStreamClient,
    epicId: "epic-1",
    chatId: "chat-1",
    callbacks: noopCallbacks({
      onWindowedSnapshot: (frame) => {
        heard.tail.push(...frame.snapshot.tail.messages);
      },
      onRange: (frame) => {
        heard.range.push(...frame.range.messages);
      },
    }),
  });
  return { client, session, heard };
}

describe("ChatStreamClient on a negotiated 1.45 session", () => {
  it.each([
    ["the snapshot tail", "tail"],
    ["a range response", "range"],
  ] as const)(
    "hands %s the row with its feedback draft projection and tool origin",
    (_carrier, key) => {
      const { client, session, heard } = openClient();

      session.deliver(snapshotEnvelope([], [assistantRow()]));
      session.deliver(rangeEnvelope([], [assistantRow()]));

      const rows = heard[key];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ feedbackDraft: PROJECTION });
      expect(rows[0]).toMatchObject({
        blocks: [{ feedbackDraft: STAMP, feedbackDraftOrigin: ORIGIN }],
      });
      client.close();
    },
  );
});
