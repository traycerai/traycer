import { describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatActiveTurn,
  ChatQueueState,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatMessage } from "@/stores/composer/chat-store";
import {
  chatMessageEditingForInlineEdit,
  resolvedTurnStatus,
  type InlineEditState,
} from "../chat-tile-session-state";

const CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "hello" }],
    },
  ],
};

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
};

const MESSAGE: ChatMessage = {
  id: "message-1",
  role: "user",
  content: "hello",
  segments: [],
  structuredContent: CONTENT,
  attachments: [],
  settings: null,
  createdAt: 0,
  completedAt: null,
  persistentMessageId: "persisted-message-1",
  senderLabel: null,
  assistantMeta: null,
  statusLabel: null,
  agentSenderInfo: null,
  agentMessage: null,
  runState: null,
  sessionAnchor: null,
  steerBadge: null,
};

function inlineEditState(dirty: boolean): InlineEditState {
  return {
    targetMessageId: "persisted-message-1",
    originalMessage: MESSAGE,
    initialContent: CONTENT,
    currentContent: CONTENT,
    dirty,
    pendingClientActionId: null,
    pendingMessageId: null,
  };
}

function renderInlineEdit(dirty: boolean) {
  const editing = chatMessageEditingForInlineEdit({
    editing: inlineEditState(dirty),
    canModifyMessages: true,
    editSettings: SETTINGS,
    mentionRoots: [],
    currentEpicId: "epic-1",
    onSnapshot: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
  });

  if (editing === null) {
    throw new Error("Expected inline edit view model");
  }
  return editing;
}

describe("chatMessageEditingForInlineEdit", () => {
  it("requires a dirty edit before enabling submit", () => {
    expect(renderInlineEdit(false).canSubmit).toBe(false);
    expect(renderInlineEdit(true).canSubmit).toBe(true);
  });
});

const ACTIVE_TURN: ChatActiveTurn = {
  turnId: "turn-1",
  status: "running",
  harnessId: "codex",
  model: "codex-test",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  userMessageId: "message-1",
  startedAt: 0,
  updatedAt: 0,
};

const EMPTY_QUEUE: ChatQueueState = { status: "idle", items: [] };

function runnableQueue(itemCount: number): ChatQueueState {
  return {
    status: "running",
    items: Array.from({ length: itemCount }, (_, index) => ({
      queueItemId: `item-${index}`,
      messageId: `message-${index}`,
      message: { kind: "user" as const, content: CONTENT },
      sender: { type: "user" as const, userId: "owner-1" },
      settings: SETTINGS,
      accountContext: { type: "PERSONAL" as const },
      delivery: "next_turn" as const,
      status: "pending" as const,
      targetTurnId: null,
      steerRequest: null,
      fallbackReason: null,
      createdAt: 0,
      updatedAt: 0,
    })),
  };
}

describe("resolvedTurnStatus - no turnInProgress from the host (older-host fallback heuristic)", () => {
  it("passes null through unchanged (idle chat)", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        null,
      ),
    ).toBeNull();
  });

  it("returns the turn status when a turn is genuinely active", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: ACTIVE_TURN,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("returns the turn status when a turn is genuinely active even alongside a queued item or background work", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: ACTIVE_TURN,
          queue: runnableQueue(1),
          backgroundItems: [
            { taskId: "t1", kind: "subagent", title: "Sub", blockId: "t1" },
          ],
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("falls back to null when runStatus is running purely because of a pending queued item (no active turn)", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: runnableQueue(1),
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBeNull();
  });

  it("falls back to null when runStatus is running purely because of visible background work (no active turn) - the reported regression", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: [
            { taskId: "t1", kind: "subagent", title: "Sub", blockId: "t1" },
          ],
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBeNull();
  });

  it("keeps the turn status when running is explained by neither the queue nor background work (the pre-turn activating window)", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("a paused queue with pending items does not count as runnable", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: { status: "paused", items: runnableQueue(1).items },
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("an empty backgroundItems array does not count as visible background work", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: [],
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("known gap: a turn still activating with another item queued behind it is (incorrectly) treated as not active", () => {
    // Documents the precision gap the host-sent `turnInProgress` layer
    // exists to close - see the next describe block.
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: runnableQueue(1),
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBeNull();
  });
});

describe("resolvedTurnStatus - turnInProgress present (host-sent, exact)", () => {
  it("turnInProgress: true overrides the heuristic even when it would say not-active (closes the activating+queued-behind gap)", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: runnableQueue(1),
          backgroundItems: undefined,
          turnInProgress: true,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("turnInProgress: false overrides the heuristic even when it would say active (background-only phase)", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: false,
        },
        "running",
      ),
    ).toBeNull();
  });

  it("turnInProgress: false wins even when activeTurn is (unexpectedly) non-null", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: ACTIVE_TURN,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: false,
        },
        "running",
      ),
    ).toBeNull();
  });

  it("null turnStatus (already idle) short-circuits regardless of turnInProgress", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: true,
        },
        null,
      ),
    ).toBeNull();
  });
});
