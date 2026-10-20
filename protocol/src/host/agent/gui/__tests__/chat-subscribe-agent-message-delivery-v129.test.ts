import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  chatSubscribeV123,
  chatSubscribeV124,
  chatSubscribeV125,
  chatSubscribeV126,
  chatSubscribeV127,
  chatSubscribeV128,
  chatSubscribeV129,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.29`: `agentMessageDelivery` on a `tool_call` block and on
 * its `tool_call.completed` event.
 *
 * PROJECTION, not tolerance: `1.23`-`1.28` bind hand-frozen copies without the
 * key, so a frame carrying it parses there with the key gone and everything
 * else intact - on the tail, a `range` response and `blockDelta`.
 */

const DELIVERY = {
  targetHostId: "host-2",
  eventId: "evt-1",
  state: "queued",
};

/** A cross-host send exactly as a 1.29 host persists it. */
function sendToolCall(): Record<string, unknown> {
  return {
    type: "tool_call",
    blockId: "block-1",
    status: "completed",
    timestamp: 5,
    toolName: "traycer_send_message",
    inputSummary: null,
    inputDetail: null,
    taskTodoItems: null,
    error: null,
    agentMessageSend: null,
    agentMessageReceipt: null,
    agentMessageDelivery: DELIVERY,
    managedCommand: null,
    progress: null,
    backgroundOutput: null,
    startedAt: 4,
    endedAt: 5,
    backgroundTask: false,
    stopped: false,
    imageResults: [],
    page: null,
    mcpApp: null,
  };
}

function assistantRow(blocks: readonly unknown[]): Record<string, unknown> {
  return {
    role: "assistant",
    messageId: "assistant-1",
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: "Coder",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks,
    startedAt: 1,
    timestamp: 6,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function snapshotFrame(message: unknown): Record<string, unknown> {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: {
      chat: {
        parentId: null,
        id: "chat-1",
        userId: "user-1",
        hostId: "host-1",
        title: "Chat",
        createdAt: 1000,
        updatedAt: 1000,
        isTitleEditedByUser: false,
      },
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      transcriptEpoch: 0,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [message], events: [] },
      derived: {
        latestAssistantUsage: null,
        pinnedTodo: null,
        pinnedTaskTodoItems: [],
        latestForkableAssistantMessageId: null,
        restorableSetupInterruption: null,
        interviewAnswerability: [],
        latestAssistantAuthFailureTurnKey: null,
        setupCardWindows: [],
      },
    },
  };
}

function rangeFrame(message: unknown): Record<string, unknown> {
  return {
    kind: "range",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    range: {
      requestId: "range-1",
      epoch: 0,
      fromOrdinal: 0,
      rowIds: ["assistant-1"],
      messages: [message],
      events: [],
      reachedStart: true,
      reachedEnd: true,
    },
  };
}

function completedEvent(
  stamps: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "tool_call.completed",
    blockId: "block-1",
    timestamp: 5,
    toolName: "traycer_send_message",
    ...stamps,
  };
}

function blockDeltaFrame(event: unknown): Record<string, unknown> {
  return {
    kind: "blockDelta",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    event,
  };
}

function has(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

const toolCallShape = z.object({ type: z.literal("tool_call") }).loose();
const messageWithBlocks = z.object({ blocks: z.array(z.unknown()) }).loose();

/** The first block of the one message a parsed snapshot tail / range carries. */
function firstToolCall(message: unknown): Record<string, unknown> {
  const blocks = messageWithBlocks.parse(message).blocks;
  return toolCallShape.parse(blocks[0]);
}

function tailMessage(parsed: { kind: string; snapshot?: unknown }): unknown {
  const snapshot = z
    .object({ tail: z.object({ messages: z.array(z.unknown()) }) })
    .parse(parsed.snapshot);
  return snapshot.tail.messages[0];
}

function rangeMessage(parsed: { kind: string; range?: unknown }): unknown {
  const range = z
    .object({ messages: z.array(z.unknown()) })
    .parse(parsed.range);
  return range.messages[0];
}

const FROZEN_LINES = [
  { label: "1.23", contract: chatSubscribeV123 },
  { label: "1.24", contract: chatSubscribeV124 },
  { label: "1.25", contract: chatSubscribeV125 },
  { label: "1.26", contract: chatSubscribeV126 },
  { label: "1.27", contract: chatSubscribeV127 },
  { label: "1.28", contract: chatSubscribeV128 },
] as const;

describe.each(FROZEN_LINES)(
  "chat.subscribe@$label never shows a peer a delivery state",
  ({ contract }) => {
    const frames = contract.serverFrameSchema;

    it("drops the key from a send block on the snapshot tail, keeping the call", () => {
      const parsed = frames.parse(
        snapshotFrame(assistantRow([sendToolCall()])),
      );
      const block = firstToolCall(tailMessage(parsed));
      expect(has(block, "agentMessageDelivery")).toBe(false);
      expect(block).toMatchObject({
        blockId: "block-1",
        toolName: "traycer_send_message",
        status: "completed",
      });
    });

    it("drops the key from a send block on a range response", () => {
      const parsed = frames.parse(rangeFrame(assistantRow([sendToolCall()])));
      const block = firstToolCall(rangeMessage(parsed));
      expect(has(block, "agentMessageDelivery")).toBe(false);
      expect(block).toMatchObject({ toolName: "traycer_send_message" });
    });

    it("drops the key from a tool_call.completed on blockDelta, keeping the event", () => {
      const parsed = frames.parse(
        blockDeltaFrame(completedEvent({ agentMessageDelivery: DELIVERY })),
      );
      if (parsed.kind !== "blockDelta") throw new Error("wrong kind");
      expect(has(parsed.event, "agentMessageDelivery")).toBe(false);
      expect(parsed.event).toMatchObject({
        type: "tool_call.completed",
        toolName: "traycer_send_message",
      });
    });
  },
);

describe("chat.subscribe@1.29 carries the delivery state", () => {
  const frames = chatSubscribeV129.serverFrameSchema;

  it("round-trips it on the snapshot tail and on a range response", () => {
    const row = assistantRow([sendToolCall()]);
    const tail = firstToolCall(tailMessage(frames.parse(snapshotFrame(row))));
    expect(tail).toMatchObject({ agentMessageDelivery: DELIVERY });
    const range = firstToolCall(rangeMessage(frames.parse(rangeFrame(row))));
    expect(range).toMatchObject({ agentMessageDelivery: DELIVERY });
  });

  it("round-trips it on a tool_call.completed blockDelta", () => {
    const parsed = frames.parse(
      blockDeltaFrame(completedEvent({ agentMessageDelivery: DELIVERY })),
    );
    if (parsed.kind !== "blockDelta") throw new Error("wrong kind");
    expect(parsed.event).toMatchObject({ agentMessageDelivery: DELIVERY });
  });

  it("defaults a block persisted without the key to null", () => {
    const block = sendToolCall();
    delete block.agentMessageDelivery;
    const tail = firstToolCall(
      tailMessage(frames.parse(snapshotFrame(assistantRow([block])))),
    );
    expect(tail).toMatchObject({ agentMessageDelivery: null });
  });
});

describe("chat.subscribe@1.27 is main's task-overdue line, minus the delivery state", () => {
  const OVERDUE_ITEM = {
    kind: "task-overdue",
    queueItemId: "q-1",
    description: "Report is overdue",
    createdAt: 1,
    updatedAt: 1,
  };

  function overdueSnapshot(): Record<string, unknown> {
    const frame = snapshotFrame(assistantRow([sendToolCall()]));
    const snapshot = frame.snapshot as Record<string, unknown>;
    return {
      ...frame,
      snapshot: {
        ...snapshot,
        queue: { status: "idle", items: [OVERDUE_ITEM] },
      },
    };
  }

  it("still parses a task-overdue queue item while stripping the key", () => {
    const parsed = chatSubscribeV127.serverFrameSchema.parse(overdueSnapshot());
    if (parsed.kind !== "snapshot") throw new Error("wrong kind");
    expect(parsed.snapshot.queue.items[0]).toMatchObject({
      kind: "task-overdue",
      queueItemId: "q-1",
    });
    const block = firstToolCall(tailMessage(parsed));
    expect(has(block, "agentMessageDelivery")).toBe(false);
  });

  it("1.26 does not know the task-overdue item", () => {
    expect(
      chatSubscribeV126.serverFrameSchema.safeParse(overdueSnapshot()).success,
    ).toBe(false);
  });

  it("1.29 carries both the task-overdue item and the key", () => {
    const parsed = chatSubscribeV129.serverFrameSchema.parse(overdueSnapshot());
    if (parsed.kind !== "snapshot") throw new Error("wrong kind");
    expect(parsed.snapshot.queue.items[0]).toMatchObject({
      kind: "task-overdue",
    });
    expect(firstToolCall(tailMessage(parsed))).toMatchObject({
      agentMessageDelivery: DELIVERY,
    });
  });
});
