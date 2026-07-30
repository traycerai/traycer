import { describe, expect, it } from "vitest";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import {
  commGraphJumpAgentId,
  commGraphJumpTarget,
} from "@/lib/comm-graph/comm-graph-jump";

function event(overrides: Partial<CommGraphEvent>): CommGraphEvent {
  return {
    hostId: "host-a",
    id: 1,
    timestamp: 10,
    kind: "a2a_message",
    senderAgentId: "sender",
    receiverAgentId: "receiver",
    responseId: "r1",
    inReplyTo: null,
    expectReply: false,
    messageText: "hi",
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    ...overrides,
  };
}

describe("commGraphJumpTarget", () => {
  it("resolves a gui_block ref to the anchored block in its chat", () => {
    expect(
      commGraphJumpTarget(
        event({
          kind: "a2a_message",
          senderAgentId: null,
          receiverAgentId: null,
          originKind: "gui_block",
          originChatId: "chat-1",
          originRefId: "block-9",
        }),
      ),
    ).toEqual({ kind: "chat-block", chatId: "chat-1", blockId: "block-9" });
  });

  it("resolves a gui_message ref to the RECEIVER's delivered message", () => {
    // Origin refs are receiver-side: the sender's block id is its harness's own
    // tool_use id and never reaches the host.
    expect(
      commGraphJumpTarget(
        event({
          originKind: "gui_message",
          originChatId: "receiver",
          originRefId: "message-4",
        }),
      ),
    ).toEqual({
      kind: "chat-message",
      chatId: "receiver",
      messageId: "message-4",
    });
  });

  it("opens the terminal agent for a tui_session ref, with no anchor", () => {
    expect(
      commGraphJumpTarget(
        event({
          originKind: "tui_session",
          originChatId: "tui-1",
          originRefId: "harness-session-7",
        }),
      ),
    ).toEqual({ kind: "agent", agentId: "tui-1" });
  });

  it("still opens the terminal agent when it was never launched (null session id)", () => {
    expect(
      commGraphJumpTarget(
        event({
          originKind: "tui_session",
          originChatId: "tui-1",
          originRefId: null,
        }),
      ),
    ).toEqual({ kind: "agent", agentId: "tui-1" });
  });

  it("opens the receiver for an A2A row with no origin ref", () => {
    expect(commGraphJumpTarget(event({ originKind: null }))).toEqual({
      kind: "agent",
      agentId: "receiver",
    });
  });

  it("falls back to the sender when the row has no receiver", () => {
    expect(
      commGraphJumpTarget(event({ originKind: null, receiverAgentId: null })),
    ).toEqual({ kind: "agent", agentId: "sender" });
  });

  it("degrades a half-populated GUI ref to the owning agent", () => {
    expect(
      commGraphJumpTarget(
        event({
          originKind: "gui_block",
          originChatId: "chat-1",
          originRefId: null,
        }),
      ),
    ).toEqual({ kind: "agent", agentId: "receiver" });
  });

  it("resolves to nothing when the row names no agent at all", () => {
    expect(
      commGraphJumpTarget(
        event({
          originKind: null,
          senderAgentId: null,
          receiverAgentId: null,
        }),
      ),
    ).toBeNull();
  });
});

describe("commGraphJumpAgentId", () => {
  it("names the chat for a transcript anchor and the agent otherwise", () => {
    expect(
      commGraphJumpAgentId({
        kind: "chat-block",
        chatId: "chat-1",
        blockId: "b",
      }),
    ).toBe("chat-1");
    expect(commGraphJumpAgentId({ kind: "agent", agentId: "tui-1" })).toBe(
      "tui-1",
    );
  });
});
