import { describe, expect, it } from "vitest";
import type {
  ChatQueuedItem,
  ChatQueueState,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  queuedPromptMessageIds,
  queueWithoutPersistedPrompts,
} from "@/components/chat/chat-queue-utils";

const SETTINGS = {
  harnessId: "grok" as const,
  model: "grok-4.7",
  permissionMode: "supervised" as const,
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic" as const,
  profileId: null,
};

const CONTENT = {
  type: "doc" as const,
  content: [
    {
      type: "paragraph" as const,
      content: [{ type: "text" as const, text: "Fix the copy button" }],
    },
  ],
};

function promptItem(messageId: string): ChatQueuedItem {
  return {
    kind: "prompt",
    queueItemId: `queue-${messageId}`,
    messageId,
    message: {
      kind: "user",
      content: CONTENT,
      browserAnnotations: [],
    },
    sender: { type: "user", userId: "owner-1" },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function commandItem(): ChatQueuedItem {
  return {
    kind: "managed-command",
    queueItemId: "queue-command",
    commandId: "command-1",
    hostId: null,
    description: "bun test",
    monitoring: true,
    delivery: "next_turn",
    targetTurnId: null,
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
  };
}

function queue(items: ReadonlyArray<ChatQueuedItem>): ChatQueueState {
  return { status: "running", items: [...items] };
}

describe("queuedPromptMessageIds", () => {
  it("names prompt rows and skips managed-command rows", () => {
    const ids = queuedPromptMessageIds([
      promptItem("message-initial"),
      commandItem(),
    ]);

    expect([...ids]).toEqual(["message-initial"]);
  });
});

describe("queueWithoutPersistedPrompts", () => {
  it("keeps a queued prompt that is not in the transcript yet", () => {
    const input = queue([promptItem("message-initial")]);

    const visible = queueWithoutPersistedPrompts(input, []);

    expect(visible).toBe(input);
  });

  it("drops a queued prompt once the transcript has that user message", () => {
    const followUp = promptItem("message-follow-up");
    const input = queue([promptItem("message-initial"), followUp]);

    const visible = queueWithoutPersistedPrompts(input, [
      { role: "user", messageId: "message-initial" },
    ]);

    expect(visible.items).toEqual([followUp]);
    expect(visible.status).toBe("running");
  });

  it("keeps a queued prompt that only matches an assistant row", () => {
    const input = queue([promptItem("message-waiting")]);

    const visible = queueWithoutPersistedPrompts(input, [
      { role: "assistant", messageId: "message-waiting" },
    ]);

    expect(visible).toBe(input);
  });

  it("leaves managed-command rows in place", () => {
    const command = commandItem();
    const input = queue([promptItem("message-sent"), command]);

    const visible = queueWithoutPersistedPrompts(input, [
      { role: "user", messageId: "message-sent" },
    ]);

    expect(visible.items).toEqual([command]);
  });

  it("keeps a paused prompt whose message is already in the transcript", () => {
    const failedStart = {
      ...promptItem("message-persisted"),
      status: "paused" as const,
    };
    const input: ChatQueueState = {
      status: "paused",
      items: [failedStart],
    };

    const visible = queueWithoutPersistedPrompts(input, [
      { role: "user", messageId: "message-persisted" },
    ]);

    expect(visible).toBe(input);
  });

  it("keeps a paused prompt beside a running queue and still hides the handoff", () => {
    const held = { ...promptItem("message-held"), status: "paused" as const };
    const handoff = promptItem("message-accepted");
    const input = queue([held, handoff]);

    const visible = queueWithoutPersistedPrompts(input, [
      { role: "user", messageId: "message-held" },
      { role: "user", messageId: "message-accepted" },
    ]);

    expect(visible.items).toEqual([held]);
    expect(visible.status).toBe("running");
  });
});
