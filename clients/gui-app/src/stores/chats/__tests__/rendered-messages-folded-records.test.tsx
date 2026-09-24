import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
} from "@/stores/chats/rendered-messages";
import type { ChatMessage } from "@/stores/composer/chat-store";

/**
 * A turn folded from several persisted records renders as one assistant row
 * set, and `persistentMessageId` names only the LAST record. Anything that
 * starts from an earlier record's id - a History hit, a find index hit - has
 * to be able to find the row, so the row carries every record it folds.
 */

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

const displayContext: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Agent",
    providerLabel: "Provider",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: () => null,
  contentBlocksPreview: () => "",
};

function userRecord(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function assistantRecord(
  messageId: string,
  turnId: string,
  timestamp: number,
): Message {
  return {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "codex",
      displayName: "Codex",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        type: "text",
        blockId: `text-${messageId}`,
        status: "completed",
        timestamp,
        text: `output of ${messageId}`,
        providerNotice: null,
      },
    ],
    startedAt: timestamp,
    timestamp,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function assistantRows(
  messages: ReadonlyArray<Message>,
): ReadonlyArray<ChatMessage> {
  const { result } = renderHook(() =>
    useRenderedMessages(
      {
        messages,
        events: [],
        rowContext: {},
        pendingUserMessages: [],
        withdrawnMessageId: null,
        liveAssistantMessage: null,
        activeTurn: null,
        runStatus: "idle",
        setupCardWindows: [],
        epicId: "epic-1",
        ownerId: "owner-1",
        ownerKind: "chat",
        viewTabId: "tab-1",
      },
      displayContext,
    ),
  );
  return result.current.filter((row) => row.role === "assistant");
}

describe("an assistant turn folded from several records", () => {
  it("names every record it folds, in fold order", () => {
    const rows = assistantRows([
      userRecord("u-1", 1),
      assistantRecord("a-first", "turn-folded", 2),
      assistantRecord("a-last", "turn-folded", 3),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].persistentMessageId).toBe("a-last");
    expect(rows[0].turnMessageIds).toEqual(["a-first", "a-last"]);
  });

  it("leaves a single-record turn to `persistentMessageId` alone", () => {
    const rows = assistantRows([
      userRecord("u-1", 1),
      assistantRecord("a-only", "turn-single", 2),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].persistentMessageId).toBe("a-only");
    expect(rows[0].turnMessageIds).toBeUndefined();
  });
});
