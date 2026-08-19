import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/stores/composer/chat-store";
import { transientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";
import { latestForkableAssistantMessageId } from "../chat-tile-session-state";

// Minimal fixture mirroring the shape built in
// `chat-tile-session-state.test.ts`'s `MESSAGE` constant - every field the
// `ChatMessage` interface requires, defaulted to its "nothing special going
// on" value so each test only overrides what it is actually exercising.
const BASE_ASSISTANT_MESSAGE: ChatMessage = {
  id: "assistant-base",
  role: "assistant",
  content: "hello",
  segments: [],
  structuredContent: null,
  attachments: [],
  settings: null,
  createdAt: 0,
  completedAt: 100,
  stopped: null,
  persistentMessageId: "persisted-assistant-base",
  senderLabel: null,
  assistantMeta: null,
  statusLabel: null,
  agentSenderInfo: null,
  agentMessage: null,
  runState: null,
  sessionAnchor: null,
  steerBadge: null,
};

function assistantMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return { ...BASE_ASSISTANT_MESSAGE, ...overrides };
}

function userMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    ...BASE_ASSISTANT_MESSAGE,
    role: "user",
    completedAt: null,
    runState: null,
    ...overrides,
  };
}

describe("latestForkableAssistantMessageId", () => {
  it("returns null for an empty transcript", () => {
    expect(latestForkableAssistantMessageId([])).toBeNull();
  });

  it("returns null when only user messages are present", () => {
    const messages = [
      userMessage({ id: "u-1", persistentMessageId: "persisted-u-1" }),
      userMessage({ id: "u-2", persistentMessageId: "persisted-u-2" }),
    ];

    expect(latestForkableAssistantMessageId(messages)).toBeNull();
  });

  it("returns the latest COMPLETED assistant message, not a still-streaming one after it", () => {
    const messages = [
      assistantMessage({
        id: "a-1",
        persistentMessageId: "persisted-a-1",
        completedAt: 100,
        runState: null,
      }),
      // The live row: not yet completed, still streaming its turn.
      assistantMessage({
        id: "a-2",
        persistentMessageId: "persisted-a-2",
        completedAt: null,
        runState: "running",
      }),
    ];

    expect(latestForkableAssistantMessageId(messages)).toBe("persisted-a-1");
  });

  it("returns the LATER of two completed assistant messages", () => {
    const messages = [
      assistantMessage({
        id: "a-1",
        persistentMessageId: "persisted-a-1",
        completedAt: 100,
      }),
      assistantMessage({
        id: "a-2",
        persistentMessageId: "persisted-a-2",
        completedAt: 200,
      }),
    ];

    expect(latestForkableAssistantMessageId(messages)).toBe("persisted-a-2");
  });

  it("skips a completed assistant message whose persistent id is still the transient live placeholder", () => {
    const messages = [
      assistantMessage({
        id: "a-1",
        persistentMessageId: "persisted-a-1",
        completedAt: 100,
      }),
      // Completed and otherwise fork-eligible, but its id never resolved past
      // the transient live placeholder - not a durable fork boundary.
      assistantMessage({
        id: "a-2",
        persistentMessageId: transientLiveAssistantMessageId("turn-2"),
        completedAt: 200,
        runState: null,
      }),
    ];

    expect(latestForkableAssistantMessageId(messages)).toBe("persisted-a-1");
  });
});
