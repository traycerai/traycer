import { describe, expect, it } from "vitest";
import { buildChatUserMessageMinimapItems } from "../chat-user-message-minimap-items";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { JsonContent } from "@traycer/protocol/common/registry";

function makeMessage(
  overrides: Partial<ChatMessageModel> & Pick<ChatMessageModel, "id" | "role">,
): ChatMessageModel {
  return {
    content: `content-${overrides.id}`,
    segments: [],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 0,
    completedAt: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
    ...overrides,
  };
}

describe("buildChatUserMessageMinimapItems", () => {
  it("includes user-authored messages", () => {
    const items = buildChatUserMessageMinimapItems([
      makeMessage({ id: "u1", role: "user" }),
      makeMessage({ id: "u2", role: "user" }),
    ]);
    expect(items.map((item) => item.id)).toEqual(["u1", "u2"]);
  });

  it("preserves structured content for shared static rendering", () => {
    const structuredContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Image-aware prompt" }],
        },
      ],
    };
    const items = buildChatUserMessageMinimapItems([
      makeMessage({
        id: "u1",
        role: "user",
        structuredContent,
      }),
    ]);
    expect(items[0]?.structuredContent).toBe(structuredContent);
  });

  it("excludes assistant messages", () => {
    const items = buildChatUserMessageMinimapItems([
      makeMessage({ id: "u1", role: "user" }),
      makeMessage({ id: "a1", role: "assistant" }),
    ]);
    expect(items.map((item) => item.id)).toEqual(["u1"]);
  });

  it("excludes A2A responses received from other agents", () => {
    const items = buildChatUserMessageMinimapItems([
      makeMessage({ id: "u1", role: "user" }),
      makeMessage({
        id: "a2a1",
        role: "user",
        agentSenderInfo: {
          agentId: "agent-123",
          senderTitle: "Sibling agent",
          expectReply: false,
          responseId: null,
        },
      }),
      makeMessage({ id: "u2", role: "user" }),
    ]);
    expect(items.map((item) => item.id)).toEqual(["u1", "u2"]);
  });
});
