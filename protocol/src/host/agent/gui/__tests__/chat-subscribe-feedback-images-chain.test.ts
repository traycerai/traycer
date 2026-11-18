import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  CHANNEL_ORIGIN,
  PROJECTION as SHARED_PROJECTION,
  STAMP,
} from "./feedback-draft-fixtures";

/**
 * Two independent additions to the `chat.subscribe` major-1 line, read through
 * each negotiated contract's own server-frame parser (no outbound projection):
 * 1.44 adds `images` on an `autonomous_resume` trigger's `conversationMessage`;
 * 1.45 adds `assistant.feedbackDraft` and `tool_call.feedbackDraftOrigin`.
 * One assistant row carries all of them; minors 43, 44 and 45 each decode it,
 * keeping exactly the leaves their line binds.
 */

const versions = hostStreamRpcRegistry["chat.subscribe"][1].versions;

const PROJECTION = {
  ...SHARED_PROJECTION,
  source: { ...SHARED_PROJECTION.source, blockId: "tool-1" },
};

const IMAGES = [
  {
    attachmentHash: "a1".repeat(32),
    mediaType: "image/png",
    fileName: "image.png",
  },
  {
    attachmentHash: "b2".repeat(32),
    mediaType: "image/png",
    fileName: "image.png",
  },
];

const MESSAGE_FIELDS = {
  conversationId: "channel-1",
  messageId: "message-1",
  requestId: "request-1",
  senderUserId: "user-1",
  postedAt: 5,
};

const TOOL_BLOCK = {
  type: "tool_call",
  blockId: "tool-1",
  status: "completed",
  timestamp: 1,
  toolName: "traycer_draft_feedback",
  error: null,
  feedbackDraft: STAMP,
  feedbackDraftOrigin: CHANNEL_ORIGIN,
};

const RESUME_BLOCK = {
  blockId: "resume-1",
  status: "completed",
  timestamp: 3,
  type: "autonomous_resume",
  deliveryPlacement: "turn_start",
  triggers: [
    {
      kind: "command",
      title: "Message from channel-1",
      status: "completed",
      summary: "A member wrote to the bot.",
      blockId: "",
      outputFile: null,
      mcp: null,
      live: false,
      managedCommand: null,
      conversationMessage: { ...MESSAGE_FIELDS, images: IMAGES },
    },
  ],
  wakeTriggers: [],
};

const ROW = {
  role: "assistant",
  messageId: "assistant-1",
  sender: {
    type: "agent",
    harnessId: "claude",
    agentId: "agent-1",
    displayName: null,
    reply: { expectsReply: false },
    inReplyTo: null,
  },
  blocks: [TOOL_BLOCK, RESUME_BLOCK],
  startedAt: 1,
  timestamp: 2,
  turnId: "turn-1",
  usage: null,
  feedbackDraft: PROJECTION,
};

const FRAME_BASE = {
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
};

const TAIL_FRAME = {
  ...FRAME_BASE,
  kind: "snapshot",
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
    tail: { fromOrdinal: 0, messages: [ROW], events: [] },
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

const RANGE_FRAME = {
  ...FRAME_BASE,
  kind: "range",
  range: {
    requestId: "range-1",
    epoch: 0,
    fromOrdinal: 0,
    rowIds: ["assistant-1"],
    messages: [ROW],
    events: [],
    rowContext: {},
    reachedStart: true,
    reachedEnd: true,
  },
};

const recordSchema = z.record(z.string(), z.unknown());
const arraySchema = z.array(z.unknown());

function asRecord(value: unknown): Record<string, unknown> {
  return recordSchema.parse(value);
}

function asArray(value: unknown): readonly unknown[] {
  return arraySchema.parse(value);
}

const CARRIERS = [
  [
    "tail",
    TAIL_FRAME,
    (frame: Record<string, unknown>) => asRecord(asRecord(frame.snapshot).tail),
  ],
  [
    "range",
    RANGE_FRAME,
    (frame: Record<string, unknown>) => asRecord(frame.range),
  ],
] as const;

interface DecodedRow {
  readonly row: Record<string, unknown>;
  readonly toolBlock: Record<string, unknown>;
  readonly conversationMessage: Record<string, unknown>;
}

function decode(
  minor: number,
  frame: unknown,
  containerOf: (frame: Record<string, unknown>) => Record<string, unknown>,
): DecodedRow {
  const result = versions[minor].contract.serverFrameSchema.safeParse(frame);
  expect(result.success).toBe(true);
  const container = containerOf(asRecord(result.data));
  const row = asRecord(asArray(container.messages)[0]);
  const blocks = asArray(row.blocks);
  const resume = asRecord(blocks[1]);
  return {
    row,
    toolBlock: asRecord(blocks[0]),
    conversationMessage: asRecord(
      asRecord(asArray(resume.triggers)[0]).conversationMessage,
    ),
  };
}

describe.each(CARRIERS)(
  "the combined row in a windowed %s frame",
  (_carrier, frame, containerOf) => {
    it("keeps no images, projection or origin on 1.43", () => {
      const decoded = decode(43, frame, containerOf);
      expect(decoded.conversationMessage).toEqual(MESSAGE_FIELDS);
      expect(decoded.row).not.toHaveProperty("feedbackDraft");
      expect(decoded.toolBlock).not.toHaveProperty("feedbackDraftOrigin");
      expect(decoded.toolBlock.feedbackDraft).toEqual(STAMP);
    });

    it("keeps the images but no projection or origin on 1.44", () => {
      const decoded = decode(44, frame, containerOf);
      expect(decoded.conversationMessage).toEqual({
        ...MESSAGE_FIELDS,
        images: IMAGES,
      });
      expect(decoded.row).not.toHaveProperty("feedbackDraft");
      expect(decoded.toolBlock).not.toHaveProperty("feedbackDraftOrigin");
      expect(decoded.toolBlock.feedbackDraft).toEqual(STAMP);
    });

    it("keeps the images, projection and origin on 1.45", () => {
      const decoded = decode(45, frame, containerOf);
      expect(decoded.conversationMessage).toEqual({
        ...MESSAGE_FIELDS,
        images: IMAGES,
      });
      expect(decoded.row.feedbackDraft).toEqual(PROJECTION);
      expect(decoded.toolBlock.feedbackDraftOrigin).toEqual(CHANNEL_ORIGIN);
      expect(decoded.toolBlock.feedbackDraft).toEqual(STAMP);
    });
  },
);
