import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  chatQueuedItemSchema,
  chatSubscribeClientFrameSchema,
  chatSubscribeServerFrameSchema,
  chatSubscribeV20,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import type {
  Chat,
  ChatEvent,
  UserMessage,
} from "@traycer/protocol/persistence/epic/schemas";
import { describe, expect, it } from "vitest";

const attachmentMentionNodeSchema = getRecordSchema(
  commonRecordRegistry,
  "attachment-mention-node",
  "latest",
);

const userMessage: UserMessage = {
  role: "user",
  messageId: "message-1",
  sender: { type: "user", userId: "user-1" },
  message: {
    kind: "user",
    content: { type: "doc", content: [] },
  },
  timestamp: 1000,
  sessionAnchor: null,
};

const chat: Chat = {
  parentId: null,
  id: "chat-1",
  userId: "user-1",
  hostId: "test-host",
  title: "Chat",
  createdAt: 1000,
  updatedAt: 1000,
  isTitleEditedByUser: false,
  settings: null,
  activeSessionChain: null,
  messages: [userMessage],
  events: [],
};

const event: ChatEvent = {
  eventId: "event-1",
  type: "send.accepted",
  timestamp: 1001,
  clientActionId: "action-1",
  actor: { type: "user", userId: "user-1" },
  message: "Message accepted",
  turnId: null,
  messageId: "message-1",
  queueItemId: null,
  approvalId: null,
  blockId: null,
  severity: "info",
  metadata: null,
};

describe("chat.subscribe@2.0 open request", () => {
  it("requires an epicId and chatId", () => {
    const parsed = chatSubscribeV20.openRequestSchema.parse({
      epicId: "epic-1",
      chatId: "chat-1",
    });

    expect(parsed).toEqual({ epicId: "epic-1", chatId: "chat-1" });
    expect(() => chatSubscribeV20.openRequestSchema.parse({})).toThrow();
  });
});

describe("chat.subscribe@2.0 server frames", () => {
  it("parses queued steer-requested items with durable steer metadata", () => {
    const parsed = chatQueuedItemSchema.parse({
      queueItemId: "queue-1",
      messageId: "message-2",
      message: {
        kind: "user",
        content: { type: "doc", content: [] },
      },
      sender: { type: "user", userId: "user-1" },
      settings: {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        agentMode: "epic",
      },
      delivery: "same_turn",
      status: "steer_requested",
      targetTurnId: "turn-1",
      steerRequest: {
        mode: "safe_point",
        targetTurnId: "turn-1",
        requestedAt: 1002,
      },
      fallbackReason: null,
      createdAt: 1001,
      updatedAt: 1002,
    });

    expect(parsed.status).toBe("steer_requested");
    expect(parsed.steerRequest?.mode).toBe("safe_point");
  });

  it("parses a snapshot with generic, file-edit, and interview queues", () => {
    const parsed = chatSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat,
        access: {
          role: "owner",
          ownerUserId: "user-1",
          canAct: true,
        },
        queue: { status: "idle", items: [] },
        activeTurn: null,
        runStatus: "idle",
        pendingApprovals: [
          {
            approvalId: "approval-1",
            toolName: "bash",
            description: "Run a command",
            input: { command: "bun test" },
            requestedAt: 1002,
          },
        ],
        pendingInterviews: [
          {
            blockId: "question-1",
            requestedAt: 1004,
          },
        ],
        pendingFileEditApprovals: [
          {
            approvalId: "file-approval-1",
            toolName: "apply_patch",
            description: "Edit source files",
            paths: ["/repo/src/app.ts"],
            operation: "edit",
            input: { patch: "*** Begin Patch" },
            requestedAt: 1003,
          },
        ],
        worktreeBinding: null,
        missingWorktreePaths: [],
        accumulatedFileChanges: [],
      },
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind === "snapshot") {
      expect(parsed.snapshot.chat.events ?? []).toEqual([]);
      expect(parsed.snapshot.pendingApprovals).toHaveLength(1);
      expect(parsed.snapshot.pendingInterviews).toHaveLength(1);
      expect(parsed.snapshot.pendingFileEditApprovals).toHaveLength(1);
      expect(parsed.snapshot.backgroundItems).toBeUndefined();
    }
  });

  it("parses background items on snapshots and turn-state deltas", () => {
    const item = {
      taskId: "task-1",
      kind: "command",
      title: "bun test",
      blockId: "tool-1",
    };
    const snapshot = chatSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat,
        access: {
          role: "owner",
          ownerUserId: "user-1",
          canAct: true,
        },
        queue: { status: "idle", items: [] },
        activeTurn: null,
        runStatus: "idle",
        pendingApprovals: [],
        pendingInterviews: [],
        pendingFileEditApprovals: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        accumulatedFileChanges: [],
        backgroundItems: [item],
      },
    });
    const turnState = chatSubscribeServerFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: null,
      backgroundItems: [item],
    });

    expect(snapshot).toMatchObject({
      kind: "snapshot",
      snapshot: { backgroundItems: [item] },
    });
    expect(turnState).toMatchObject({
      kind: "turnStateChanged",
      backgroundItems: [item],
    });
  });

  it("parses action acknowledgements for accepted and rejected owner actions", () => {
    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        action: "send",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
      }),
    ).toMatchObject({ kind: "actionAck", status: "accepted" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-2",
        action: "stop",
        status: "rejected",
        reason: "Only the chat owner can stop a turn.",
        code: "NOT_OWNER",
        backgroundStopTaskIds: [],
      }),
    ).toMatchObject({ kind: "actionAck", status: "rejected" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-3",
        action: "editUserMessage",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
      }),
    ).toMatchObject({ kind: "actionAck", action: "editUserMessage" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-4",
        action: "restoreCheckpoint",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
      }),
    ).toMatchObject({ kind: "actionAck", action: "restoreCheckpoint" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-5",
        action: "fileEditApprovalDecision",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
      }),
    ).toMatchObject({
      kind: "actionAck",
      action: "fileEditApprovalDecision",
    });
  });

  it("parses durable event and live block delta frames separately", () => {
    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "eventAppended",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event,
      }),
    ).toMatchObject({ kind: "eventAppended" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "text.delta",
          blockId: "block-1",
          timestamp: 1002,
          delta: "hello",
        },
      }),
    ).toMatchObject({ kind: "blockDelta" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "text.completed",
          blockId: "block-1",
          timestamp: 1003,
        },
      }),
    ).toMatchObject({ kind: "blockDelta" });
  });

  it("parses checkpoint restore server frames", () => {
    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "restoreStarted",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        checkpointId: "turn-1",
        restoringUserId: "user-1",
        restoringHostId: "host-1",
        startedAt: 1003,
      }),
    ).toMatchObject({
      kind: "restoreStarted",
      checkpointId: "turn-1",
    });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "restoreProgress",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        checkpointId: "turn-1",
        processedCount: 1,
        totalCount: 2,
      }),
    ).toMatchObject({ kind: "restoreProgress", processedCount: 1 });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "restoreCompleted",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        checkpointId: "turn-1",
        finishedAt: 1004,
        results: [
          {
            filePath: "/repo/src/app.ts",
            status: "restored",
            operation: "edit",
            reason: null,
          },
        ],
      }),
    ).toMatchObject({
      kind: "restoreCompleted",
      results: [{ status: "restored" }],
    });
  });

  it("parses file-edit approval request and resolution frames", () => {
    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "fileEditApprovalRequested",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        approval: {
          approvalId: "file-approval-1",
          toolName: "Write",
          description: "Create a file",
          paths: ["/repo/src/new-file.ts"],
          operation: "create",
          input: { path: "/repo/src/new-file.ts" },
          requestedAt: 1005,
        },
      }),
    ).toMatchObject({
      kind: "fileEditApprovalRequested",
      approval: { operation: "create" },
    });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "fileEditApprovalResolved",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        approvalId: "file-approval-1",
        decision: { approved: true },
        resolvedAt: 1006,
      }),
    ).toMatchObject({
      kind: "fileEditApprovalResolved",
      approvalId: "file-approval-1",
    });
  });

  it("rejects non-concrete file-edit operations", () => {
    expect(() =>
      chatSubscribeServerFrameSchema.parse({
        kind: "fileEditApprovalRequested",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        approval: {
          approvalId: "file-approval-1",
          toolName: "Write",
          description: "Write a file",
          paths: ["/repo/src/app.ts"],
          operation: "ambiguous",
          input: null,
          requestedAt: 1005,
        },
      }),
    ).toThrow();
  });
});

describe("chat.subscribe@2.0 client frames", () => {
  it("requires clientActionId on owner action frames", () => {
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "stop",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        turnId: "turn-1",
      }),
    ).toMatchObject({ kind: "stop", clientActionId: "action-1" });

    expect(() =>
      chatSubscribeClientFrameSchema.parse({
        kind: "stop",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        turnId: "turn-1",
      }),
    ).toThrow();
  });

  it("parses background-item stop owner actions", () => {
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "stopBackgroundItem",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "stop-bg-action-1",
        taskId: "task-1",
      }),
    ).toMatchObject({
      kind: "stopBackgroundItem",
      taskId: "task-1",
    });

    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "stopAllBackgroundItems",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "stop-all-bg-action-1",
      }),
    ).toMatchObject({
      kind: "stopAllBackgroundItems",
    });
  });

  it("parses send frames with Tiptap JSONContent attachment mentions", () => {
    const attachmentMention = attachmentMentionNodeSchema.parse({
      type: "mention",
      attrs: {
        contextType: "attachment",
        fileName: "diagram.png",
        b64content: "aW1hZ2U=",
        url: "file://diagram.png",
        altText: "Architecture diagram",
      },
    });

    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "send",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "action-1",
      messageId: "message-2",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [attachmentMention],
          },
        ],
      },
      sender: { type: "user", userId: "user-1" },
      settings: {
        harnessId: "codex",
        model: "gpt-5.4",
        permissionMode: "supervised",
        reasoningEffort: "high",
        agentMode: "epic",
      },
      accountContext: { type: "PERSONAL" },
    });

    expect(parsed.kind).toBe("send");
  });

  it("parses message suffix delete and user-message edit frames", () => {
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "deleteMessageSuffix",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "delete-action-1",
        fromMessageId: "message-2",
      }),
    ).toMatchObject({
      kind: "deleteMessageSuffix",
      fromMessageId: "message-2",
    });

    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "editUserMessage",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "edit-action-1",
      targetMessageId: "message-2",
      messageId: "message-3",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Edited prompt" }],
          },
        ],
      },
      sender: { type: "user", userId: "user-1" },
      settings: {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        agentMode: "epic",
      },
      accountContext: { type: "PERSONAL" },
      revertFileChanges: false,
    });

    expect(parsed).toMatchObject({
      kind: "editUserMessage",
      targetMessageId: "message-2",
      messageId: "message-3",
      revertFileChanges: false,
    });
  });

  it("parses revert file-change owner actions", () => {
    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "revertFileChanges",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "revert-action-1",
      fromMessageId: null,
      filePaths: ["/repo/src/app.ts"],
    });

    expect(parsed).toMatchObject({
      kind: "revertFileChanges",
      fromMessageId: null,
      filePaths: ["/repo/src/app.ts"],
    });
  });

  it("parses queued steer-now owner actions", () => {
    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "queueSteerNow",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "steer-action-1",
      queueItemId: "queue-1",
      newSettings: null,
    });

    expect(parsed).toMatchObject({
      kind: "queueSteerNow",
      queueItemId: "queue-1",
      newSettings: null,
    });
  });

  it("parses queued settings restamp owner actions", () => {
    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "queueSettingsRestamp",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "restamp-action-1",
      settings: {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        agentMode: "epic",
      },
      accountContext: { type: "PERSONAL" },
      excludeQueueItemId: "queue-editing",
    });

    expect(parsed).toMatchObject({
      kind: "queueSettingsRestamp",
      excludeQueueItemId: "queue-editing",
    });
  });

  it("parses active permission mode update owner actions", () => {
    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "activePermissionModeUpdate",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "permission-action-1",
      permissionMode: "full_access",
    });

    expect(parsed).toMatchObject({
      kind: "activePermissionModeUpdate",
      permissionMode: "full_access",
    });
  });

  it("parses heartbeat pings without clientActionId", () => {
    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "ping",
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("ping");
  });

  it("parses restore checkpoint owner actions", () => {
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "restoreCheckpoint",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "restore-action-1",
        checkpointId: "turn-1",
      }),
    ).toMatchObject({
      kind: "restoreCheckpoint",
      checkpointId: "turn-1",
    });
  });

  it("parses file-edit approval decision owner actions", () => {
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "fileEditApprovalDecision",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "file-edit-action-1",
        approvalId: "file-approval-1",
        decision: { approved: false, reason: "Needs review" },
      }),
    ).toMatchObject({
      kind: "fileEditApprovalDecision",
      approvalId: "file-approval-1",
    });
  });
});
