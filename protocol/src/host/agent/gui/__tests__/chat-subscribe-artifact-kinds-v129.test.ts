import { describe, expect, it } from "vitest";
import {
  chatSubscribeV128,
  chatSubscribeV129,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.29` lets an `artifact_operation` block and runtime event
 * name the html, canvas and file artifact kinds. `1.28` binds the frozen
 * pre-html schemas, so a frame carrying one of the new kinds is refused there
 * rather than stripped: a released peer cannot decode a kind it has never
 * heard of, and the host must not send it one.
 *
 * The line-surfaces test only searches the schema text for "canvas". These
 * cases parse real frames, which is the only check that the kind reaches both
 * the block (a snapshot tail and a range row) and the event (a blockDelta).
 */

const NEW_KINDS = ["html", "canvas", "file"] as const;
const MARKDOWN_KINDS = ["spec", "ticket", "story", "review"] as const;

function artifactOperationBlock(kind: string): Record<string, unknown> {
  return {
    blockId: "action-1:artifact-op:0",
    status: "completed",
    timestamp: 1,
    type: "artifact_operation",
    operation: "create",
    kind,
    artifactId: "artifact-1",
    title: "A page",
    beforeHash: null,
    afterHash: null,
  };
}

function artifactOperationEvent(kind: string): Record<string, unknown> {
  return {
    blockId: "action-1:artifact-op:0",
    timestamp: 1,
    type: "artifact_operation",
    operation: "create",
    kind,
    artifactId: "artifact-1",
    title: "A page",
    beforeHash: null,
    afterHash: null,
  };
}

function assistantRow(block: Record<string, unknown>): Record<string, unknown> {
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
    blocks: [block],
    startedAt: 1,
    timestamp: 2,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function snapshotFrame(
  block: Record<string, unknown>,
): Record<string, unknown> {
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
      queue: { status: "paused", items: [] },
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
      tail: { fromOrdinal: 0, messages: [assistantRow(block)], events: [] },
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

function rangeFrame(block: Record<string, unknown>): Record<string, unknown> {
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
      messages: [assistantRow(block)],
      events: [],
      reachedStart: true,
      reachedEnd: true,
    },
  };
}

function blockDeltaFrame(
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "blockDelta",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    event,
  };
}

const BLOCK_FRAMES = [
  { surface: "snapshot tail", frame: snapshotFrame },
  { surface: "range row", frame: rangeFrame },
] as const;

describe("chat.subscribe artifact_operation block kinds", () => {
  describe.each(BLOCK_FRAMES)("in a $surface", ({ frame }) => {
    it.each(NEW_KINDS)("@1.29 accepts a %s block", (kind) => {
      const result = chatSubscribeV129.serverFrameSchema.safeParse(
        frame(artifactOperationBlock(kind)),
      );
      expect(result.success).toBe(true);
    });

    it.each(NEW_KINDS)("@1.28 refuses a %s block", (kind) => {
      const result = chatSubscribeV128.serverFrameSchema.safeParse(
        frame(artifactOperationBlock(kind)),
      );
      expect(result.success).toBe(false);
    });

    it.each(MARKDOWN_KINDS)("both lines accept a %s block", (kind) => {
      const block = frame(artifactOperationBlock(kind));
      expect(chatSubscribeV128.serverFrameSchema.safeParse(block).success).toBe(
        true,
      );
      expect(chatSubscribeV129.serverFrameSchema.safeParse(block).success).toBe(
        true,
      );
    });

    it("@1.29 still refuses a kind that does not exist", () => {
      expect(
        chatSubscribeV129.serverFrameSchema.safeParse(
          frame(artifactOperationBlock("spreadsheet")),
        ).success,
      ).toBe(false);
    });
  });
});

describe("chat.subscribe artifact_operation event kinds", () => {
  it.each(NEW_KINDS)("@1.29 accepts a %s event", (kind) => {
    const result = chatSubscribeV129.serverFrameSchema.safeParse(
      blockDeltaFrame(artifactOperationEvent(kind)),
    );
    expect(result.success).toBe(true);
  });

  it.each(NEW_KINDS)("@1.28 refuses a %s event", (kind) => {
    const result = chatSubscribeV128.serverFrameSchema.safeParse(
      blockDeltaFrame(artifactOperationEvent(kind)),
    );
    expect(result.success).toBe(false);
  });

  it.each(MARKDOWN_KINDS)("both lines accept a %s event", (kind) => {
    const frame = blockDeltaFrame(artifactOperationEvent(kind));
    expect(chatSubscribeV128.serverFrameSchema.safeParse(frame).success).toBe(
      true,
    );
    expect(chatSubscribeV129.serverFrameSchema.safeParse(frame).success).toBe(
      true,
    );
  });

  it("@1.29 still refuses a kind that does not exist", () => {
    expect(
      chatSubscribeV129.serverFrameSchema.safeParse(
        blockDeltaFrame(artifactOperationEvent("spreadsheet")),
      ).success,
    ).toBe(false);
  });
});
