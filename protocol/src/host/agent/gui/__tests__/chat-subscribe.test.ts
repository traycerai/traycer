import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  chatQueuedItemSchema,
  chatSubscribeClientFrameSchema,
  chatSubscribeServerFrameSchema,
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { autonomousResumeTriggerSchema } from "@traycer/protocol/persistence/epic/content-blocks";
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
  claudePendingWakes: [],
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

describe("chat.subscribe@1.2 open request", () => {
  it("requires an epicId and chatId", () => {
    const parsed = chatSubscribeV12.openRequestSchema.parse({
      epicId: "epic-1",
      chatId: "chat-1",
    });

    expect(parsed).toEqual({ epicId: "epic-1", chatId: "chat-1" });
    expect(() => chatSubscribeV12.openRequestSchema.parse({})).toThrow();
  });
});

describe("chat.subscribe@1.0 (frozen host-v1.0.0 shape)", () => {
  it("parses the actionAck shape host-v1.0.0 actually emits, before background-items existed", () => {
    expect(
      chatSubscribeV10.serverFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        action: "send",
        status: "accepted",
        reason: null,
        code: null,
      }),
    ).toMatchObject({ kind: "actionAck", status: "accepted" });
  });

  it("does not know the v1.1 background-stop client actions - host-v1.0.0 never learned them", () => {
    expect(
      chatSubscribeV10.clientFrameSchema.safeParse({
        kind: "stopBackgroundItem",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        taskId: "task-1",
      }).success,
    ).toBe(false);
  });
});

describe("chat.subscribe@1.1 server frames", () => {
  it("does not know the v1.2 wakeup background-item kind", () => {
    expect(
      chatSubscribeV11.serverFrameSchema.safeParse({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        runStatus: "running",
        activeTurn: null,
        backgroundItems: [
          {
            taskId: "wake-tool-1",
            kind: "wakeup",
            title: "Standup",
            blockId: "wake-tool-1",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("chat.subscribe@1.2 server frames", () => {
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
    const wakeupItem = {
      taskId: "wake-tool-1",
      kind: "wakeup",
      title: "Standup",
      blockId: "wake-tool-1",
      parentTaskId: null,
      scheduledFor: 123456,
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
        backgroundItems: [item, wakeupItem],
      },
    });
    const turnState = chatSubscribeServerFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: null,
      backgroundItems: [item, wakeupItem],
    });

    expect(snapshot).toMatchObject({
      kind: "snapshot",
      snapshot: { backgroundItems: [item, wakeupItem] },
    });
    expect(turnState).toMatchObject({
      kind: "turnStateChanged",
      backgroundItems: [item, wakeupItem],
    });
  });

  it("requires wakeup background items to carry a scheduled timestamp", () => {
    const wakeupBase = {
      taskId: "wake-tool-1",
      kind: "wakeup",
      title: "Standup",
      blockId: "wake-tool-1",
      parentTaskId: null,
    };
    const parseResults = [
      wakeupBase,
      { ...wakeupBase, scheduledFor: null },
    ].map((wakeupItem) =>
      chatSubscribeServerFrameSchema.safeParse({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        runStatus: "running",
        activeTurn: null,
        backgroundItems: [wakeupItem],
      }),
    );

    expect(parseResults.map((result) => result.success)).toEqual([
      false,
      false,
    ]);
  });

  it("defaults new background-item metadata when parsing old-host frames", () => {
    const parsed = chatSubscribeServerFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: null,
      backgroundItems: [
        {
          taskId: "task-1",
          kind: "command",
          title: "bun test",
          blockId: "tool-1",
        },
      ],
    });

    expect(parsed).toMatchObject({
      kind: "turnStateChanged",
      backgroundItems: [
        {
          taskId: "task-1",
          parentTaskId: null,
          scheduledFor: null,
        },
      ],
    });
  });

  it("parses the pinned wakeup autonomous-resume trigger shape", () => {
    const parsed = autonomousResumeTriggerSchema.parse({
      kind: "wakeup",
      title: "Standup",
      summary: "Write the standup update.",
      status: "completed",
      blockId: "wake-tool-1",
      outputFile: null,
    });

    expect(parsed).toEqual({
      kind: "wakeup",
      title: "Standup",
      summary: "Write the standup update.",
      status: "completed",
      blockId: "wake-tool-1",
      outputFile: null,
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

  it("defaults backgroundStopTaskIds to [] on a chat.subscribe@1.0-shaped ack (host-v1.0.0 never sends it)", () => {
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
        // backgroundStopTaskIds omitted - the exact shape a chat.subscribe@1.0
        // host emits, since it predates background-items support entirely.
      }),
    ).toMatchObject({ kind: "actionAck", backgroundStopTaskIds: [] });
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

describe("chat.subscribe@1.3 client frames", () => {
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

  it("parses pause queue owner actions", () => {
    expect(chatSubscribeV13.schemaVersion).toEqual({ major: 1, minor: 3 });
    expect(
      chatSubscribeV12.clientFrameSchema.safeParse({
        kind: "pauseQueue",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "pause-queue-action-1",
      }).success,
    ).toBe(false);
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "pauseQueue",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "pause-queue-action-1",
      }),
    ).toMatchObject({
      kind: "pauseQueue",
      clientActionId: "pause-queue-action-1",
    });
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

describe("chat.subscribe@1.3 (frozen pre-workflow) server frames", () => {
  it("declares schemaVersion 1.3 and stays registered for bridging", () => {
    expect(chatSubscribeV13.schemaVersion).toEqual({ major: 1, minor: 3 });
  });

  it("does not know the v1.4 workflow background-item kind on snapshot or turn-state frames", () => {
    const workflowItem = {
      taskId: "wf-task-1",
      kind: "workflow",
      title: "review",
      blockId: "wf-task-1",
      parentTaskId: null,
      phase: "Find",
      activeLabel: "find:host-core",
      agentsStarted: 16,
      agentsFinished: 3,
    };

    expect(
      chatSubscribeV13.serverFrameSchema.safeParse({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        runStatus: "running",
        activeTurn: null,
        backgroundItems: [workflowItem],
      }).success,
    ).toBe(false);

    expect(
      chatSubscribeV13.serverFrameSchema.safeParse({
        kind: "snapshot",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        snapshot: {
          chat,
          access: { role: "owner", ownerUserId: "user-1", canAct: true },
          queue: { status: "idle", items: [] },
          activeTurn: null,
          runStatus: "idle",
          pendingApprovals: [],
          pendingInterviews: [],
          pendingFileEditApprovals: [],
          worktreeBinding: null,
          missingWorktreePaths: [],
          accumulatedFileChanges: [],
          backgroundItems: [workflowItem],
        },
      }).success,
    ).toBe(false);
  });

  it("does not know the v1.4 workflow.* blockDelta events", () => {
    const events = [
      {
        type: "workflow.started",
        blockId: "wf-1",
        timestamp: 1,
        name: "review",
        intent: "Review the diff",
      },
      {
        type: "workflow.progress",
        blockId: "wf-1",
        timestamp: 2,
        activity: { kind: "phase", text: "Find" },
      },
      {
        type: "workflow.completed",
        blockId: "wf-1",
        timestamp: 3,
        outcome: "completed",
        result: "3 findings",
      },
    ];

    for (const event of events) {
      expect(
        chatSubscribeV13.serverFrameSchema.safeParse({
          kind: "blockDelta",
          hasBinaryPayload: false,
          epicId: "epic-1",
          chatId: "chat-1",
          event,
        }).success,
      ).toBe(false);
    }
  });

  it("chat.subscribe@1.2 is pinned to the same frozen pre-workflow shape as 1.3", () => {
    expect(
      chatSubscribeV12.serverFrameSchema.safeParse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "workflow.started",
          blockId: "wf-1",
          timestamp: 1,
          name: "review",
          intent: "Review the diff",
        },
      }).success,
    ).toBe(false);
  });
});

describe("chat.subscribe@1.4 server frames", () => {
  it("declares schemaVersion 1.4", () => {
    expect(chatSubscribeV14.schemaVersion).toEqual({ major: 1, minor: 4 });
  });

  it("parses a workflow background item on snapshot and turn-state frames", () => {
    const workflowItem = {
      taskId: "wf-task-1",
      kind: "workflow",
      title: "review",
      blockId: "wf-task-1",
      parentTaskId: null,
      phase: "Find",
      activeLabel: "find:host-core",
      agentsStarted: 16,
      agentsFinished: 3,
    };

    const snapshot = chatSubscribeV14.serverFrameSchema.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat,
        access: { role: "owner", ownerUserId: "user-1", canAct: true },
        queue: { status: "idle", items: [] },
        activeTurn: null,
        runStatus: "idle",
        pendingApprovals: [],
        pendingInterviews: [],
        pendingFileEditApprovals: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        accumulatedFileChanges: [],
        backgroundItems: [workflowItem],
      },
    });
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      snapshot: { backgroundItems: [workflowItem] },
    });

    const turnState = chatSubscribeV14.serverFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: null,
      backgroundItems: [workflowItem],
    });
    expect(turnState).toMatchObject({
      kind: "turnStateChanged",
      backgroundItems: [workflowItem],
    });
  });

  it("defaults new workflow background-item metadata when parsing an old-host frame", () => {
    const parsed = chatSubscribeV14.serverFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: null,
      backgroundItems: [
        {
          taskId: "wf-task-1",
          kind: "workflow",
          title: "review",
          blockId: "wf-task-1",
        },
      ],
    });

    expect(parsed).toMatchObject({
      kind: "turnStateChanged",
      backgroundItems: [
        {
          taskId: "wf-task-1",
          parentTaskId: null,
          phase: null,
          activeLabel: null,
          agentsStarted: null,
          agentsFinished: null,
        },
      ],
    });
  });

  it("round-trips workflow.started / workflow.progress / workflow.completed blockDelta events", () => {
    expect(
      chatSubscribeV14.serverFrameSchema.parse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "workflow.started",
          blockId: "wf-1",
          timestamp: 1,
          name: "review",
          intent: "Review the diff",
          spawnToolCallId: "toolu_workflow_1",
        },
      }),
    ).toMatchObject({ kind: "blockDelta" });

    expect(
      chatSubscribeV14.serverFrameSchema.parse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "workflow.progress",
          blockId: "wf-1",
          timestamp: 2,
          activity: { kind: "label", text: "find:host-core" },
          agentsStarted: 16,
          agentsFinished: 3,
          totalTokens: 120000,
        },
      }),
    ).toMatchObject({ kind: "blockDelta" });

    expect(
      chatSubscribeV14.serverFrameSchema.parse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "workflow.completed",
          blockId: "wf-1",
          timestamp: 3,
          outcome: "completed",
          result: "3 findings",
        },
      }),
    ).toMatchObject({ kind: "blockDelta" });
  });
});
